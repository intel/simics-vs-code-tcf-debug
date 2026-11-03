import { TcfChannel, TcfError, formatTcfError } from "./tcf/channel";
import {
    CommandLineError,
    CommandLineKey as Key,
    CommandLineModifier as Mod,
    CommandLineService,
} from "./tcf/services/commandLine";
import { RunControlService } from "./tcf/services/runControl";

/*
 * The Simics command line in a terminal, through the agent's CommandLine
 * service. Free of vscode imports so that it can be unit tested; the
 * Pseudoterminal is in simicsConsoleManager.ts. Simics's own VT frontend,
 * core/src/core/common/terminal_frontend.py, does the same job.
 */

export interface KeyPress {
    mod: number;
    key: number;
}

/** TCF standard error code, sent when suspending a stopped simulation. */
const TCF_ERROR_ALREADY_STOPPED = 10;

const CTRL_KEYS_ABOVE_Z = ["\\", "]", "^", "_"];

/** xterm's "<n>~" key numbers. */
const TILDE_KEYS: Record<number, number> = {
    1: Key.Home,
    2: Key.Insert,
    3: Key.Delete,
    4: Key.End,
    5: Key.PageUp,
    6: Key.PageDown,
    7: Key.Home,
    8: Key.End,
    11: Key.F1,
    12: Key.F1 + 1,
    13: Key.F1 + 2,
    14: Key.F1 + 3,
    15: Key.F1 + 4,
    17: Key.F1 + 5,
    18: Key.F1 + 6,
    19: Key.F1 + 7,
    20: Key.F1 + 8,
    21: Key.F1 + 9,
    23: Key.F1 + 10,
    24: Key.F1 + 11,
};

/** Final bytes of "ESC [" and "ESC O" sequences without a number. */
const LETTER_KEYS: Record<string, number> = {
    A: Key.Up,
    B: Key.Down,
    C: Key.Right,
    D: Key.Left,
    H: Key.Home,
    F: Key.End,
    P: Key.F1,
    Q: Key.F1 + 1,
    R: Key.F1 + 2,
    S: Key.F1 + 3,
};

/**
 * Turns what xterm sends for typed keys into CommandLine key presses. Ctrl+D
 * is dropped, Simics would close the console on an empty line.
 */
export function decodeInput(data: string): KeyPress[] {
    const bytes = Buffer.from(data, "utf8");
    const keys: KeyPress[] = [];
    let i = 0;
    while (i < bytes.length) {
        if (bytes[i] === 0x1b) {
            i = decodeEscape(bytes, i + 1, keys);
        } else {
            pushPlainKey(keys, bytes[i], Mod.None);
            i++;
        }
    }
    return keys;
}

function pushPlainKey(keys: KeyPress[], b: number, mod: number): void {
    if (b === 0x7f) {
        keys.push({ mod, key: Key.Backspace });
    } else if (b === 0x0d || b === 0x0a) {
        keys.push({ mod, key: Key.Return });
    } else if (b === 0x09) {
        keys.push({ mod, key: Key.Tab });
    } else if (b === 0x00 || (b === 0x04 && mod === Mod.None)) {
        // Ctrl+Space and Ctrl+D.
    } else if (b <= 0x1a) {
        keys.push({ mod: mod | Mod.Ctrl, key: 0x60 + b });
    } else if (b >= 0x1c && b <= 0x1f) {
        const ch = CTRL_KEYS_ABOVE_Z[b - 0x1c];
        keys.push({ mod: mod | Mod.Ctrl, key: ch.charCodeAt(0) });
    } else if (b !== 0x1b) {
        keys.push({ mod, key: b });
    }
}

/** Decodes the sequence after an ESC at `start`, returns where the next key starts. */
function decodeEscape(bytes: Buffer, start: number, keys: KeyPress[]): number {
    if (start >= bytes.length || bytes[start] === 0x1b) {
        // A lone Escape key, Simics has no key code for it.
        return start;
    }
    const c = bytes[start];
    if (c === 0x5b && start + 1 < bytes.length) {
        let end = start + 1;
        while (end < bytes.length && bytes[end] >= 0x30 && bytes[end] <= 0x3f) {
            end++;
        }
        if (end < bytes.length && bytes[end] >= 0x40 && bytes[end] <= 0x7e) {
            const params = bytes.subarray(start + 1, end).toString("latin1");
            const key = csiKey(params, String.fromCharCode(bytes[end]));
            if (key) {
                keys.push(key);
            }
            return end + 1;
        }
    }
    if (c === 0x4f && start + 1 < bytes.length) {
        const final = String.fromCharCode(bytes[start + 1]);
        const key = final === "M" ? Key.Return : LETTER_KEYS[final];
        if (key !== undefined) {
            keys.push({ mod: Mod.None, key });
        }
        return start + 2;
    }
    if (c < 0x80) {
        pushPlainKey(keys, c, Mod.Alt);
        return start + 1;
    }
    return start;
}

