import * as vscode from "vscode";
import { activeRootSession } from "./contextSessionManager";
import {
    DeleteAllSnapshotsResult,
    SNAPSHOTS_CHANGED_EVENT,
    SnapshotArgs,
    SnapshotRequest,
    SnapshotsResult,
    TakeSnapshotArgs,
    TakeSnapshotResult,
    freeSnapshotName,
    snapshotNameProblem,
} from "./snapshots";

const VIEW = "simics-target-debug.snapshots";
const DEBUG_TYPE = "simics-target-debug";
/**
 * "supported" or "unsupported" for the active session, unset when there is
 * none or it is still attaching. Enables the take commands, shows restore and
 * delete in the Command Palette, and picks the welcome text in package.json.
 */
const STATE_KEY = "simics-target-debug.snapshots";
/** Whether the active session's agent has snapshots, for the Delete All button. */
const HAS_SNAPSHOTS_KEY = "simics-target-debug.hasSnapshots";

type State = "supported" | "unsupported" | undefined;

class SnapshotItem extends vscode.TreeItem {
    override readonly contextValue = "snapshot";

    constructor(
        readonly name: string,
        readonly session: vscode.DebugSession,
    ) {
        super(name);
        this.iconPath = new vscode.ThemeIcon("device-camera");
        this.tooltip = `Snapshot "${name}"`;
    }
}

interface Current {
    session?: vscode.DebugSession;
    state: State;
    names: string[];
    error?: string;
}

class SnapshotsProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly changes = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changes.event;
    private current: Current = { state: undefined, names: [] };
    private updates = 0;
    view: vscode.TreeView<vscode.TreeItem> | undefined;

    get names(): readonly string[] {
        return this.current.names;
    }

    /** Lists the snapshots of the active session again. */
    async refresh(): Promise<void> {
        const update = ++this.updates;
        const session = activeRootSession();
        let next: Current = { state: undefined, names: [] };
        if (session?.type === DEBUG_TYPE) {
            try {
                const result = (await session.customRequest(SnapshotRequest.List)) as SnapshotsResult;
                // Without a reason, the adapter is not attached yet.
                const state = result.supported ? "supported" : result.reason ? "unsupported" : undefined;
                next = { session, state, names: result.snapshots };
            } catch (err) {
                next = { session, state: "supported", names: [], error: errorMessage(err) };
            }
        }
        if (update !== this.updates) {
            return;
        }
        this.current = next;
        void vscode.commands.executeCommand("setContext", STATE_KEY, next.state);
        void vscode.commands.executeCommand("setContext", HAS_SNAPSHOTS_KEY, next.names.length > 0);
        if (this.view) {
            this.view.description = next.state === "unsupported" ? "not available" : undefined;
        }
        this.changes.fire();
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    getChildren(): vscode.TreeItem[] {
        const { session, names, error } = this.current;
        if (error !== undefined) {
            return [new vscode.TreeItem(`Could not list snapshots: ${error}`)];
        }
        return session ? names.map((name) => new SnapshotItem(name, session)) : [];
    }

    dispose(): void {
        this.changes.dispose();
    }
}

export function registerSnapshotsView(context: vscode.ExtensionContext): void {
    const provider = new SnapshotsProvider();
    const view = vscode.window.createTreeView(VIEW, { treeDataProvider: provider });
    provider.view = view;
    const refresh = () => void provider.refresh();
    const command = (
        name: string,
        failure: string,
        action: (session: vscode.DebugSession, item?: SnapshotItem) => Promise<void>,
    ) =>
        vscode.commands.registerCommand(`simics-target-debug.${name}`, async (item?: SnapshotItem) => {
            try {
                const session = activeRootSession();
                if (session?.type !== DEBUG_TYPE || (item && item.session !== session)) {
                    throw new Error("Select an active Simics Target Debug session.");
                }
                await action(session, item);
            } catch (err) {
                void vscode.window.showErrorMessage(`${failure}: ${errorMessage(err)}`);
            } finally {
                refresh();
            }
        });
    context.subscriptions.push(
        provider,
        view,
        vscode.debug.onDidStartDebugSession(refresh),
        vscode.debug.onDidTerminateDebugSession(refresh),
        vscode.debug.onDidChangeActiveDebugSession(refresh),
        vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
            if (event.session.type === DEBUG_TYPE && event.event === SNAPSHOTS_CHANGED_EVENT) {
                refresh();
            }
        }),
        vscode.commands.registerCommand("simics-target-debug.refreshSnapshots", refresh),
        command("takeSnapshot", "Could not take snapshot", (session) => take(session)),
        command("takeNamedSnapshot", "Could not take snapshot", async (session) => {
            const name = await vscode.window.showInputBox({
                title: "Take Named Snapshot",
                prompt: "Name of the new snapshot",
                value: freeSnapshotName(provider.names),
                ignoreFocusOut: true,
                validateInput: (value) => snapshotNameProblem(value, provider.names),
            });
            if (name !== undefined) {
                await take(session, name);
            }
        }),
        command("restoreSnapshot", "Could not restore snapshot", async (session, item) => {
            const name = await snapshotName(provider, item, "Restore Snapshot");
            if (name === undefined) {
                return;
            }
            await session.customRequest(SnapshotRequest.Restore, { name } satisfies SnapshotArgs);
            vscode.window.setStatusBarMessage(`Restored snapshot "${name}"`, 5000);
        }),
        command("deleteSnapshot", "Could not delete snapshot", async (session, item) => {
            const name = await snapshotName(provider, item, "Delete Snapshot");
            if (name === undefined) {
                return;
            }
            const choice = await vscode.window.showWarningMessage(
                `Delete snapshot "${name}"?`,
                { modal: true },
                "Delete",
            );
            if (choice === "Delete") {
                await session.customRequest(SnapshotRequest.Delete, { name } satisfies SnapshotArgs);
            }
        }),
        command("deleteAllSnapshots", "Could not delete snapshots", async (session) => {
            const count = provider.names.length;
            if (count === 0) {
                throw new Error("There are no snapshots.");
            }
            const choice = await vscode.window.showWarningMessage(
                count === 1 ? `Delete snapshot "${provider.names[0]}"?` : `Delete all ${count} snapshots?`,
                { modal: true, detail: "This cannot be undone." },
                "Delete All",
            );
            if (choice === "Delete All") {
                const result = (await session.customRequest(SnapshotRequest.DeleteAll)) as DeleteAllSnapshotsResult;
                vscode.window.setStatusBarMessage(`Deleted ${result.deleted.length} snapshot(s)`, 5000);
            }
        }),
    );
}

async function take(session: vscode.DebugSession, name?: string): Promise<void> {
    const result = (await session.customRequest(SnapshotRequest.Take, {
        name,
    } satisfies TakeSnapshotArgs)) as TakeSnapshotResult;
    vscode.window.setStatusBarMessage(`Took snapshot "${result.name}"`, 5000);
}

/** The snapshot of the view item, or one picked from the list when run from the Command Palette. */
async function snapshotName(
    provider: SnapshotsProvider,
    item: SnapshotItem | undefined,
    title: string,
): Promise<string | undefined> {
    if (item) {
        return item.name;
    }
    if (provider.names.length === 0) {
        throw new Error("There are no snapshots.");
    }
    return vscode.window.showQuickPick([...provider.names], { title, placeHolder: "Snapshot" });
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
