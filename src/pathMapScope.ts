import * as vscode from "vscode";
import { PathMapRule, pathMapContextQuery } from "./pathMapper";

type Scope = Pick<PathMapRule, "context" | "contextQuery">;

/** Shared by the Path Map view and Locate Source File. */
export async function promptPathMapScope(current: Scope = {}, contextId?: string): Promise<Scope | undefined> {
    const modes = [
        {
            label: "All contexts",
            description: "Default: no context filter",
            mode: "all",
        },
        {
            label: "Context ID",
            description: "One exact context ID",
            mode: "id",
        },
        {
            label: "Context query",
            description: "A TCF ContextQuery expression",
            mode: "query",
        },
    ];
    const mode = await vscode.window.showQuickPick(modes, {
        title: "Path Map Scope",
        placeHolder: `Current: ${pathMapContextQuery(current) ?? "all contexts"}`,
        ignoreFocusOut: true,
    });
    if (!mode) {
        return undefined;
    }
    if (mode.mode === "all") {
        return {};
    }
    const value = await vscode.window.showInputBox({
        title: mode.mode === "id" ? "Context ID" : "Context Query",
        prompt:
            mode.mode === "id"
                ? "Exact TCF context ID (sent as ContextQuery: ID=<id>)"
                : "TCF query, for example **/HasState=true",
        value: mode.mode === "id" ? (current.context ?? contextId ?? "") : (current.contextQuery ?? ""),
        ignoreFocusOut: true,
        validateInput: (text) => (text.trim().length ? undefined : "Enter a non-empty scope."),
    });
    if (value === undefined) {
        return undefined;
    }
    return mode.mode === "id" ? { context: value } : { contextQuery: value };
}
