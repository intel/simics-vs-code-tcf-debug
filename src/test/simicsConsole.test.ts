import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import {
    ConsoleChannel,
    ConsoleScreen,
    ConsoleSession,
    ConsoleState,
    ConsoleTranscript,
    SimicsConsole,
    SESSION_RULE,
    decodeInput,
    historyText,
    isEmptySession,
    simicsCliOptions,
    trimHistory,
} from "../simicsConsole";
import { TcfError } from "../tcf/channel";

const SHIFT = 1;
const CTRL = 2;
const CLEAR = "\x1b[2J\x1b[H\x1b[3J";
const ALT = 4;

const key = (mod: number, k: number | string) => ({
    mod,
    key: typeof k === "string" ? k.charCodeAt(0) : k,
});

test("decodeInput: plain and control keys", () => {
    assert.deepEqual(decodeInput("ab"), [key(0, "a"), key(0, "b")]);
    assert.deepEqual(decodeInput("\r\n\t\x7f"), [key(0, 10), key(0, 10), key(0, 9), key(0, 8)]);
    assert.deepEqual(decodeInput("\x03\x01\x08\x1f"), [key(CTRL, "c"), key(CTRL, "a"), key(CTRL, "h"), key(CTRL, "_")]);
    // Ctrl+D would close the console, Ctrl+Space has no key code.
    assert.deepEqual(decodeInput("\x04\x00"), []);
    assert.deepEqual(decodeInput("€"), [key(0, 0xe2), key(0, 0x82), key(0, 0xac)]);
});

test("decodeInput: escape sequences", () => {
    const cases: [string, ReturnType<typeof key>[]][] = [
        ["\x1b[D", [key(0, 0)]],
        ["\x1b[C", [key(0, 1)]],
        ["\x1b[A", [key(0, 2)]],
        ["\x1b[B", [key(0, 3)]],
        ["\x1bOD", [key(0, 0)]],
        ["\x1b[5~", [key(0, 4)]],
        ["\x1b[6~", [key(0, 5)]],
        ["\x1b[H", [key(0, 6)]],
        ["\x1bOF", [key(0, 7)]],
        ["\x1b[1~", [key(0, 6)]],
        ["\x1b[4~", [key(0, 7)]],
        ["\x1b[3~", [key(0, 11)]],
        ["\x1b[2~", [key(0, 12)]],
        ["\x1bOP", [key(0, 13)]],
        ["\x1b[15~", [key(0, 17)]],
        ["\x1b[24~", [key(0, 24)]],
        ["\x1b[1;2D", [key(SHIFT, 0)]],
        ["\x1b[1;5C", [key(CTRL, 1)]],
        ["\x1b[1;6D", [key(SHIFT | CTRL, 0)]],
        ["\x1b[3;5~", [key(CTRL, 11)]],
        ["\x1b[Z", [key(SHIFT, 9)]],
        ["\x1bb", [key(ALT, "b")]],
        ["\x1b\x7f", [key(ALT, 8)]],
        ["\x1b", []],
        ["\x1b[200~", []],
        ["\x1b[Dx", [key(0, 0), key(0, "x")]],
    ];
    for (const [input, expected] of cases) {
        assert.deepEqual(decodeInput(input), expected, JSON.stringify(input));
    }
});

test("ConsoleScreen: markup tags become VT codes", () => {
    const screen = new ConsoleScreen(80);
    assert.equal(screen.write("\x1bprompt>simics> \x1b/prompt>"), "\x1b[1m\x1b[34msimics> \x1b[0m");
    assert.equal(screen.write("\x1bb>bold\x1b/b>"), "\x1b[1mbold\x1b[0m");
    assert.equal(screen.write("\x1bi>it\x1b/i>"), "\x1b[3mit\x1b[0m");
    assert.equal(screen.write("\x1bselect>s\x1b/select>"), "\x1b[7m\x1b[34ms\x1b[0m");
    assert.equal(screen.write("\x1bfoo>x\x1b/foo>"), "x");
    assert.equal(screen.write("\x1b[31mred\x1b[0m"), "\x1b[31mred\x1b[0m");
    assert.equal(screen.write("a\nb\n"), "a\r\nb\r\n");
});

