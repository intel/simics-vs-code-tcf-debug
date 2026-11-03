import * as vscode from "vscode";

/*
 * The Consoles view in the Run and Debug side bar. It lists consoles from
 * several sources, for now only the Simics CLI; later for example the serial
 * ports of the target.
 */

export interface ConsoleEntry {
    id: string;
    label: string;
    description?: string;
    tooltip?: string | vscode.MarkdownString;
    /** A codicon name. */
    icon: string;
    /** A theme color ID for the icon, such as disabledForeground. */
    iconColor?: string;
    /** For the view's menus, as viewItem. */
    contextValue?: string;
    show(): void;
    /** Opens the console again, for example after the session ended. */
    connect?(): void;
    clearHistory?(): void | Promise<void>;
    /** Whether keys such as Ctrl+P go to the console instead of VS Code. */
    setEditingKeys?(on: boolean): void | Promise<void>;
}

export interface ConsoleSource {
    consoleEntries(): ConsoleEntry[];
    readonly onDidChange: vscode.Event<void>;
}

const VIEW = "simics-target-debug.consoles";
const SHOW_COMMAND = "simics-target-debug.showConsole";
const CLEAR_HISTORY_COMMAND = "simics-target-debug.clearConsoleHistory";

class ConsolesProvider implements vscode.TreeDataProvider<ConsoleEntry>, vscode.Disposable {
    private readonly changes = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changes.event;
    private readonly subscriptions: vscode.Disposable[];

    constructor(private readonly sources: ConsoleSource[]) {
        this.subscriptions = sources.map((s) => s.onDidChange(() => this.changes.fire()));
    }

    getTreeItem(entry: ConsoleEntry): vscode.TreeItem {
        const item = new vscode.TreeItem(entry.label);
        item.id = entry.id;
        item.description = entry.description;
        item.tooltip = entry.tooltip;
        item.iconPath = new vscode.ThemeIcon(
            entry.icon,
            entry.iconColor ? new vscode.ThemeColor(entry.iconColor) : undefined,
        );
        item.contextValue = entry.contextValue;
        item.command = {
            command: SHOW_COMMAND,
            title: "Show Console",
            arguments: [entry],
        };
        return item;
    }

    getChildren(): ConsoleEntry[] {
        return this.sources.flatMap((s) => s.consoleEntries());
    }

    dispose(): void {
        this.subscriptions.forEach((s) => s.dispose());
        this.changes.dispose();
    }
}

export function registerConsolesView(context: vscode.ExtensionContext, sources: ConsoleSource[]): void {
    const provider = new ConsolesProvider(sources);
    context.subscriptions.push(
        provider,
        vscode.window.registerTreeDataProvider(VIEW, provider),
        vscode.commands.registerCommand(SHOW_COMMAND, (entry?: ConsoleEntry) => entry?.show()),
        vscode.commands.registerCommand(CLEAR_HISTORY_COMMAND, (entry?: ConsoleEntry) => entry?.clearHistory?.()),
        vscode.commands.registerCommand("simics-target-debug.connectConsole", (entry?: ConsoleEntry) =>
            entry?.connect?.(),
        ),
        vscode.commands.registerCommand("simics-target-debug.reconnectConsole", (entry?: ConsoleEntry) =>
            entry?.connect?.(),
        ),
        vscode.commands.registerCommand("simics-target-debug.consoleKeysToSimics", (entry?: ConsoleEntry) =>
            entry?.setEditingKeys?.(true),
        ),
        vscode.commands.registerCommand("simics-target-debug.consoleKeysToVsCode", (entry?: ConsoleEntry) =>
            entry?.setEditingKeys?.(false),
        ),
    );
}
