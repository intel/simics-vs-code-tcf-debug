import * as vscode from "vscode";
import { silenceRuleCompletions } from "./silenceCompletion";
import { SimicsCliOptions, simicsCliOptions } from "./simicsConsole";
import type { TcfAttachArguments } from "./tcfDebugSession";

/** The prefix of the settings in "configuration" in package.json. */
export const SETTINGS = "simics-target-debug";

/** The simics-target-debug.console settings. */
export function consoleSettings(): SimicsCliOptions {
    const c = vscode.workspace.getConfiguration(`${SETTINGS}.console`);
    return simicsCliOptions({
        open: c.get("open"),
        historySessions: c.get("historySessions"),
        editingKeys: c.get("editingKeys"),
    });
}

export type SessionSettings = Pick<
    TcfAttachArguments,
    "traceTcf" | "traceTcfSilence" | "disassemblyFunctionHeaders" | "callStackHierarchy" | "callStackCompact"
>;

/** The settings a debug session uses, as attach arguments of the debug adapter. */
export function sessionSettings(): SessionSettings {
    const c = vscode.workspace.getConfiguration(SETTINGS);
    return {
        traceTcf: c.get("tcfTrace.enabled"),
        traceTcfSilence: c.get("tcfTrace.silence"),
        disassemblyFunctionHeaders: c.get("disassembly.functionHeaders"),
        callStackHierarchy: c.get("callStack.hierarchy"),
        callStackCompact: c.get("callStack.compact"),
    };
}

/** Changes a setting in the workspace settings if they have it, else in the user settings. */
export async function updateSetting(section: string, value: unknown): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const inWorkspace = config.inspect(section)?.workspaceValue !== undefined;
    await config.update(
        section,
        value,
        inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
    );
}

/** Suggests services and message types in the rules of the TCF trace silence setting. */
export function registerSilenceCompletions(): vscode.Disposable {
    return vscode.languages.registerCompletionItemProvider(
        { language: "jsonc" },
        {
            provideCompletionItems(document, position) {
                if (!/(settings\.json|\.code-workspace)$/.test(document.uri.path)) {
                    return undefined;
                }
                const found = silenceRuleCompletions(document.getText(), document.offsetAt(position));
                if (!found) {
                    return undefined;
                }
                const range = new vscode.Range(document.positionAt(found.start), position);
                return found.values.map((value, i) => {
                    const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember);
                    item.range = range;
                    item.sortText = String(i).padStart(3, "0");
                    return item;
                });
            },
        },
        '"',
        "/",
        ",",
    );
}
