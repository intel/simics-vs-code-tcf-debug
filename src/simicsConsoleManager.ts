import * as vscode from "vscode";
import { ConsoleEntry, ConsoleSource } from "./consolesView";
import { applyAndSave } from "./launchSettings/editorProvider";
import { readConfigurations, setNamedConfigurationValue } from "./launchSettings/launchJson";
import {
    ConsoleChannel,
    ConsoleSession,
    ConsoleState,
    SimicsConsole,
    isEmptySession,
    simicsCliOptions,
    trimHistory,
} from "./simicsConsole";

const HAS_CONSOLES = "simics-target-debug.hasConsoles";
/** Enables the package.json key bindings that send VS Code's keys to Simics. */
const EDITING_KEYS = "simics-target-debug.editingKeys";
const HISTORY_KEY = "simics-target-debug.consoleHistory";
const LABEL = "Simics CLI";
const NO_SESSION =
    "Start a Simics Target Debug session first. The Simics console uses its connection to the TCF agent.";
const OPEN_LAUNCH_SETTINGS = "simics-target-debug.openLaunchSettings";

const ICONS: Record<ConsoleState | "closed", string> = {
    connecting: "loading~spin",
    connected: "terminal",
    disconnected: "debug-disconnect",
    closed: "circle-slash",
};

class ConsoleTerminal implements vscode.Pseudoterminal {
    private readonly writes = new vscode.EventEmitter<string>();
    readonly onDidWrite = this.writes.event;
    readonly console: SimicsConsole;
    /** The session is in the history. */
    recorded = false;

    constructor(channel: ConsoleChannel, history: ConsoleSession[], maxLines: number, stateChanged: () => void) {
        this.console = new SimicsConsole(
            channel,
            {
                write: (text) => this.writes.fire(text),
                setClipboard: (text) => void vscode.env.clipboard.writeText(text),
                stateChanged,
            },
            maxLines,
            history,
        );
    }

    open(dims: vscode.TerminalDimensions | undefined): void {
        void this.console.open(dims?.columns ?? 80, dims?.rows ?? 24);
    }

    close(): void {
        this.console.close();
        this.writes.dispose();
    }

    handleInput(data: string): void {
        this.console.input(data);
    }

    setDimensions(dims: vscode.TerminalDimensions): void {
        this.console.resize(dims.columns, dims.rows);
    }
}

interface HistoryOptions {
    keep: boolean;
    sessions: number;
}

interface Entry {
    key: string;
    session: vscode.DebugSession;
    options: HistoryOptions;
    editingKeys: boolean;
    terminal?: vscode.Terminal;
    pty?: ConsoleTerminal;
}

/**
 * The Simics CLI terminals, one per TCF agent (host:port). Each uses the
 * channel of the debug session it was opened for, and stays open read-only
 * after that session ends. The output of earlier sessions is kept per agent
 * in the workspace state, and written above the next session's output.
 * An agent's console is listed while its latest session runs, also when it
 * is not open, so that a click opens it.
 */
export class SimicsConsoleManager implements ConsoleSource, vscode.Disposable {
    private readonly entries = new Map<string, Entry>();
    private readonly sessions = new Set<string>();
    private readonly history: Map<string, ConsoleSession[]>;
    private readonly changes = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changes.event;
    private readonly disposables: vscode.Disposable[];

