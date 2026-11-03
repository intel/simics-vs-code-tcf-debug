import * as net from "net";
import { EventEmitter } from "events";
import { parseJson } from "./json";

/*
 * TCF channel over TCP, see "TCF Specification" -> "Transport Layer" and
 * "Communication Protocol".
 *
 * A message is a sequence of zero-terminated fields followed by an EOM marker.
 * The TCP transport escapes bytes using ESC (3):
 *   ESC 0 -> literal 3
 *   ESC 1 -> end of message (EOM)
 *   ESC 2 -> end of stream (EOS)
 *   ESC 3 -> binary block (only used when the peer has announced ZeroCopy,
 *            which this client never does, so binary data is always base64)
 */

const ESC = 3;
const EOM = Buffer.from([ESC, 1]);
const EOS = Buffer.from([ESC, 2]);

export class TcfError extends Error {
    constructor(
        message: string,
        readonly code?: number,
        readonly data?: unknown,
        readonly unsupported = false,
    ) {
        super(message);
        this.name = "TcfError";
    }
}

/** A command (C) and its results (R, P, N), matched by token; an event (E); flow control (F). */
export type TraceMessageType = "command" | "event" | "flowControl";

/** What a traced message is about. Results get the service and name of the command they answer. */
export interface TraceMessage {
    type?: TraceMessageType;
    service?: string;
    /** The command or event name. */
    name?: string;
}

export type TraceFn = (direction: "->" | "<-", text: string, message: TraceMessage) => void;

interface PendingCommand {
    service: string;
    command: string;
    resolve: (args: unknown[]) => void;
    reject: (err: Error) => void;
}

export type EventListener = (args: unknown[]) => void;

/** Formats a TCF error report object (or legacy error value) into a message. */
export function formatTcfError(err: unknown): string {
    if (err === null || err === undefined) {
        return "unknown error";
    }
    if (typeof err === "string") {
        return err;
    }
    if (typeof err === "object") {
        const e = err as Record<string, unknown>;
        let fmt = typeof e.Format === "string" ? e.Format : undefined;
        if (fmt !== undefined && Array.isArray(e.Params)) {
            const params = e.Params as unknown[];
            fmt = fmt.replace(/\{(\d+)\}/g, (m, i) =>
                params[Number(i)] !== undefined ? String(params[Number(i)]) : m,
            );
        }
        if (fmt) {
            return fmt;
        }
        if (e.Code !== undefined) {
            return `error code ${String(e.Code)}`;
        }
    }
    return stringifyJson(err);
}

/**
 * Serializes a value as JSON. bigint values (64-bit addresses) are written as
 * plain JSON numbers without losing precision.
 */
