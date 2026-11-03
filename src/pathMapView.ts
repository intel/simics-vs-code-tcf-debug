import * as path from "path";
import * as vscode from "vscode";
import { savePathMapRules, withWorkspaceFolder } from "./locateSource";
import { PathMapRule, pathMapContextQuery } from "./pathMapper";
import { promptPathMapScope } from "./pathMapScope";

const VIEW = "simics-target-debug.pathMap";
const DEBUG_TYPE = "simics-target-debug";

class PathMapItem extends vscode.TreeItem {
    override readonly contextValue = "pathMapRule";

    constructor(
        readonly rule: PathMapRule,
        readonly index: number,
        readonly session: vscode.DebugSession,
    ) {
        super(rule.source);
        const scope = pathMapContextQuery(rule) ?? "all contexts";
        this.description = `${rule.destination} (${scope})`;
        this.tooltip = `${index + 1}. ${rule.source}\n` + `To: ${rule.destination}\nScope: ${scope}`;
        this.iconPath = new vscode.ThemeIcon("replace-all");
        this.command = {
            command: "simics-target-debug.editPathMapRule",
            title: "Edit Path Map Rule",
            arguments: [this],
        };
    }
}

class PathMapProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly changes = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changes.event;

    refresh(): void {
        this.changes.fire();
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    async getChildren(): Promise<vscode.TreeItem[]> {
        const session = vscode.debug.activeDebugSession;
        if (session?.type !== DEBUG_TYPE) {
            return [];
        }
        try {
            const rules = await getRules(session);
            if (session !== vscode.debug.activeDebugSession) {
                return [];
            }
            return rules.length
                ? rules.map((rule, i) => new PathMapItem(rule, i, session))
                : [new vscode.TreeItem("No session path map rules")];
        } catch (err) {
            return [new vscode.TreeItem(`Could not load path map: ${errorMessage(err)}`)];
        }
    }

    dispose(): void {
        this.changes.dispose();
    }
}

export function registerPathMapView(context: vscode.ExtensionContext): void {
    const provider = new PathMapProvider();
    const command = (name: string, action: (session: vscode.DebugSession, item?: PathMapItem) => Promise<void>) =>
        vscode.commands.registerCommand(`simics-target-debug.${name}`, async (item?: PathMapItem) => {
            try {
                const session = vscode.debug.activeDebugSession;
                if (session?.type !== DEBUG_TYPE || (item && item.session !== session)) {
                    throw new Error("Select an active Simics Target Debug session.");
                }
                await action(session, item);
            } catch (err) {
                void vscode.window.showErrorMessage(`Could not update path map: ${errorMessage(err)}`);
            }
        });
    context.subscriptions.push(
        provider,
        vscode.window.registerTreeDataProvider(VIEW, provider),
        vscode.debug.onDidStartDebugSession(() => provider.refresh()),
        vscode.debug.onDidTerminateDebugSession(() => provider.refresh()),
        vscode.debug.onDidChangeActiveDebugSession(() => provider.refresh()),
        vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
            if (event.session.type === DEBUG_TYPE && event.event === "pathMapChanged") {
                provider.refresh();
            }
        }),
        vscode.commands.registerCommand("simics-target-debug.refreshPathMap", () => provider.refresh()),
        command("addPathMapRule", (session) => editRule(session)),
        command("editPathMapRule", editRule),
        command("removePathMapRule", (session, item) => changeRule(session, item, "remove")),
        command("movePathMapRuleUp", (session, item) => changeRule(session, item, "up")),
        command("movePathMapRuleDown", (session, item) => changeRule(session, item, "down")),
        command("savePathMap", saveRules),
    );
}

async function getRules(session: vscode.DebugSession): Promise<PathMapRule[]> {
    const result = (await session.customRequest("getPathMapRules")) as {
        rules: PathMapRule[];
    };
    return result.rules;
}

function checkItem(rules: PathMapRule[], item?: PathMapItem): void {
    if (
        item &&
        (rules[item.index]?.source !== item.rule.source ||
            rules[item.index]?.destination !== item.rule.destination ||
            pathMapContextQuery(rules[item.index]) !== pathMapContextQuery(item.rule))
    ) {
        throw new Error("Path map rules changed. Refresh and retry.");
    }
}

async function setRules(
    session: vscode.DebugSession,
    rules: PathMapRule[],
    expectedRules: PathMapRule[],
): Promise<void> {
    if (vscode.debug.activeDebugSession !== session) {
        throw new Error("The active debug session changed. Please retry.");
    }
    await session.customRequest("setPathMapRules", { rules, expectedRules });
}

async function editRule(session: vscode.DebugSession, item?: PathMapItem): Promise<void> {
    const previous = await getRules(session);
    checkItem(previous, item);
    const source = await vscode.window.showInputBox({
        title: item ? "Edit Path Map Rule" : "Add Path Map Rule",
        prompt: "Source path prefix as compiled into the debug information",
        value: item?.rule.source,
        ignoreFocusOut: true,
        validateInput: nonEmptyPath,
    });
    if (source === undefined) {
        return;
    }
    const destination = await vscode.window.showInputBox({
        title: "Path Map Destination",
        prompt: "Path on this host (relative paths use the workspace folder)",
        value: item?.rule.destination ?? session.workspaceFolder?.uri.fsPath,
        ignoreFocusOut: true,
        validateInput: nonEmptyPath,
    });
    if (destination === undefined) {
        return;
    }
    const scope = await promptPathMapScope(item?.rule);
    if (scope === undefined) {
        return;
    }
    let hostPath = destination;
    if (!path.isAbsolute(hostPath)) {
        const folder = session.workspaceFolder;
        if (!folder) {
            throw new Error("Use an absolute destination without a workspace.");
        }
        hostPath = path.resolve(folder.uri.fsPath, hostPath);
    }
    const rule = {
        source,
        destination: hostPath,
        ...scope,
    };
    const rules = [...previous];
    if (item) {
        rules[item.index] = rule;
    } else {
        rules.push(rule);
    }
    await setRules(session, rules, previous);
}

async function changeRule(
    session: vscode.DebugSession,
    item: PathMapItem | undefined,
    action: "remove" | "up" | "down",
): Promise<void> {
    if (!item) {
        throw new Error("Select a rule in the Path Maps view.");
    }
    const previous = await getRules(session);
    checkItem(previous, item);
    const rules = [...previous];
    if (action === "remove") {
        rules.splice(item.index, 1);
    } else {
        const to = item.index + (action === "up" ? -1 : 1);
        if (to < 0 || to >= rules.length) {
            return;
        }
        [rules[item.index], rules[to]] = [rules[to], rules[item.index]];
    }
    await setRules(session, rules, previous);
}

async function saveRules(session: vscode.DebugSession): Promise<void> {
    const folder = session.workspaceFolder;
    if (!folder) {
        throw new Error("This session has no workspace debug configuration.");
    }
    const rules = await getRules(session);
    const choice = await vscode.window.showWarningMessage(
        `Replace the pathMap in "${session.configuration.name}" with ` + `the ${rules.length} session rule(s)?`,
        { modal: true },
        "Save",
    );
    if (choice !== "Save") {
        return;
    }
    await savePathMapRules(
        vscode.Uri.joinPath(folder.uri, ".vscode", "launch.json"),
        session.configuration.name,
        rules.map((rule) => withWorkspaceFolder(rule, folder.uri.fsPath)),
    );
    void vscode.window.showInformationMessage(`Saved path map to "${session.configuration.name}".`);
}

function nonEmptyPath(value: string): string | undefined {
    return value.trim().length ? undefined : "Enter a non-empty path.";
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