    constructor(
        private readonly debugType: string,
        private readonly sessionChannel: (session: vscode.DebugSession) => ConsoleChannel | undefined,
        private readonly state: vscode.Memento,
    ) {
        this.history = loadHistory(state.get(HISTORY_KEY));
        this.disposables = [
            this.changes,
            vscode.window.onDidCloseTerminal((t) => this.terminalClosed(t)),
            vscode.window.onDidChangeActiveTerminal(() => this.updateEditingKeys()),
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === debugType) {
                    this.sessions.add(s.id);
                }
            }),
            vscode.debug.onDidTerminateDebugSession((s) => {
                this.sessions.delete(s.id);
                this.prune();
            }),
        ];
    }

    /** Shows the console of `session`'s agent, opening a new one if needed. */
    show(session: vscode.DebugSession, preserveFocus: boolean): void {
        const key = agentKey(session);
        const entry = this.entries.get(key);
        if (entry?.terminal && entry.pty?.console.state !== "disconnected") {
            entry.terminal.show(preserveFocus);
            return;
        }
        const channel = this.sessionChannel(session);
        if (!channel?.isOpen) {
            void vscode.window.showErrorMessage(NO_SESSION);
            return;
        }
        const options = historyOptions(session);
        if (options.keep && entry?.pty?.recorded) {
            // Its output is written again in the new terminal.
            entry.terminal?.dispose();
        }
        const maxLines = scrollbackLines();
        const history = options.keep ? trimHistory(this.history.get(key) ?? [], options.sessions, maxLines) : [];
        const pty: ConsoleTerminal = new ConsoleTerminal(channel, history, maxLines, () =>
            this.consoleChanged(key, pty, options),
        );
        const others = [...this.entries.keys()].some((k) => k !== key);
        const terminal = vscode.window.createTerminal({
            name: others ? `${LABEL} (${key})` : LABEL,
            pty,
            location: vscode.TerminalLocation.Panel,
            iconPath: new vscode.ThemeIcon("terminal"),
        });
        this.entries.set(key, {
            key,
            session,
            options,
            // A console opened again in the same session keeps the button's choice.
            editingKeys:
                entry?.session === session ? entry.editingKeys : simicsCliOptions(session.configuration).editingKeys,
            terminal,
            pty,
        });
        terminal.show(preserveFocus);
        this.changed();
    }

    /** The agent of `session` has a console: opens it, or lists it as not open. */
    available(session: vscode.DebugSession, open: boolean): void {
        const key = agentKey(session);
        const entry = this.entries.get(key);
        const editingKeys = simicsCliOptions(session.configuration).editingKeys;
        if (!entry) {
            this.entries.set(key, { key, session, options: historyOptions(session), editingKeys });
        } else if (entry.session !== session) {
            entry.session = session;
            entry.editingKeys = editingKeys;
        }
        if (open) {
            this.show(session, true);
        } else {
            this.changed();
        }
    }

    /** "Open Simics Console": for the active session. */
    open(): void {
        const session = vscode.debug.activeDebugSession;
        if (session?.type !== this.debugType) {
            void vscode.window.showErrorMessage(NO_SESSION);
            return;
        }
        this.show(session, false);
    }

    consoleEntries(): ConsoleEntry[] {
        const many = this.entries.size > 1;
        return [...this.entries.values()].map((e) => {
            const state = e.terminal ? (e.pty?.console.state ?? "closed") : "closed";
            const live = state === "connecting" || state === "connected";
            const connectable = !live && this.connectable(e);
            const keys = e.editingKeys ? "keysToSimics" : "keysToVsCode";
            const connect = connectable ? (state === "closed" ? "connect" : "reconnect") : "";
            const contextValue = [
                "simicsCli",
                this.history.get(e.key)?.length ? "history" : "",
                live ? keys : "",
                connect,
            ]
                .filter((v) => v)
                .join(" ");
            return {
                id: `simics-cli:${e.key}`,
                label: many ? `${LABEL} (${e.key})` : LABEL,
                description: describe(state, connectable),
                tooltip: tooltip(e, state, connectable),
                icon: ICONS[state],
                iconColor: live ? undefined : "disabledForeground",
                contextValue,
                show: () => (connectable ? this.show(e.session, false) : e.terminal?.show(false)),
                connect: () => this.show(e.session, false),
                clearHistory: () => this.clearHistory(e.key),
                setEditingKeys: (on: boolean) => this.setEditingKeys(e.key, on),
            };
        });
    }

    /** Changes the console at once, and saves the choice in the session's configuration in launch.json. */
    async setEditingKeys(key: string, on: boolean): Promise<void> {
        const entry = this.entries.get(key);
        if (!entry) {
            return;
        }
        entry.editingKeys = on;
        this.changed();
        try {
            await saveEditingKeys(entry.session, on);
        } catch (err) {
            void vscode.window.showWarningMessage(
                "The editing keys changed for this console only. Could not save them to launch.json: " +
                    (err instanceof Error ? err.message : String(err)),
            );
        }
    }

    /** Forgets the earlier sessions of the agent at `key`, and redraws its terminal. */
    async clearHistory(key: string): Promise<void> {
        const count = this.history.get(key)?.length ?? 0;
        if (count === 0) {
            return;
        }
        const clear = "Clear History";
        const answer = await vscode.window.showWarningMessage(
            `Clear the Simics CLI history of ${key}?`,
            {
                modal: true,
                detail: `The output of ${count === 1 ? "1 earlier session" : `${count} earlier sessions`} is deleted. It cannot be restored.`,
            },
            clear,
        );
        if (answer !== clear) {
            return;
        }
        this.history.delete(key);
        void this.save();
        const entry = this.entries.get(key);
        // A session that has ended is in the history just deleted.
        entry?.pty?.console.clearHistory(entry.pty.recorded && entry.options.keep);
        this.changed();
    }

    dispose(): void {
        for (const e of this.entries.values()) {
            // Ends the session now, so that it is saved in the history.
            e.pty?.console.close();
            e.terminal?.dispose();
        }
        this.entries.clear();
        this.disposables.forEach((d) => d.dispose());
    }

    private consoleChanged(key: string, pty: ConsoleTerminal, options: HistoryOptions): void {
        if (pty.console.state === "disconnected" && !pty.recorded) {
            pty.recorded = true;
            const lines = pty.console.transcript.snapshot();
            if (options.keep && !isEmptySession(lines)) {
                const ended = pty.console.endedAt ?? Date.now();
                const sessions = [...(this.history.get(key) ?? []), { lines, ended }];
                this.history.set(key, trimHistory(sessions, options.sessions, scrollbackLines()));
                void this.save();
            }
        }
        this.changed();
    }

    private save(): Thenable<void> {
        return this.state.update(HISTORY_KEY, Object.fromEntries(this.history));
    }

    private terminalClosed(terminal: vscode.Terminal): void {
        const entry = [...this.entries.values()].find((e) => e.terminal === terminal);
        if (entry) {
            entry.terminal = undefined;
            entry.pty = undefined;
            this.prune();
        }
    }

    /** Its session runs, so a click opens a new console. */
    private connectable(e: Entry): boolean {
        return this.sessions.has(e.session.id) && this.sessionChannel(e.session)?.isOpen === true;
    }

    /** A console that is not open is listed only while its session runs. */
    private prune(): void {
        for (const [key, e] of this.entries) {
            if (!e.terminal && !this.sessions.has(e.session.id)) {
                this.entries.delete(key);
            }
        }
        this.changed();
    }

    private changed(): void {
        void vscode.commands.executeCommand("setContext", HAS_CONSOLES, this.entries.size > 0);
        this.updateEditingKeys();
        this.changes.fire();
    }

    /** A read-only console leaves the keys to VS Code. */
    private updateEditingKeys(): void {
        const active = vscode.window.activeTerminal;
        const entry = [...this.entries.values()].find((e) => e.terminal && e.terminal === active);
        const on = !!entry?.editingKeys && !!entry.pty && entry.pty.console.state !== "disconnected";
        void vscode.commands.executeCommand("setContext", EDITING_KEYS, on);
    }
}

