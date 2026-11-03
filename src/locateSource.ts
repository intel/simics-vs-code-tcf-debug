import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { setPathMapRules } from "./launchSettings/launchJson";
import { applyAndSave } from "./launchSettings/editorProvider";
import { PathMapRule, deriveRule, pathMapContextQuery } from "./pathMapper";
import { promptPathMapScope } from "./pathMapScope";

/** A source file of a stack frame that is not on this host. */
export interface MissingSource {
    /** Path in the debug information. */
    compiledPath: string;
    /** The path mapping gave, the same as compiledPath if no rule applies. */
    hostPath: string;
    line: number;
    contextId: string;
}

/**
 * Lets the user locate source files that the debug adapter could not find,
 * and turns the located file into a path map rule for the session.
 */
export class SourceLocator {
    private readonly notified = new WeakMap<vscode.DebugSession, Set<string>>();

    /** Offers to locate a source once per file, context, and session. */
    async sourceNotFound(session: vscode.DebugSession, missing: MissingSource): Promise<void> {
        let notified = this.notified.get(session);
        if (!notified) {
            notified = new Set();
            this.notified.set(session, notified);
        }
        const key = JSON.stringify([missing.contextId, missing.compiledPath]);
        if (notified.has(key)) {
            return;
        }
        notified.add(key);
        const choice = await vscode.window.showWarningMessage(
            `Source file ${missing.compiledPath} was not found on this ` + `host (context ${missing.contextId}).`,
            "Locate...",
        );
        if (choice === "Locate...") {
            await this.locate(session, missing);
        }
    }

    /** Lets the user pick a missing source file of a session and locate it. */
    async locateCommand(session: vscode.DebugSession | undefined): Promise<void> {
        if (!session) {
            void vscode.window.showErrorMessage("No active Simics Target Debug session.");
            return;
        }
        const { sources } = (await session.customRequest("getMissingSources")) as { sources: MissingSource[] };
        if (sources.length === 0) {
            void vscode.window.showInformationMessage("All source files shown in the Call Stack were found.");
            return;
        }
        const missing =
            sources.length === 1
                ? sources[0]
                : (
                      await vscode.window.showQuickPick(
                          sources.map((s) => ({
                              label: path.basename(s.compiledPath),
                              description: `${s.compiledPath} (${s.contextId})`,
                              source: s,
                          })),
                          { placeHolder: "Source file to locate" },
                      )
                  )?.source;
        if (missing) {
            await this.locate(session, missing);
        }
    }

    private async locate(session: vscode.DebugSession, missing: MissingSource): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: session.workspaceFolder?.uri,
            title: `Locate ${missing.compiledPath}`,
            openLabel: "Use This File",
        });
        if (!picked?.[0]) {
            return;
        }
        const scope = await promptPathMapScope({}, missing.contextId);
        if (scope === undefined) {
            return;
        }
        const rule = {
            ...deriveRule(missing.compiledPath, picked[0].fsPath),
            ...scope,
        };
        try {
            await session.customRequest("addPathMapRule", rule);
        } catch (err) {
            void vscode.window.showErrorMessage(`Could not add the path map rule: ${errorMessage(err)}`);
            return;
        }
        const line = Math.max(missing.line - 1, 0);
        await vscode.window.showTextDocument(picked[0], {
            selection: new vscode.Range(line, 0, line, 0),
            preview: true,
        });
        await this.offerToSave(session, rule);
    }

    /** Offers to add the rule to the session's configuration in launch.json. */
    private async offerToSave(session: vscode.DebugSession, rule: PathMapRule): Promise<void> {
        const folder = session.workspaceFolder;
        const launchJson = folder && vscode.Uri.joinPath(folder.uri, ".vscode", "launch.json");
        const message =
            `Added the path map rule ${rule.source} → ` +
            `${rule.destination} for this session ` +
            `(${pathMapContextQuery(rule) ?? "all contexts"}).`;
        if (!launchJson || !fs.existsSync(launchJson.fsPath)) {
            void vscode.window.showInformationMessage(message);
            return;
        }
        const choice = await vscode.window.showInformationMessage(message, "Save to launch.json");
        if (choice !== "Save to launch.json") {
            return;
        }
        try {
            await savePathMapRules(
                launchJson,
                session.configuration.name,
                [withWorkspaceFolder(rule, folder.uri.fsPath)],
                true,
            );
        } catch (err) {
            void vscode.window.showErrorMessage(`Could not save the path map rule: ${errorMessage(err)}`);
        }
    }
}

/** Writes destinations in the workspace folder as ${workspaceFolder}/... */
export function withWorkspaceFolder(rule: PathMapRule, folder: string): PathMapRule {
    const relative = path.relative(folder, rule.destination);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return rule;
    }
    const destination =
        relative === "" ? "${workspaceFolder}" : `\${workspaceFolder}/${relative.split(path.sep).join("/")}`;
    return { ...rule, destination };
}

export async function savePathMapRules(
    launchJson: vscode.Uri,
    configName: string,
    rules: PathMapRule[],
    append = false,
): Promise<void> {
    const document = await vscode.workspace.openTextDocument(launchJson);
    const text = document.getText();
    const edits = setPathMapRules(text, configName, rules, append);
    await applyAndSave(document, edits);
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
