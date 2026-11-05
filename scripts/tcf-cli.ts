/*
 * A TCF client for trying commands on a running agent, built on the
 * extension's TcfChannel. Usage: see usage() below and ../.github/skills/tcf/SKILL.md.
 */
import * as fs from "node:fs";
import * as repl from "node:repl";
import { TcfChannel, stringifyJson } from "../src/tcf/channel";
import { toBigInt } from "../src/tcf/json";
import { BreakpointsService } from "../src/tcf/services/breakpoints";
import { CommandLineService } from "../src/tcf/services/commandLine";
import { DisassemblyService } from "../src/tcf/services/disassembly";
import { ExpressionsService } from "../src/tcf/services/expressions";
import { LineNumbersService } from "../src/tcf/services/lineNumbers";
import { MemoryService } from "../src/tcf/services/memory";
import { MemoryMapService } from "../src/tcf/services/memoryMap";
import { PathMapService } from "../src/tcf/services/pathMap";
import { RegistersService } from "../src/tcf/services/registers";
import { RunControlService } from "../src/tcf/services/runControl";
import { StackTraceService } from "../src/tcf/services/stackTrace";
import { SymbolsService } from "../src/tcf/services/symbols";

function usage(): string {
    return `Usage: npm run -s compile:tcf-cli -- [options] [-e CODE | FILE]

Connects to a TCF agent. With -e or FILE, runs the JavaScript as the body of
an async function and exits; otherwise starts a REPL (top-level await works).
Type help() in either for the helpers.

Options:
  --host HOST     agent host (default localhost)
  --port PORT     agent port (default 1534)
  --timeout MS    timeout of commands and waitEvent (default 10000)
  --trace         print all TCF messages, like "traceTcf"
  -e CODE         run CODE
  FILE            run the JavaScript in FILE`;
}

const HELP = `Commands
  cmd(service, command, ...args)  reply after the error report: one field as is,
                                  several as an array; throws on error or N
  raw(service, command, ...args)  all reply fields unchecked (Memory.get, ...)
  services()                      services in the agent's Locator.Hello
Service wrappers of the extension
  rc bp mem mmap regs st expr sym lines pmap dis cl
Contexts
  contexts(service="RunControl", filter?, root="")  all contexts, depth first
  tree(service="RunControl", root="")               print the context tree
Events (recorded from connecting on)
  events(service?, event?)      recorded events {seq, time, service, event, args}
  clearEvents()                 forget recorded events
  mark()                        sequence number of the last event
  waitEvent(service, event?, timeoutMs?, after=mark())
                                first matching event after 'after', or the next one
  live(on=true)                 print events as they arrive
Output
  print(...values)  JSON with 64-bit integers as numbers   hex(n)  "0x..." string
  trace(on=true)    print all TCF messages                 close() disconnect
Addresses are bigint: write 0x1000n.`;

interface Options {
    host: string;
    port: number;
    timeout: number;
    trace: boolean;
    code?: string;
    file?: string;
}

interface RecordedEvent {
    seq: number;
    time: string;
    service: string;
    event: string;
    args: unknown[];
}

type Context = Record<string, unknown> & { ID: string };

// At least this many of the latest events are kept; old ones are dropped in bulk.
const MAX_EVENTS = 10000;

function parseArgs(argv: string[]): Options {
    const o: Options = { host: "localhost", port: 1534, timeout: 10000, trace: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined) {
                throw new Error(`${arg} needs a value`);
            }
            return v;
        };
        switch (arg) {
            case "--host":
                o.host = value();
                break;
            case "--port": {
                const v = value();
                const port = Number(v);
                if (!Number.isFinite(port) || !Number.isInteger(port) || port < 1 || port > 65535) {
                    throw new Error(`Invalid value for ${arg}: '${v}'. Expected an integer between 1 and 65535.`);
                }
                o.port = port;
                break;
            }
            case "--timeout": {
                const v = value();
                const timeout = Number(v);
                if (!Number.isFinite(timeout)) {
                    throw new Error(`Invalid value for ${arg}: '${v}'. Expected a finite number (milliseconds).`);
                }
                o.timeout = timeout;
                break;
            }
            case "--trace":
                o.trace = true;
                break;
            case "-e":
                o.code = value();
                break;
            case "-h":
            case "--help":
                console.log(usage());
                process.exit(0);
                break;
            default:
                if (arg.startsWith("-") || o.file !== undefined) {
                    throw new Error(`Unknown argument '${arg}'\n\n${usage()}`);
                }
                o.file = arg;
        }
    }
    return o;
}

/** Indented JSON, with bigint written as plain numbers. */
function toJson(value: unknown): string {
    const json = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `\u0000bigint:${v}` : v), 2);
    return json === undefined ? String(value) : json.replace(/"\\u0000bigint:(-?\d+)"/g, "$1");
}

