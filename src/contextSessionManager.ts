import * as vscode from "vscode";
import { TcfContextSession } from "./contextSession";
import {
    ContextGroup,
    ContextSessionHost,
    ContextSessionLink,
    ContextSessionSink,
    TcfDebugSession,
} from "./tcfDebugSession";

/** Debug configuration attribute of a context session: its root session and group. */
const CONTEXT_SESSION = "__simicsContextSession";

interface ContextSessionConfig {
    root: string;
    key: string;
}

function contextSessionConfig(config: vscode.DebugConfiguration): ContextSessionConfig | undefined {
    const value = config[CONTEXT_SESSION] as Partial<ContextSessionConfig> | undefined;
    return typeof value?.root === "string" && typeof value.key === "string"
        ? { root: value.root, key: value.key }
        : undefined;
}

/** Whether a configuration is that of a context session, which the extension starts. */
export function isContextSessionConfig(config: vscode.DebugConfiguration): boolean {
    return contextSessionConfig(config) !== undefined;
}

/** Whether a session only shows the threads of a container context. */
export function isContextSession(session: vscode.DebugSession): boolean {
    return isContextSessionConfig(session.configuration);
}

/** The session that is connected to the agent: `session`, or the root of a context session. */
export function rootSession(session: vscode.DebugSession | undefined): vscode.DebugSession | undefined {
    while (session && isContextSession(session)) {
        session = session.parentSession;
    }
    return session;
}

/** The root of the active debug session. */
export function activeRootSession(): vscode.DebugSession | undefined {
    return rootSession(vscode.debug.activeDebugSession);
}

/**
 * Shows the container contexts of the agent (for example the processes of
 * an OS awareness tracker) as nested sessions in the Call Stack view, with
 * the threads of each context in its session. VS Code has no thread
 * hierarchy, but it nests child sessions under their parent.
 */
export class ContextSessionManager implements vscode.Disposable {
    private readonly roots = new Map<string, RootSessions>();
    private readonly disposable: vscode.Disposable;

    constructor(
        private readonly debugType: string,
        private readonly log: vscode.LogOutputChannel,
    ) {
        this.disposable = vscode.debug.onDidTerminateDebugSession((s) => this.roots.delete(s.id));
    }

    /** The adapter of a context session, undefined for other sessions. */
    createContextAdapter(session: vscode.DebugSession): vscode.DebugAdapter | undefined {
        const config = contextSessionConfig(session.configuration);
        if (!config) {
            return undefined;
        }
        const root = this.roots.get(config.root);
        return new TcfContextSession((sink) => root?.connect(config.key, session, sink));
    }

    /** Lets the adapter of a root session start context sessions. */
    addRoot(session: vscode.DebugSession, adapter: TcfDebugSession): void {
        const root = new RootSessions(session, adapter, this.debugType, this.log);
        this.roots.set(session.id, root);
        adapter.setContextSessionHost(root);
    }

    dispose(): void {
        this.disposable.dispose();
    }
}

interface GroupEntry {
    name: string;
    /** The group's session once its adapter is created, undefined if it was not started. */
    session: Promise<vscode.DebugSession | undefined>;
    resolve(session: vscode.DebugSession | undefined): void;
}

/** The context sessions of one root session. */
class RootSessions implements ContextSessionHost {
    private readonly groups = new Map<string, GroupEntry>();
    /**
     * The last start of a child session, by parent group key ("" for the
     * root). VS Code lists child sessions in the order they start, so
     * siblings start one at a time, in the order the adapter added them.
     */
    private readonly lastStart = new Map<string, Promise<unknown>>();

    constructor(
        private readonly session: vscode.DebugSession,
        private readonly adapter: TcfDebugSession,
        private readonly debugType: string,
        private readonly log: vscode.LogOutputChannel,
    ) {}

    groupAdded(group: ContextGroup): void {
        let resolve!: (session: vscode.DebugSession | undefined) => void;
        const entry: GroupEntry = {
            name: group.name,
            session: new Promise((r) => (resolve = r)),
            resolve: (s) => resolve(s),
        };
        this.groups.set(group.key, entry);
        const parent =
            group.parentKey === undefined
                ? Promise.resolve(this.session)
                : (this.groups.get(group.parentKey)?.session ?? Promise.resolve(undefined));
        const siblings = group.parentKey ?? "";
        const previous = this.lastStart.get(siblings) ?? Promise.resolve();
        const start = Promise.all([parent, previous]).then(async ([parentSession]) => {
            if (!parentSession || this.groups.get(group.key) !== entry) {
                entry.resolve(undefined);
                return;
            }
            try {
                const config: vscode.DebugConfiguration = {
                    type: this.debugType,
                    request: "attach",
                    name: entry.name,
                    [CONTEXT_SESSION]: { root: this.session.id, key: group.key } satisfies ContextSessionConfig,
                };
                const started = await vscode.debug.startDebugging(this.session.workspaceFolder, config, {
                    parentSession,
                    lifecycleManagedByParent: true,
                    consoleMode: vscode.DebugConsoleMode.MergeWithParent,
                    // VS Code shows a compact session in one row with its parent, if it is the parent's
                    // only child; the row shows the child's name only.
                    compact: this.session.configuration.callStackCompact !== false,
                    suppressSaveBeforeStart: true,
                    suppressDebugView: true,
                });
                if (!started) {
                    entry.resolve(undefined);
                }
            } catch (err) {
                this.log.error(`Cannot start the debug session of ${entry.name}: ${String(err)}`);
                entry.resolve(undefined);
            }
        });
        this.lastStart.set(siblings, start);
        void start.finally(() => {
            if (this.lastStart.get(siblings) === start) {
                this.lastStart.delete(siblings);
            }
        });
    }

    groupRenamed(key: string, name: string): void {
        const entry = this.groups.get(key);
        if (entry) {
            entry.name = name;
            void entry.session.then((s) => {
                if (s) {
                    s.name = name;
                }
            });
        }
    }

    groupRemoved(key: string): void {
        // The root adapter ends the session itself.
        this.groups.get(key)?.resolve(undefined);
        this.groups.delete(key);
    }

    /** Connects the adapter of a group's session, created by VS Code. */
    connect(key: string, session: vscode.DebugSession, sink: ContextSessionSink): ContextSessionLink | undefined {
        const link = this.adapter.connectContextSession(key, sink);
        if (link) {
            this.groups.get(key)?.resolve(session);
        }
        return link;
    }
}