test("ConsoleScreen: cursor moves across wrapped rows", () => {
    const screen = new ConsoleScreen(4);
    assert.equal(screen.write("abcdef"), "abcdef");
    assert.equal(screen.cursorLeft(4), "\x1b[1A\x1b[3G");
    assert.equal(screen.cursorRight(3), "\x1b[1B\x1b[2G");
    assert.equal(screen.cursorLeft(1), "\x1b[1G");
    assert.equal(screen.deleteLine(), "\x1b[J");
    assert.equal(screen.clearScreen(), "\x1b[2J\x1b[H");
});

test("ConsoleScreen: a full row moves the cursor to the next row", () => {
    const screen = new ConsoleScreen(4);
    assert.equal(screen.write("abcd"), "abcd\r\n");
    // The newline is already written.
    assert.equal(screen.write("\nx"), "x");
    assert.equal(screen.write("abc"), "abc\r\n");
    assert.equal(screen.cursorLeft(1), "\x1b[1A\x1b[4G");
});

test("ConsoleScreen: the prompt end starts the row count", () => {
    const screen = new ConsoleScreen(4);
    screen.write("output");
    screen.write("\x1bprompt>>\x1b/prompt>");
    assert.equal(screen.cursorLeft(1), "\x1b[3G");
});

test("ConsoleScreen: resize keeps the position in the line", () => {
    const screen = new ConsoleScreen(4);
    screen.write("abcdef");
    screen.resize(8);
    assert.equal(screen.cursorLeft(6), "\x1b[1G");
});

class FakeChannel extends EventEmitter {
    readonly commands: [string, string, unknown[]][] = [];
    readonly listeners_ = new Map<string, ((args: unknown[]) => void)[]>();
    services = ["CommandLine", "RunControl"];
    closed = false;
    handler: (service: string, command: string) => unknown[] = () => [];

    get isOpen(): boolean {
        return !this.closed;
    }

    hasService(name: string): boolean {
        return this.services.includes(name);
    }

    command(service: string, command: string, ...args: unknown[]): Promise<unknown[]> {
        this.commands.push([service, command, args]);
        try {
            return Promise.resolve(this.handler(service, command));
        } catch (err) {
            return Promise.reject(err);
        }
    }

    onEvent(service: string, event: string, l: (args: unknown[]) => void): () => void {
        const key = `${service}.${event}`;
        this.listeners_.set(key, [...(this.listeners_.get(key) ?? []), l]);
        return () => this.listeners_.set(key, this.listeners_.get(key)?.filter((x) => x !== l) ?? []);
    }

    listenerTotal(): number {
        return [...this.listeners_.values()].reduce((n, ls) => n + ls.length, 0) + this.listenerCount("close");
    }

    event(service: string, event: string, ...args: unknown[]): void {
        this.listeners_.get(`${service}.${event}`)?.forEach((l) => l(args));
    }

    close(): void {
        if (!this.closed) {
            this.closed = true;
            this.emit("close");
        }
    }

    names(): string[] {
        return this.commands.map(([s, c]) => `${s}.${c}`);
    }
}