function agentKey(session: vscode.DebugSession): string {
    const c = session.configuration;
    const host = typeof c.host === "string" ? c.host : "localhost";
    const port = typeof c.port === "number" ? c.port : 1534;
    return `${host}:${port}`;
}

function historyOptions(session: vscode.DebugSession): HistoryOptions {
    const { historySessions } = simicsCliOptions(session.configuration);
    return { keep: historySessions > 0, sessions: historySessions };
}

function describe(state: ConsoleState | "closed", connectable: boolean): string {
    switch (state) {
        case "closed":
            return connectable ? "not open – click to connect" : "not open";
        case "connecting":
            return "connecting…";
        case "connected":
            return "connected";
        case "disconnected":
            return connectable ? "disconnected – click to reconnect" : "disconnected";
    }
}

function tooltip(e: Entry, state: ConsoleState | "closed", connectable: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendText(`Simics command line of the TCF agent at ${e.key}: ${state === "closed" ? "not open" : state}.`);
    if (state === "connecting" || state === "connected") {
        md.appendText(` Editing keys such as Ctrl+P go to ${e.editingKeys ? "Simics" : "VS Code"}.`);
    } else if (connectable) {
        md.appendText(state === "closed" ? " Click to connect." : " Click to reconnect.");
    } else if (state === "disconnected") {
        md.appendText(" Click to show its output.");
    }
    if (connectable && !simicsCliOptions(e.session.configuration).open) {
        md.appendMarkdown(
            '\n\nTo open it every time you attach, set `"open": true` under `consoles.simicsCli` ' +
                "in the launch configuration.",
        );
        const folder = e.session.workspaceFolder;
        if (folder) {
            const launchJson = vscode.Uri.joinPath(folder.uri, ".vscode", "launch.json");
            const args = encodeURIComponent(JSON.stringify([launchJson]));
            md.appendMarkdown(` [Open launch configurations](command:${OPEN_LAUNCH_SETTINGS}?${args})`);
            md.isTrusted = { enabledCommands: [OPEN_LAUNCH_SETTINGS] };
        }
    }
    return md;
}

function scrollbackLines(): number {
    return vscode.workspace.getConfiguration("terminal.integrated").get<number>("scrollback", 1000);
}

/** Does nothing for sessions that were not started from a configuration in the folder's launch.json. */
async function saveEditingKeys(session: vscode.DebugSession, on: boolean): Promise<void> {
    const folder = session.workspaceFolder;
    if (!folder) {
        return;
    }
    let document: vscode.TextDocument;
    try {
        document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, ".vscode", "launch.json"));
    } catch {
        return;
    }
    const text = document.getText();
    const read = readConfigurations(text);
    if (read.error !== undefined) {
        throw new Error(read.error);
    }
    const name = session.configuration.name;
    if (!read.configurations.some((c) => c.name === name)) {
        return;
    }
    // On is the default, so it is removed rather than written.
    const path = ["consoles", "simicsCli", "editingKeys"];
    await applyAndSave(document, setNamedConfigurationValue(text, name, path, on ? undefined : false));
}

function loadHistory(saved: unknown): Map<string, ConsoleSession[]> {
    const history = new Map<string, ConsoleSession[]>();
    if (typeof saved !== "object" || saved === null) {
        return history;
    }
    for (const [key, sessions] of Object.entries(saved)) {
        if (Array.isArray(sessions)) {
            history.set(
                key,
                sessions.filter(
                    (s: Partial<ConsoleSession>) =>
                        Array.isArray(s?.lines) &&
                        s.lines.every((l) => typeof l === "string") &&
                        typeof s.ended === "number",
                ),
            );
        }
    }
    return history;
}