function csiKey(params: string, final: string): KeyPress | undefined {
    if (!/^[0-9;]*$/.test(params)) {
        return undefined;
    }
    const [first, modifier] = params.split(";").map((p) => Number(p) || 0);
    const mod = xtermModifier(modifier ?? 0);
    if (final === "~") {
        const key = TILDE_KEYS[first];
        return key === undefined ? undefined : { mod, key };
    }
    if (final === "Z") {
        return { mod: mod | Mod.Shift, key: Key.Tab };
    }
    const key = LETTER_KEYS[final];
    return key === undefined ? undefined : { mod, key };
}

/** xterm sends 1 + (1 Shift, 2 Alt, 4 Ctrl); the service has other bits. */
function xtermModifier(m: number): number {
    const bits = Math.max(0, m - 1);
    return (bits & 1 ? Mod.Shift : 0) | (bits & 2 ? Mod.Alt : 0) | (bits & 4 ? Mod.Ctrl : 0);
}

/** VT codes for the markup tags, as tag_strings in terminal_frontend.py. */
const TAG_CODES: Record<string, string> = {
    b: "\x1b[1m",
    i: "\x1b[3m",
    prompt: "\x1b[1m\x1b[34m",
    select: "\x1b[7m\x1b[34m",
};
const RESET = "\x1b[0m";
const CSI_PATTERN = /^\[[0-?]*[ -/]*[@-~]/;

/**
 * Converts the CommandLine events to VT text and keeps track of the cursor
 * row and column, so that cursor moves work on wrapped lines. Rows count from
 * the row where the last prompt ended.
 */
export class ConsoleScreen {
    private width: number;
    private row = 0;
    private col = 0;
    private maxRow = 0;
    // A full row was written and the cursor moved to the next one.
    private wrapped = false;

    constructor(width = 80) {
        this.width = Math.max(1, width);
    }

    resize(width: number): void {
        const w = Math.max(1, width);
        const pos = this.row * this.width + this.col;
        const end = (this.maxRow + 1) * this.width - 1;
        this.width = w;
        this.row = Math.floor(pos / w);
        this.col = pos - this.row * w;
        this.maxRow = Math.max(this.row, Math.floor(end / w));
    }

    /** Text with markup tags and newlines. */
    write(text: string): string {
        let out = "";
        text.split("\n").forEach((line, i) => {
            if (i > 0) {
                if (!this.wrapped) {
                    out += "\r\n";
                }
                this.row = 0;
                this.col = 0;
                this.maxRow = 0;
                this.wrapped = false;
            }
            out += this.writeLine(line);
        });
        return out;
    }

    /** Deletes from the cursor to the end of the command line. */
    deleteLine(): string {
        this.maxRow = this.row;
        return "\x1b[J";
    }

    clearScreen(): string {
        this.row = 0;
        this.col = 0;
        this.maxRow = 0;
        this.wrapped = false;
        return "\x1b[2J\x1b[H";
    }

    cursorLeft(n: number): string {
        return this.move(-n);
    }

    cursorRight(n: number): string {
        return this.move(n);
    }

    private move(delta: number): string {
        const pos = this.row * this.width + this.col + delta;
        const row = Math.floor(pos / this.width);
        const col = pos - row * this.width;
        const up = this.row - row;
        let out = up > 0 ? `\x1b[${up}A` : up < 0 ? `\x1b[${-up}B` : "";
        out += `\x1b[${col + 1}G`;
        this.row = row;
        this.col = col;
        this.maxRow = Math.max(this.maxRow, row);
        this.wrapped = false;
        return out;
    }

    private writeLine(line: string): string {
        const [first, ...rest] = line.split("\x1b");
        let out = this.text(first);
        for (const part of rest) {
            const csi = CSI_PATTERN.exec(part);
            const gt = part.indexOf(">");
            if (csi) {
                out += "\x1b" + csi[0] + this.text(part.slice(csi[0].length));
            } else if (gt >= 0) {
                out += this.tag(part.slice(0, gt));
                out += this.text(part.slice(gt + 1));
            } else {
                out += "\x1b" + part;
            }
        }
        return out;
    }

    private tag(tag: string): string {
        const end = tag.startsWith("/");
        const name = end ? tag.slice(1) : tag;
        if (!(name in TAG_CODES)) {
            return "";
        }
        if (end && name === "prompt") {
            this.row = 0;
            this.maxRow = 0;
        }
        return end ? RESET : TAG_CODES[name];
    }

    private text(s: string): string {
        if (s.length === 0) {
            return "";
        }
        const length = this.col + [...s].length;
        this.row += Math.floor(length / this.width);
        this.col = length % this.width;
        this.maxRow = Math.max(this.maxRow, this.row);
        this.wrapped = this.col === 0;
        // xterm keeps the cursor in the last column until the next character.
        return this.wrapped ? s + "\r\n" : s;
    }
}

interface Cell {
    ch: string;
    style: string;
}

/**
 * The console's output as finished lines with SGR colours but no cursor
 * moves, so that it can be written again at any terminal width.
 */
export class ConsoleTranscript {
    readonly lines: string[] = [];
    private cells: Cell[] = [];
    private pos = 0;
    private style = "";

    constructor(private readonly maxLines = Infinity) {}

    /** The same text as ConsoleScreen.write. */
    write(text: string): void {
        text.split("\n").forEach((line, i) => {
            if (i > 0) {
                this.newLine();
            }
            const [first, ...rest] = line.split("\x1b");
            this.put(first);
            for (const part of rest) {
                const csi = CSI_PATTERN.exec(part);
                const gt = part.indexOf(">");
                if (csi) {
                    this.csi(csi[0]);
                    this.put(part.slice(csi[0].length));
                } else if (gt >= 0) {
                    this.tag(part.slice(0, gt));
                    this.put(part.slice(gt + 1));
                } else {
                    this.put(part);
                }
            }
        });
    }

    deleteLine(): void {
        this.cells.length = Math.min(this.cells.length, this.pos);
    }

    cursorLeft(n: number): void {
        this.pos = Math.max(0, this.pos - n);
    }

    cursorRight(n: number): void {
        this.pos += n;
    }

    /** Earlier lines stay, as in a terminal's scrollback. */
    clearScreen(): void {
        this.cells = [];
        this.pos = 0;
    }

    /** Forgets all output. */
    clear(): void {
        this.lines.length = 0;
        this.clearScreen();
    }

    /** The finished lines and the current one, if not empty. */
    snapshot(): string[] {
        return this.cells.length > 0 ? [...this.lines, render(this.cells)] : [...this.lines];
    }

    /** The current line, and how far the cursor is from its end. */
    currentLine(): { text: string; back: number } {
        return { text: render(this.cells), back: Math.max(0, this.cells.length - this.pos) };
    }

    private newLine(): void {
        this.lines.push(render(this.cells));
        if (this.lines.length > this.maxLines) {
            this.lines.splice(0, this.lines.length - this.maxLines);
        }
        this.cells = [];
        this.pos = 0;
    }

    private put(s: string): void {
        for (const ch of s) {
            if (ch === "\r") {
                this.pos = 0;
                continue;
            }
            while (this.cells.length < this.pos) {
                this.cells.push({ ch: " ", style: "" });
            }
            this.cells[this.pos++] = { ch, style: this.style };
        }
    }

    private csi(seq: string): void {
        if (seq.endsWith("m")) {
            const params = seq.slice(1, -1);
            this.style = params === "" || params === "0" ? "" : this.style + "\x1b" + seq;
        }
    }

    private tag(tag: string): void {
        const end = tag.startsWith("/");
        const name = end ? tag.slice(1) : tag;
        if (name in TAG_CODES) {
            this.style = end ? "" : this.style + TAG_CODES[name];
        }
    }
}

function render(cells: Cell[]): string {
    let out = "";
    let style = "";
    for (const c of cells) {
        if (c.style !== style) {
            out += (style ? RESET : "") + c.style;
            style = c.style;
        }
        out += c.ch;
    }
    return style ? out + RESET : out;
}

/** An earlier console session, as kept in the history. */
export interface ConsoleSession {
    lines: string[];
    /** When it ended, in milliseconds since the epoch. */
    ended: number;
}

/** The last `maxSessions` sessions, cut to `maxLines` lines in all, rules included. */
export function trimHistory(sessions: ConsoleSession[], maxSessions: number, maxLines: number): ConsoleSession[] {
    const out: ConsoleSession[] = [];
    let room = maxLines;
    const kept = maxSessions > 0 ? sessions.slice(-maxSessions) : [];
    for (let i = kept.length - 1; i >= 0 && room > 1; i--) {
        const lines = kept[i].lines.slice(Math.max(0, kept[i].lines.length - (room - 1)));
        room -= lines.length + 1;
        out.unshift({ lines, ended: kept[i].ended });
    }
    return out;
}

/** `line` without its colours, dim. */
export function grayed(line: string): string {
    const text = withoutColours(line);
    return text ? `\x1b[2m${text}${RESET}` : "";
}

function withoutColours(line: string): string {
    return line.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Only blank lines and bare prompts, such as `simics> `. */
export function isEmptySession(lines: string[]): boolean {
    return lines.every((line) => /^(\S*>)?$/.test(withoutColours(line).trim()));
}

/** The dim rule after each earlier session. */
export const SESSION_RULE = grayed("--- session ended ---");

/** Earlier sessions, grayed out and each followed by its rule, to write above a new session. */
export function historyText(sessions: ConsoleSession[]): string {
    return sessions
        .flatMap((s) => [...s.lines.map(grayed), SESSION_RULE])
        .map((line) => line + "\r\n")
        .join("");
}

export type ConsoleState = "connecting" | "connected" | "disconnected";

/** The parts of a TcfChannel the console uses. */
export type ConsoleChannel = Pick<TcfChannel, "isOpen" | "hasService" | "command" | "onEvent" | "on" | "off">;

/** Custom DAP event: the session's agent has a console. Its body is `{ open: boolean }`, whether to open it. */
export const CONSOLE_AVAILABLE_EVENT = "consoleAvailable";

/** The consoles.simicsCli launch attributes, with their defaults. */
export interface SimicsCliOptions {
    open: boolean;
    historySessions: number;
    editingKeys: boolean;
}

export function simicsCliOptions(config: unknown): SimicsCliOptions {
    const c = (config as { consoles?: { simicsCli?: Partial<Record<keyof SimicsCliOptions, unknown>> } } | undefined)
        ?.consoles?.simicsCli;
    const sessions = typeof c?.historySessions === "number" ? Math.floor(c.historySessions) : 3;
    return { open: c?.open !== false, historySessions: Math.max(0, sessions), editingKeys: c?.editingKeys !== false };
}

/** Where the console's output goes, normally a Pseudoterminal. */
export interface ConsoleHost {
    write(text: string): void;
    setClipboard(text: string): void;
    stateChanged(state: ConsoleState): void;
}

export class SimicsConsole {
    private currentState: ConsoleState = "connecting";
    private commandLine: CommandLineService | undefined;
    private removeListeners: (() => void) | undefined;
    private readonly channelClosed = () => this.disconnected();
    private readonly screen = new ConsoleScreen();
    readonly transcript: ConsoleTranscript;
    private ended: number | undefined;
    private size = { cols: 80, rows: 24 };
    private closed = false;

    /** `channel` belongs to the debug session; the console never closes it. */
    constructor(
        private readonly channel: ConsoleChannel,
        private readonly host: ConsoleHost,
        maxLines = Infinity,
        private history: ConsoleSession[] = [],
    ) {
        this.transcript = new ConsoleTranscript(maxLines);
    }

    get state(): ConsoleState {
        return this.currentState;
    }

    /** When the console was disconnected or closed, in milliseconds since the epoch. */
    get endedAt(): number | undefined {
        return this.ended;
    }

    async open(cols: number, rows: number): Promise<void> {
        this.size = { cols, rows };
        this.screen.resize(cols);
        this.output(historyText(this.history));
        const channel = this.channel;
        try {
            if (!channel.isOpen) {
                throw new Error("The debug session is no longer connected to the TCF agent");
            }
            if (!channel.hasService(CommandLineService.NAME)) {
                throw new Error("The TCF agent does not provide the CommandLine service");
            }
            channel.on("close", this.channelClosed);
            const commandLine = new CommandLineService(channel);
            this.removeListeners = commandLine.addListener({
                write: (t) => this.draw(t),
                deleteLine: () => {
                    this.transcript.deleteLine();
                    this.output(this.screen.deleteLine());
                },
                clearScreen: () => {
                    this.transcript.clearScreen();
                    this.output(this.screen.clearScreen());
                },
                cursorLeft: (n) => {
                    this.transcript.cursorLeft(n);
                    this.output(this.screen.cursorLeft(n));
                },
                cursorRight: (n) => {
                    this.transcript.cursorRight(n);
                    this.output(this.screen.cursorRight(n));
                },
                setClipboard: (t) => this.host.setClipboard(t),
                disconnected: () => this.disconnected(),
            });
            await commandLine.connect();
            if (this.closed) {
                commandLine.disconnect().catch(() => undefined);
                return;
            }
            this.commandLine = commandLine;
            this.setState("connected");
            await commandLine.sizeChanged(this.size.cols, this.size.rows);
        } catch (err) {
            if (!this.closed && this.currentState !== "disconnected") {
                this.message(errorMessage(err));
                this.disconnected();
            }
        }
    }

    input(data: string): void {
        const commandLine = this.commandLine;
        if (!commandLine || this.currentState !== "connected") {
            return;
        }
        for (const { mod, key } of decodeInput(data)) {
            commandLine.keyPressed(mod, key).catch((err: unknown) => this.commandFailed(err));
            if (mod === Mod.Ctrl && key === 0x63) {
                this.stopSimulation().catch((err: unknown) =>
                    this.message(`Could not stop the simulation: ${errorMessage(err)}`),
                );
            }
        }
    }

    resize(cols: number, rows: number): void {
        this.size = { cols, rows };
        this.screen.resize(cols);
        if (this.commandLine && this.currentState === "connected") {
            this.commandLine.sizeChanged(cols, rows).catch((err: unknown) => this.commandFailed(err));
        }
    }

    /** Clears the terminal, scrollback included, and draws the output again, grayed out once ended. */
    redraw(): void {
        const { text, back } = this.transcript.currentLine();
        const lines = [...this.transcript.lines, text];
        let out = this.screen.clearScreen() + "\x1b[3J" + historyText(this.history);
        if (this.ended !== undefined) {
            out += this.screen.write(lines.map(grayed).join("\n"));
        } else {
            out += this.screen.write(lines.join("\n"));
            if (back > 0) {
                out += this.screen.cursorLeft(back);
            }
        }
        this.output(out);
    }

    /** Forgets the earlier sessions, and this session's output too if `withThis`, and redraws. */
    clearHistory(withThis: boolean): void {
        this.history = [];
        if (withThis) {
            this.transcript.clear();
            this.output(this.screen.clearScreen() + "\x1b[3J");
        } else {
            this.redraw();
        }
    }

    /** The terminal was closed. */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const commandLine = this.commandLine;
        this.ended ??= Date.now();
        this.setState("disconnected");
        this.detach();
        commandLine?.disconnect().catch(() => undefined);
    }

    /** Ctrl+C is "copy" in the Simics command line, so stop it here. */
    private async stopSimulation(): Promise<void> {
        const channel = this.channel;
        if (!channel.hasService(RunControlService.NAME)) {
            return;
        }
        const runControl = new RunControlService(channel);
        const [id] = await runControl.getChildren(null);
        if (id === undefined) {
            return;
        }
        try {
            // The Simics agent stops the whole simulation for any context.
            await runControl.suspend(id);
        } catch (err) {
            if (!(err instanceof TcfError && err.code === TCF_ERROR_ALREADY_STOPPED)) {
                throw err;
            }
        }
    }

    private commandFailed(err: unknown): void {
        if (this.closed || this.currentState === "disconnected") {
            return;
        }
        if (err instanceof TcfError && err.code === CommandLineError.NotConnected) {
            this.disconnected();
        } else {
            this.message(errorMessage(err));
        }
    }

    private disconnected(): void {
        if (this.currentState === "disconnected") {
            return;
        }
        this.ended = Date.now();
        this.setState("disconnected");
        this.detach();
        if (!this.closed) {
            this.redraw();
        }
    }

    private detach(): void {
        this.commandLine = undefined;
        this.removeListeners?.();
        this.removeListeners = undefined;
        this.channel.off("close", this.channelClosed);
    }

    private message(text: string): void {
        this.draw(`\n\x1b[2m${text}\x1b[0m\n`);
    }

    private draw(text: string): void {
        this.transcript.write(text);
        this.output(this.screen.write(text));
    }

    private output(text: string): void {
        if (text.length > 0 && !this.closed) {
            this.host.write(text);
        }
    }

    private setState(state: ConsoleState): void {
        if (state !== this.currentState) {
            this.currentState = state;
            this.host.stateChanged(state);
        }
    }
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return formatTcfError(err);
}