function setup(history: ConsoleSession[] = []) {
    const channel = new FakeChannel();
    const output: string[] = [];
    const states: ConsoleState[] = [];
    const clipboard: string[] = [];
    const console_ = new SimicsConsole(
        channel as unknown as ConsoleChannel,
        {
            write: (t) => output.push(t),
            setClipboard: (t) => clipboard.push(t),
            stateChanged: (s) => states.push(s),
        },
        Infinity,
        history,
    );
    return { channel, output, states, clipboard, console: console_ };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("SimicsConsole: connects, sends keys and shows events", async () => {
    const { channel, output, states, clipboard, console: c } = setup();
    await c.open(100, 30);
    assert.deepEqual(channel.commands, [
        ["CommandLine", "connect", []],
        ["CommandLine", "sizeChanged", [100, 30]],
    ]);
    assert.deepEqual(states, ["connected"]);

    channel.event("CommandLine", "write", "\x1bprompt>simics> \x1b/prompt>");
    channel.event("CommandLine", "cursorLeft", 2);
    channel.event("CommandLine", "setClipboard", "abc");
    assert.deepEqual(output, ["\x1b[1m\x1b[34msimics> \x1b[0m", "\x1b[7G"]);
    assert.deepEqual(clipboard, ["abc"]);

    c.input("l\r\x04");
    c.resize(90, 20);
    assert.deepEqual(channel.commands.slice(2), [
        ["CommandLine", "keyPressed", [0, "l".charCodeAt(0)]],
        ["CommandLine", "keyPressed", [0, 10]],
        ["CommandLine", "sizeChanged", [90, 20]],
    ]);
});

test("SimicsConsole: Ctrl+C is sent and stops the simulation", async () => {
    const { channel, console: c } = setup();
    channel.handler = (service, command) => {
        if (command === "getChildren") {
            return [["machine"]];
        }
        if (command === "suspend") {
            throw new TcfError("already stopped", 10);
        }
        return [];
    };
    await c.open(80, 24);
    c.input("\x03");
    await settle();
    assert.deepEqual(channel.commands.slice(2), [
        ["CommandLine", "keyPressed", [CTRL, "c".charCodeAt(0)]],
        ["RunControl", "getChildren", [null]],
        ["RunControl", "suspend", ["machine"]],
    ]);
    assert.equal(c.state, "connected");
});

test('SimicsConsole: "Not connected" means disconnected', async () => {
    const { channel, output, states, console: c } = setup();
    await c.open(80, 24);
    channel.handler = () => {
        throw new TcfError("Not connected", 3);
    };
    c.input("x");
    await settle();
    assert.deepEqual(states, ["connected", "disconnected"]);
    assert.deepEqual(output, [CLEAR]);
    assert.equal(channel.closed, false);
    assert.equal(channel.listenerTotal(), 0);
    c.input("y");
    assert.equal(channel.commands.length, 3);
});

test("SimicsConsole: the disconnected event", async () => {
    const { channel, output, console: c } = setup();
    await c.open(80, 24);
    channel.event("CommandLine", "disconnected");
    assert.equal(c.state, "disconnected");
    assert.deepEqual(output, [CLEAR]);
});

test("SimicsConsole: an agent without the service", async () => {
    const { channel, output, console: c } = setup();
    channel.services = [];
    await c.open(80, 24);
    assert.equal(c.state, "disconnected");
    assert.match(output.join(""), /does not provide the CommandLine service/);
    assert.deepEqual(channel.commands, []);
});

test("SimicsConsole: closing the terminal disconnects", async () => {
    const { channel, output, console: c } = setup();
    await c.open(80, 24);
    c.close();
    await settle();
    assert.deepEqual(channel.names().slice(-1), ["CommandLine.disconnect"]);
    assert.equal(channel.closed, false);
    assert.equal(channel.listenerTotal(), 0);
    assert.doesNotMatch(output.join(""), /disconnected/);
});

test("SimicsConsole: the session's channel closes, and its output is grayed out", async () => {
    const { channel, output, console: c } = setup();
    await c.open(80, 24);
    channel.event("CommandLine", "write", "\x1bprompt>simics> \x1b/prompt>");
    channel.close();
    assert.equal(c.state, "disconnected");
    assert.equal(output[output.length - 1], `${CLEAR}\x1b[2msimics> \x1b[0m`);
    assert.equal(typeof c.endedAt, "number");
    assert.deepEqual(c.transcript.snapshot(), ["\x1b[1m\x1b[34msimics> \x1b[0m"]);
    c.input("x");
    assert.equal(channel.commands.length, 2);
});

const HISTORY = [{ lines: ["\x1b[1mold\x1b[0m", ""], ended: 1 }];
const GRAY_HISTORY = "\x1b[2mold\x1b[0m\r\n\r\n\x1b[2m--- session ended ---\x1b[0m\r\n";

test("SimicsConsole: redraw shows the grayed-out history and this session's output", async () => {
    const { channel, output, console: c } = setup(HISTORY);
    await c.open(80, 24);
    assert.equal(output[0], GRAY_HISTORY);
    channel.event("CommandLine", "write", "out\nsimics> ab");
    channel.event("CommandLine", "cursorLeft", 1);
    c.redraw();
    assert.equal(output[output.length - 1], `${CLEAR}${GRAY_HISTORY}out\r\nsimics> ab\x1b[10G`);
});

test("SimicsConsole: clearHistory keeps a live session", async () => {
    const { channel, output, console: c } = setup(HISTORY);
    await c.open(80, 24);
    channel.event("CommandLine", "write", "simics> ");
    c.clearHistory(false);
    assert.equal(output[output.length - 1], `${CLEAR}simics> `);
});

test("SimicsConsole: clearHistory with this session empties the console", async () => {
    const { channel, output, console: c } = setup(HISTORY);
    await c.open(80, 24);
    channel.event("CommandLine", "write", "out\nsimics> ");
    channel.close();
    c.clearHistory(true);
    assert.equal(output[output.length - 1], CLEAR);
    assert.deepEqual(c.transcript.snapshot(), []);
});

test("SimicsConsole: a closed channel", async () => {
    const { channel, output, console: c } = setup();
    channel.closed = true;
    await c.open(80, 24);
    assert.equal(c.state, "disconnected");
    assert.match(output.join(""), /no longer connected/);
    assert.deepEqual(channel.commands, []);
});

test("ConsoleTranscript: finished lines with colours, without cursor moves", () => {
    const t = new ConsoleTranscript();
    t.write("\x1bprompt>simics> \x1b/prompt>lx");
    t.cursorLeft(1);
    t.write("sx");
    t.cursorLeft(1);
    t.write("\nout\n\x1b[1mbold\x1b[0m\n");
    t.write("abc");
    t.cursorLeft(2);
    t.deleteLine();
    t.write("\rxy");
    t.cursorRight(2);
    t.write("z");
    assert.deepEqual(t.snapshot(), ["\x1b[1m\x1b[34msimics> \x1b[0mlsx", "out", "\x1b[1mbold\x1b[0m", "xy  z"]);
    assert.deepEqual(t.currentLine(), { text: "xy  z", back: 0 });
});

test("ConsoleTranscript: keeps at most maxLines lines", () => {
    const t = new ConsoleTranscript(2);
    t.write("1\n2\n3\n");
    assert.deepEqual(t.snapshot(), ["2", "3"]);
});

test("trimHistory keeps the last sessions and lines", () => {
    const sessions = [
        { lines: ["a"], ended: 1 },
        { lines: ["b", "c"], ended: 2 },
        { lines: ["d", "e", "f"], ended: 3 },
    ];
    assert.deepEqual(trimHistory(sessions, 2, 100), sessions.slice(1));
    assert.deepEqual(trimHistory(sessions, 0, 100), []);
    // Each session also takes a line for its rule.
    assert.deepEqual(trimHistory(sessions, 3, 6), [
        { lines: ["c"], ended: 2 },
        { lines: ["d", "e", "f"], ended: 3 },
    ]);
    assert.deepEqual(trimHistory(sessions, 3, 5), [{ lines: ["d", "e", "f"], ended: 3 }]);
});

test("simicsCliOptions reads consoles.simicsCli, with defaults", () => {
    const defaults = { open: true, historySessions: 3, editingKeys: true };
    assert.deepEqual(simicsCliOptions({}), defaults);
    assert.deepEqual(simicsCliOptions({ consoles: "x" }), defaults);
    assert.deepEqual(
        simicsCliOptions({ consoles: { simicsCli: { open: false, historySessions: 2.5, editingKeys: false } } }),
        { open: false, historySessions: 2, editingKeys: false },
    );
    assert.equal(simicsCliOptions({ consoles: { simicsCli: { historySessions: -1 } } }).historySessions, 0);
});

test("isEmptySession: only blank lines and bare prompts", () => {
    assert.equal(isEmptySession([]), true);
    assert.equal(isEmptySession(["\x1b[1m\x1b[34msimics> \x1b[0m"]), true);
    assert.equal(isEmptySession(["simics> ", "", "running> "]), true);
    assert.equal(isEmptySession(["simics> c"]), false);
    assert.equal(isEmptySession(["simics> ", "Hello"]), false);
});

test("historyText grays out each session and ends it with a rule", () => {
    assert.equal(SESSION_RULE, "\x1b[2m--- session ended ---\x1b[0m");
    assert.equal(
        historyText([{ lines: ["\x1b[1m\x1b[34ma\x1b[0m", "b"], ended: 1 }]),
        `\x1b[2ma\x1b[0m\r\n\x1b[2mb\x1b[0m\r\n${SESSION_RULE}\r\n`,
    );
});