export function stringifyJson(value: unknown): string {
    const json = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${BIGINT_MARKER}${v.toString()}` : v));
    return json === undefined ? "null" : json.replace(BIGINT_PATTERN, "$1");
}

// JSON.stringify escapes U+0000, so the marker cannot clash with real string content.
const BIGINT_MARKER = "\u0000bigint:";
const BIGINT_PATTERN = /"\\u0000bigint:(-?\d+)"/g;

/** Encodes a message: each field zero-terminated and escaped, then EOM. */
export function encodeMessage(fields: string[]): Buffer {
    const parts: Buffer[] = [];
    for (const f of fields) {
        parts.push(escapeBytes(Buffer.from(f, "utf8")), Buffer.from([0]));
    }
    parts.push(EOM);
    return Buffer.concat(parts);
}

export interface MessageHandler {
    message(fields: string[]): void;
    endOfStream(): void;
    error(err: Error): void;
}

/** Splits the received byte stream into messages. Data may arrive in any chunks. */
export class MessageReader {
    private fields: Buffer[] = [];
    private parts: Buffer[] = [];
    private escPending = false;

    constructor(private readonly handler: MessageHandler) {}

    push(data: Buffer): void {
        let start = 0;
        let i = 0;
        const flushPart = (end: number) => {
            if (end > start) {
                // Copy, the socket may reuse its buffer before the field ends.
                this.parts.push(Buffer.from(data.subarray(start, end)));
            }
        };
        while (i < data.length) {
            const b = data[i];
            if (this.escPending) {
                this.escPending = false;
                i++;
                start = i;
                if (b === 0) {
                    this.parts.push(Buffer.from([ESC]));
                } else if (b === 1) {
                    this.finishMessage();
                } else if (b === 2) {
                    this.handler.endOfStream();
                    return;
                } else {
                    this.handler.error(new Error(`Unsupported TCF escape sequence ESC ${b}`));
                }
            } else if (b === ESC) {
                flushPart(i);
                this.escPending = true;
                i++;
                start = i;
            } else if (b === 0) {
                flushPart(i);
                this.fields.push(Buffer.concat(this.parts));
                this.parts = [];
                i++;
                start = i;
            } else {
                i++;
            }
        }
        flushPart(data.length);
    }

    private finishMessage(): void {
        const fields = this.fields.map((f) => f.toString("utf8"));
        this.fields = [];
        this.parts = [];
        if (fields.length > 0) {
            this.handler.message(fields);
        }
    }
}

export class TcfChannel extends EventEmitter {
    private socket: net.Socket | undefined;
    private readonly reader = new MessageReader({
        message: (fields) => this.onMessage(fields),
        endOfStream: () => this.close(),
        error: (err) => this.emitError(err),
    });
    private nextToken = 1;
    private readonly pending = new Map<string, PendingCommand>();
    private readonly eventListeners = new Map<string, Set<EventListener>>();
    private peerServices: string[] = [];
    private closed = false;

    constructor(private readonly trace?: TraceFn) {
        super();
    }

    get remoteServices(): readonly string[] {
        return this.peerServices;
    }

    hasService(name: string): boolean {
        return this.peerServices.includes(name);
    }

    get isOpen(): boolean {
        return !this.closed && this.socket !== undefined;
    }

    /**
     * Connects to the agent, sends our Locator.Hello and resolves once the
     * agent's Hello (with its service list) has been received. Commands must
     * not be sent before that.
     */
    connect(host: string, port: number, timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (err?: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (err) {
                    this.socket?.destroy();
                    reject(err);
                } else {
                    resolve();
                }
            };
            const timer = setTimeout(
                () => settle(new Error(`Timed out connecting to TCF agent at ${host}:${port}`)),
                timeoutMs,
            );

            this.onEvent("Locator", "Hello", (args) => {
                this.peerServices = Array.isArray(args[0]) ? (args[0] as string[]) : [];
                settle();
            });

            const socket = net.createConnection({ host, port });
            this.socket = socket;
            socket.setNoDelay(true);
            socket.on("connect", () => {
                // We provide no services ourselves.
                this.sendRaw(["E", "Locator", "Hello", "[]"]);
            });
            socket.on("data", (data) => this.reader.push(data));
            socket.on("error", (err) => {
                settle(new Error(`Failed to communicate with TCF agent at ${host}:${port}: ${err.message}`));
                this.handleClose(err);
            });
            socket.on("close", () => {
                settle(new Error(`Connection to TCF agent at ${host}:${port} was closed`));
                this.handleClose();
            });
        });
    }

    close(): void {
        if (this.socket && !this.closed) {
            this.socket.end(EOS);
            this.socket.destroySoon?.();
        }
        this.handleClose();
    }

    /**
     * Sends a command and resolves with all reply arguments (the fields after
     * the token), parsed as JSON.
     */
    sendCommand(service: string, command: string, args: unknown[]): Promise<unknown[]> {
        if (!this.isOpen) {
            return Promise.reject(new Error("Not connected to a TCF agent"));
        }
        const token = String(this.nextToken++);
        return new Promise((resolve, reject) => {
            this.pending.set(token, { service, command, resolve, reject });
            this.sendRaw(["C", token, service, command, ...args.map(stringifyJson)]);
        });
    }

    /**
     * Sends a command whose reply starts with an error report, which is the
     * case for most TCF commands. Rejects with a TcfError if the error report
     * is non-null, otherwise resolves with the remaining reply arguments.
     */
    async command(service: string, command: string, ...args: unknown[]): Promise<unknown[]> {
        const reply = await this.sendCommand(service, command, args);
        if (reply.length > 0 && reply[0] !== null && reply[0] !== undefined) {
            const err = reply[0];
            const code =
                typeof (err as { Code?: unknown }).Code === "number" ? (err as { Code: number }).Code : undefined;
            throw new TcfError(`${service}.${command}: ${formatTcfError(err)}`, code, err);
        }
        return reply.slice(1);
    }

    /** Returns a function that removes the listener. */
    onEvent(service: string, event: string, listener: EventListener): () => void {
        const key = `${service}\0${event}`;
        let set = this.eventListeners.get(key);
        if (!set) {
            set = new Set();
            this.eventListeners.set(key, set);
        }
        set.add(listener);
        return () => set.delete(listener);
    }

    private sendRaw(fields: string[]): void {
        if (!this.socket || this.closed) {
            return;
        }
        this.trace?.("->", fields.join(" "), this.traceMessage(fields));
        this.socket.write(encodeMessage(fields));
    }

    private onMessage(fields: string[]): void {
        // Before dispatch, which removes the pending command of a reply.
        this.trace?.("<-", fields.join(" "), this.traceMessage(fields));
        try {
            this.dispatch(fields);
        } catch (err) {
            this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
    }

    private dispatch(fields: string[]): void {
        switch (fields[0]) {
            case "R": {
                const p = this.takePending(fields[1]);
                p?.resolve(fields.slice(2).map(parseField));
                break;
            }
            case "N": {
                const p = this.takePending(fields[1]);
                p?.reject(
                    new TcfError(
                        `Command ${p.service}.${p.command} is not supported by the agent`,
                        undefined,
                        undefined,
                        true,
                    ),
                );
                break;
            }
            case "E": {
                const listeners = this.eventListeners.get(`${fields[1]}\0${fields[2]}`);
                if (listeners) {
                    const args = fields.slice(3).map(parseField);
                    for (const l of listeners) {
                        try {
                            l(args);
                        } catch (err) {
                            this.emitError(err instanceof Error ? err : new Error(String(err)));
                        }
                    }
                }
                break;
            }
            default:
                // 'P' (progress) and 'F' (flow control) are ignored.
                break;
        }
    }

    private traceMessage(fields: string[]): TraceMessage {
        switch (fields[0]) {
            case "C":
                return { type: "command", service: fields[2], name: fields[3] };
            case "E":
                return { type: "event", service: fields[1], name: fields[2] };
            case "F":
                return { type: "flowControl" };
            case "R":
            case "P":
            case "N": {
                const p = this.pending.get(fields[1]);
                return p ? { type: "command", service: p.service, name: p.command } : { type: "command" };
            }
            default:
                return {};
        }
    }

    private takePending(token: string): PendingCommand | undefined {
        const p = this.pending.get(token);
        this.pending.delete(token);
        return p;
    }

    private emitError(err: Error): void {
        if (this.listenerCount("error") > 0) {
            this.emit("error", err);
        }
    }

    private handleClose(err?: Error): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const reason = new Error(err ? `TCF channel closed: ${err.message}` : "TCF channel closed");
        for (const p of this.pending.values()) {
            p.reject(reason);
        }
        this.pending.clear();
        this.emit("close", err);
    }
}

function escapeBytes(data: Buffer): Buffer {
    if (!data.includes(ESC)) {
        return data;
    }
    const out: number[] = [];
    for (const b of data) {
        out.push(b);
        if (b === ESC) {
            out.push(0);
        }
    }
    return Buffer.from(out);
}

function parseField(text: string): unknown {
    if (text.length === 0) {
        return undefined;
    }
    try {
        return parseJson(text);
    } catch {
        return text;
    }
}