function print(...values: unknown[]): void {
    console.log(values.map((v) => (typeof v === "string" ? v : toJson(v))).join(" "));
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what}: no reply within ${ms} ms`)), ms);
        promise.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (err: unknown) => {
                clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
            },
        );
    });
}

function makeHelpers(channel: TcfChannel, o: Options, setTrace: (on: boolean) => void) {
    const recorded: RecordedEvent[] = [];
    const waiters = new Set<(e: RecordedEvent) => void>();
    let seq = 0;
    let liveEvents = false;

    channel.onAnyEvent((service, event, args) => {
        const e = { seq: ++seq, time: new Date().toISOString().slice(11, 23), service, event, args };
        recorded.push(e);
        if (recorded.length >= 2 * MAX_EVENTS) {
            recorded.splice(0, recorded.length - MAX_EVENTS);
        }
        if (liveEvents) {
            console.log(
                `[event ${e.seq} ${e.time}] ${service} ${event} ${args.map((a) => stringifyJson(a)).join(" ")}`,
            );
        }
        for (const w of [...waiters]) {
            w(e);
        }
    });

    const matches = (e: RecordedEvent, service?: string, event?: string) =>
        (service === undefined || e.service === service) && (event === undefined || e.event === event);

    const cmd = async (service: string, command: string, ...args: unknown[]): Promise<unknown> => {
        const rest = await withTimeout(channel.command(service, command, ...args), o.timeout, `${service}.${command}`);
        return rest.length === 1 ? rest[0] : rest;
    };

    const contexts = async (
        service = "RunControl",
        filter?: (ctx: Context) => boolean,
        root = "",
    ): Promise<Context[]> => {
        const result: Context[] = [];
        const walk = async (parent: string): Promise<void> => {
            const ids = await cmd(service, "getChildren", parent);
            for (const id of Array.isArray(ids) ? (ids as string[]) : []) {
                const ctx = (await cmd(service, "getContext", id)) as Context;
                if (!filter || filter(ctx)) {
                    result.push(ctx);
                }
                await walk(id);
            }
        };
        await walk(root);
        return result;
    };

    return {
        channel,
        cmd,
        raw: (service: string, command: string, ...args: unknown[]) =>
            withTimeout(channel.sendCommand(service, command, args), o.timeout, `${service}.${command}`),
        services: () => [...channel.remoteServices],
        rc: new RunControlService(channel),
        bp: new BreakpointsService(channel),
        mem: new MemoryService(channel),
        mmap: new MemoryMapService(channel),
        regs: new RegistersService(channel),
        st: new StackTraceService(channel),
        expr: new ExpressionsService(channel),
        sym: new SymbolsService(channel),
        lines: new LineNumbersService(channel),
        pmap: new PathMapService(channel),
        dis: new DisassemblyService(channel),
        cl: new CommandLineService(channel),
        contexts,
        tree: async (service = "RunControl", root = ""): Promise<void> => {
            const walk = async (parent: string, indent: string): Promise<void> => {
                const ids = await cmd(service, "getChildren", parent);
                for (const id of Array.isArray(ids) ? (ids as string[]) : []) {
                    const ctx = (await cmd(service, "getContext", id)) as Context;
                    const flags = ["HasState", "IsContainer"].filter((k) => ctx[k] === true).join(" ");
                    const name = typeof ctx.Name === "string" && ctx.Name !== id ? ` "${ctx.Name}"` : "";
                    console.log(`${indent}${id}${name}${flags ? ` [${flags}]` : ""}`);
                    await walk(id, `${indent}  `);
                }
            };
            await walk(root, "");
        },
        events: (service?: string, event?: string) => recorded.filter((e) => matches(e, service, event)),
        clearEvents: () => {
            recorded.length = 0;
        },
        mark: () => seq,
        waitEvent: (service: string, event?: string, timeoutMs = o.timeout, after = seq): Promise<RecordedEvent> => {
            const found = recorded.find((e) => e.seq > after && matches(e, service, event));
            if (found) {
                return Promise.resolve(found);
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    waiters.delete(waiter);
                    reject(new Error(`No ${service} ${event ?? "event"} within ${timeoutMs} ms`));
                }, timeoutMs);
                const waiter = (e: RecordedEvent) => {
                    if (matches(e, service, event)) {
                        clearTimeout(timer);
                        waiters.delete(waiter);
                        resolve(e);
                    }
                };
                waiters.add(waiter);
            });
        },
        live: (on = true) => {
            liveEvents = on;
        },
        trace: (on = true) => setTrace(on),
        print,
        hex: (n: unknown) => {
            const b = toBigInt(n);
            return b === undefined ? String(n) : `0x${b.toString(16)}`;
        },
        help: () => console.log(HELP),
        close: () => channel.close(),
    };
}

async function main(): Promise<void> {
    const o = parseArgs(process.argv.slice(2));
    const code = o.code ?? (o.file !== undefined ? fs.readFileSync(o.file, "utf8") : undefined);
    let tracing = o.trace;
    const channel = new TcfChannel((dir, text) => {
        if (tracing) {
            console.log(`TCF ${dir} ${text}`);
        }
    });
    channel.on("error", (err: Error) => console.error(`TCF error: ${err.message}`));
    await channel.connect(o.host, o.port, o.timeout);
    const helpers = makeHelpers(channel, o, (on) => {
        tracing = on;
    });

    if (code !== undefined) {
        const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
            ...args: string[]
        ) => (...values: unknown[]) => Promise<unknown>;
        const names = Object.keys(helpers);
        try {
            const result = await new AsyncFunction(...names, code)(...Object.values(helpers));
            if (result !== undefined) {
                print(result);
            }
        } finally {
            channel.close();
        }
        return;
    }

    console.log(`Connected to ${o.host}:${o.port}. Services: ${channel.remoteServices.join(" ")}`);
    console.log("Type help() for the helpers, .exit to quit.");
    const server = repl.start({ prompt: "tcf> " });
    Object.assign(server.context, helpers);
    let exiting = false;
    channel.on("close", () => {
        if (!exiting) {
            console.log("\nThe agent closed the connection.");
            server.close();
        }
    });
    await new Promise<void>((resolve) => server.on("exit", resolve));
    exiting = true;
    channel.close();
}

main().then(
    () => process.exit(process.exitCode ?? 0),
    (err: unknown) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    },
);
