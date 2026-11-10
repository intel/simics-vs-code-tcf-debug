import { TcfChannel } from "@/tcf/channel";

/*
 * The Simics CommandLine service, see CommandLine-service.md in the Simics TCF
 * agent. Simics does all line editing; the client sends key presses and draws
 * what the events ask for.
 */

/** Key codes of keyPressed. 32-126 and 128-255 are the character itself. */
export const enum CommandLineKey {
    Left = 0,
    Right = 1,
    Up = 2,
    Down = 3,
    PageUp = 4,
    PageDown = 5,
    Home = 6,
    End = 7,
    Backspace = 8,
    Tab = 9,
    Return = 10,
    Delete = 11,
    Insert = 12,
    F1 = 13,
}

/** Modifier bits of keyPressed. */
export const enum CommandLineModifier {
    None = 0,
    Shift = 1,
    Ctrl = 2,
    Alt = 4,
}

/** Error codes in the service's error reports. */
export const enum CommandLineError {
    Other = 1,
    AlreadyConnected = 2,
    NotConnected = 3,
}

export interface CommandLineListener {
    write?(text: string): void;
    deleteLine?(): void;
    clearScreen?(): void;
    disconnected?(): void;
    cursorLeft?(n: number): void;
    cursorRight?(n: number): void;
    setSelection?(start: number, end: number): void;
    setClipboard?(text: string): void;
}

/** The parts of a channel the service uses. */
export type CommandLineChannel = Pick<TcfChannel, "command" | "onEvent">;

export class CommandLineService {
    static readonly NAME = "CommandLine";

    constructor(private readonly channel: CommandLineChannel) {}

    async connect(): Promise<void> {
        await this.cmd("connect");
    }

    async disconnect(): Promise<void> {
        await this.cmd("disconnect");
    }

    async sizeChanged(cols: number, rows: number): Promise<void> {
        await this.cmd("sizeChanged", cols, rows);
    }

    async keyPressed(mod: number, key: number): Promise<void> {
        await this.cmd("keyPressed", mod, key);
    }

    async positionChanged(pos: number): Promise<void> {
        await this.cmd("positionChanged", pos);
    }

    async selectionChanged(start: number, end: number): Promise<void> {
        await this.cmd("selectionChanged", start, end);
    }

    async clipboardChanged(content: string): Promise<void> {
        await this.cmd("clipboardChanged", content);
    }

    /** Returns a function that removes the listener. */
    addListener(l: CommandLineListener): () => void {
        const on = (event: string, fn: (args: unknown[]) => void) =>
            this.channel.onEvent(CommandLineService.NAME, event, fn);
        const removers = [
            on("write", (a) => l.write?.(String(a[0] ?? ""))),
            on("deleteLine", () => l.deleteLine?.()),
            on("clearScreen", () => l.clearScreen?.()),
            on("disconnected", () => l.disconnected?.()),
            on("cursorLeft", (a) => l.cursorLeft?.(asInt(a[0]))),
            on("cursorRight", (a) => l.cursorRight?.(asInt(a[0]))),
            on("setSelection", (a) => l.setSelection?.(asInt(a[0]), asInt(a[1]))),
            on("setClipboard", (a) => l.setClipboard?.(String(a[0] ?? ""))),
        ];
        return () => removers.forEach((remove) => remove());
    }

    private cmd(command: string, ...args: unknown[]): Promise<unknown[]> {
        return this.channel.command(CommandLineService.NAME, command, ...args);
    }
}

function asInt(v: unknown): number {
    return typeof v === "number" ? v : Number(v ?? 0) || 0;
}
