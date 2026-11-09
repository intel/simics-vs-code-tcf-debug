import { randomBytes } from "crypto";
import { Edit } from "jsonc-parser";
import * as path from "path";
import * as vscode from "vscode";
import {
    DEBUG_TYPE,
    LaunchConfiguration,
    addConfiguration,
    detectFormatting,
    duplicateConfiguration,
    readConfigurations,
    removeConfiguration,
    removeConfigurations,
    setValue,
} from "./launchJson";
import { SettingValue, StateMessage, WebviewMessage } from "./protocol";
import { Field, fieldPath, launchFields, launchTemplate, valueAtPath } from "./schema";

/** Must match "customEditors" in package.json. */
export const LAUNCH_SETTINGS_VIEW_TYPE = "simics-target-debug.launchSettings";

const NEW_LAUNCH_JSON = '{\n    "version": "0.2.0",\n    "configurations": []\n}\n';

const tcfSessions = new Set<vscode.DebugSession>();
/** Set from the form's start until VS Code has started the session or failed. */
let starting = false;
const debuggingChanged = new vscode.EventEmitter<void>();

function isDebugging(): boolean {
    return starting || tcfSessions.size > 0;
}

/** The values of the fields stored in VS Code settings, see Field.setting. */
function settingValues(fields: Field[], uri: vscode.Uri): Record<string, SettingValue> {
    const config = vscode.workspace.getConfiguration(undefined, uri);
    const values: Record<string, SettingValue> = {};
    for (const f of fields) {
        if (f.setting) {
            const value = config.get(f.setting.section);
            values[f.key] = {
                value: f.setting.invert && typeof value === "boolean" ? !value : value,
                modified: config.inspect(f.setting.section)?.workspaceValue !== undefined,
            };
        }
    }
    return values;
}

export function registerLaunchSettings(context: vscode.ExtensionContext): void {
    const packageJson: unknown = context.extension.packageJSON;
    const provider = new LaunchSettingsEditorProvider(
        context.extensionUri,
        launchFields(packageJson, DEBUG_TYPE),
        launchTemplate(packageJson, DEBUG_TYPE),
    );
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(LAUNCH_SETTINGS_VIEW_TYPE, provider, {
            supportsMultipleEditorsPerDocument: true,
        }),
        vscode.commands.registerCommand("simics-target-debug.openLaunchSettings", openLaunchSettings),
        vscode.commands.registerCommand("simics-target-debug.openLaunchJson", openLaunchJson),
        vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === DEBUG_TYPE) {
                tcfSessions.add(session);
                debuggingChanged.fire();
            }
        }),
        vscode.debug.onDidTerminateDebugSession((session) => {
            if (tcfSessions.delete(session)) {
                debuggingChanged.fire();
            }
        }),
        debuggingChanged,
    );
}

/**
 * Opens launch.json in the form. From an editor title button the file is
 * given, from the Command Palette the user picks a workspace folder.
 */
async function openLaunchSettings(uri?: unknown): Promise<void> {
    const target = uri instanceof vscode.Uri ? uri : await pickLaunchJson();
    if (target) {
        await vscode.commands.executeCommand("vscode.openWith", target, LAUNCH_SETTINGS_VIEW_TYPE);
    }
}

async function openLaunchJson(uri?: unknown): Promise<void> {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const target = uri instanceof vscode.Uri ? uri : input instanceof vscode.TabInputCustom ? input.uri : undefined;
    if (target) {
        await vscode.commands.executeCommand("vscode.openWith", target, "default");
    }
}

/** The launch.json of a workspace folder, created if it does not exist. */
async function pickLaunchJson(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        void vscode.window.showErrorMessage("Open a folder to edit its launch configurations.");
        return undefined;
    }
    const folder =
        folders.length === 1
            ? folders[0]
            : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Folder whose launch.json to edit" });
    if (!folder) {
        return undefined;
    }
    const uri = vscode.Uri.joinPath(folder.uri, ".vscode", "launch.json");
    try {
        await vscode.workspace.fs.stat(uri);
    } catch {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ".vscode"));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(NEW_LAUNCH_JSON));
    }
    return uri;
}

/**
 * Shows the simics-target-debug configurations of a launch.json as a form. The text
 * document is the only state: every change is applied to it and saved, and
 * every change of it, also from a text editor, updates the form.
 */
class LaunchSettingsEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly fields: Field[],
        private readonly template: Record<string, unknown>,
    ) {}

    resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        const webview = panel.webview;
        const webviewDir = vscode.Uri.joinPath(this.extensionUri, "out", "webview");
        webview.options = { enableScripts: true, localResourceRoots: [webviewDir] };
        webview.html = this.html(webview, webviewDir);

        let select: number | undefined;
        let generation = 0;
        const post = async () => {
            const current = ++generation;
            const result = readConfigurations(document.getText());
            const configurations = result.configurations ?? [];
            const message: StateMessage = {
                type: "state",
                fields: this.fields,
                configurations,
                error: result.error,
                select,
                missingPaths: [],
                debugging: isDebugging(),
                settings: settingValues(this.fields, document.uri),
            };
            select = undefined;
            message.missingPaths = await missingPaths(
                configurations,
                this.fields,
                vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
            );
            // A newer state may have been posted while this one waited for the file system.
            if (current === generation) {
                void webview.postMessage(message);
            }
        };
        // One change at a time, each one is computed from the text the one before left.
        let queue = Promise.resolve();
        const subscriptions = [
            debuggingChanged.event(() => void post()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (this.fields.some((f) => f.setting && e.affectsConfiguration(f.setting.section))) {
                    void post();
                }
            }),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document === document) {
                    void post();
                }
            }),
            webview.onDidReceiveMessage((message: WebviewMessage) => {
                queue = queue
                    .then(() =>
                        this.handle(
                            document,
                            message,
                            (index) => {
                                select = index;
                            },
                            post,
                        ),
                    )
                    .catch((err) => {
                        void vscode.window.showErrorMessage(
                            `TCF Launch Configurations: ${err instanceof Error ? err.message : String(err)}`,
                        );
                        void post();
                    });
            }),
        ];
        panel.onDidDispose(() => subscriptions.forEach((s) => s.dispose()));
    }

    private async handle(
        document: vscode.TextDocument,
        message: WebviewMessage,
        setSelect: (index: number) => void,
        post: () => Promise<void>,
    ): Promise<void> {
        switch (message.type) {
            case "ready":
                await post();
                return;
            case "openText":
                await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
                return;
            case "setSetting": {
                const setting = this.fields.find((f) => f.key === message.key)?.setting;
                if (!setting) {
                    return;
                }
                const value = setting.invert && typeof message.value === "boolean" ? !message.value : message.value;
                // Window settings such as debug.focusEditorOnBreak cannot be set per folder.
                await vscode.workspace
                    .getConfiguration(undefined, document.uri)
                    .update(setting.section, value, vscode.ConfigurationTarget.Workspace);
                return;
            }
            case "set":
            case "remove": {
                const text = checkedText(document, message.index, message.name);
                const value = message.type === "set" ? message.value : undefined;
                await applyAndSave(
                    document,
                    setValue(text, message.index, message.path, value, detectFormatting(text)),
                );
                return;
            }
            case "browse": {
                const config = readConfigurations(
                    checkedText(document, message.index, message.name),
                ).configurations?.find((c) => c.index === message.index);
                const picked = await pickPath(document, valueAtPath(config?.values, message.path), message.pick);
                if (picked !== undefined) {
                    const text = checkedText(document, message.index, message.name);
                    await applyAndSave(
                        document,
                        setValue(text, message.index, message.path, picked, detectFormatting(text)),
                    );
                }
                return;
            }
            case "start": {
                if (isDebugging()) {
                    void vscode.window.showInformationMessage(
                        "A Simics Target Debug session is already running. " + "Stop it before starting another one.",
                    );
                    return;
                }
                const text = checkedText(document, message.index, message.name);
                const config = readConfigurations(text).configurations?.find((c) => c.index === message.index);
                if (config) {
                    startDebugging(document, config);
                }
                return;
            }
            case "add": {
                const text = document.getText();
                const added = addConfiguration(text, this.template, detectFormatting(text));
                setSelect(added.index);
                await applyAndSave(document, added.edits);
                return;
            }
            case "duplicate": {
                const text = checkedText(document, message.index, message.name);
                const copy = duplicateConfiguration(text, message.index, detectFormatting(text));
                setSelect(copy.index);
                await applyAndSave(document, copy.edits);
                return;
            }
            case "delete": {
                const answer = await vscode.window.showWarningMessage(
                    `Delete the launch configuration "${message.name}"?`,
                    { modal: true },
                    "Delete",
                );
                if (answer === "Delete") {
                    const text = checkedText(document, message.index, message.name);
                    await applyAndSave(document, removeConfiguration(text, message.index, detectFormatting(text)));
                }
                return;
            }
            case "deleteAll": {
                const shown = message.configurations;
                if (shown.length === 0) {
                    return;
                }
                const question =
                    shown.length === 1
                        ? `Delete the only TCF launch configuration "${shown[0].name}"?`
                        : `Delete all ${shown.length} TCF launch configurations?`;
                const answer = await vscode.window.showWarningMessage(
                    question,
                    { modal: true, detail: "Other configurations in launch.json are kept." },
                    "Delete All",
                );
                if (answer === "Delete All") {
                    shown.forEach((c) => checkedText(document, c.index, c.name));
                    const text = document.getText();
                    await applyAndSave(
                        document,
                        removeConfigurations(
                            text,
                            shown.map((c) => c.index),
                            detectFormatting(text),
                        ),
                    );
                }
                return;
            }
        }
    }

    private html(webview: vscode.Webview, webviewDir: vscode.Uri): string {
        const nonce = randomBytes(16).toString("base64");
        const script = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, "launchSettings.js"));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, "launchSettings.css"));
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; font-src data:; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${style}" rel="stylesheet">
    <title>TCF Launch Configurations</title>
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}

/**
 * Starts a debug session with the configuration as written in launch.json.
 * Not awaited by the caller, edits must not wait for the agent to connect.
 */
function startDebugging(document: vscode.TextDocument, config: LaunchConfiguration): void {
    // Passed as an object, as starting by name takes the first one with the name.
    const debugConfig = {
        ...config.values,
        name: config.name,
    } as vscode.DebugConfiguration;
    starting = true;
    debuggingChanged.fire();
    Promise.resolve(vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(document.uri), debugConfig))
        .catch((err: unknown) => {
            void vscode.window.showErrorMessage(
                `Cannot start ${config.name}: ` + (err instanceof Error ? err.message : String(err)),
            );
        })
        .finally(() => {
            starting = false;
            debuggingChanged.fire();
        });
}

/**
 * Lets the user pick a file or folder on the host the extension runs on (the
 * remote host in a remote window). Paths in the workspace folder are returned
 * as "${workspaceFolder}/...", so launch.json still works if the folder moves.
 */
async function pickPath(
    document: vscode.TextDocument,
    current: unknown,
    pick: "file" | "folder",
): Promise<string | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: pick === "file",
        canSelectFolders: pick === "folder",
        canSelectMany: false,
        defaultUri: await startUri(typeof current === "string" ? current : "", folder),
        openLabel: "Select",
    });
    if (!uris || uris.length === 0) {
        return undefined;
    }
    const picked = uris[0].fsPath;
    const relative = folder === undefined ? undefined : path.relative(folder, picked);
    if (relative === undefined || relative.startsWith("..") || path.isAbsolute(relative)) {
        return picked;
    }
    return relative === "" ? "${workspaceFolder}" : `\${workspaceFolder}/${relative.split(path.sep).join("/")}`;
}

/**
 * The current path if it is a folder, else its folder if that exists, else the workspace folder.
 * A file would make VS Code's simple file dialog behave like a save dialog.
 */
async function startUri(current: string, folder: string | undefined): Promise<vscode.Uri | undefined> {
    const resolved = current.trim() ? hostPath(current, folder) : undefined;
    for (const candidate of resolved === undefined ? [] : [resolved, path.dirname(resolved)]) {
        if (await isFolder(candidate)) {
            return vscode.Uri.file(candidate);
        }
    }
    return folder === undefined ? undefined : vscode.Uri.file(folder);
}

/** Values of "file-or-folder-path" fields that do not exist, in the format of StateMessage.missingPaths. */
async function missingPaths(
    configs: LaunchConfiguration[],
    fields: Field[],
    folder: string | undefined,
): Promise<string[]> {
    const checks: { key: string; value: unknown }[] = [];
    for (const config of configs) {
        for (const field of fields) {
            const path = fieldPath(field);
            const value = valueAtPath(config.values, path);
            if (field.browse === "fileOrFolder") {
                checks.push({ key: `${config.index}:${path.join("/")}`, value });
            }
            const columns = (field.columns ?? []).filter((c) => c.browse === "fileOrFolder");
            if (columns.length > 0 && Array.isArray(value)) {
                value.forEach((row: unknown, r) =>
                    columns.forEach((c) =>
                        checks.push({
                            key: `${config.index}:${field.key}/${r}/${c.key}`,
                            value: valueAtPath(row, [c.key]),
                        }),
                    ),
                );
            }
        }
    }
    const missing = await Promise.all(
        checks.map(async ({ key, value }) => {
            const resolved = typeof value === "string" && value.trim() !== "" ? hostPath(value, folder) : undefined;
            return resolved !== undefined && !(await exists(resolved)) ? [key] : [];
        }),
    );
    return missing.flat();
}

/** A path from launch.json on this host, undefined if it has variables other than ${workspaceFolder}. */
function hostPath(value: string, folder: string | undefined): string | undefined {
    const expanded = folder === undefined ? value : value.split("${workspaceFolder}").join(folder);
    if (expanded.includes("${")) {
        return undefined;
    }
    return folder !== undefined && !path.isAbsolute(expanded) ? path.join(folder, expanded) : expanded;
}

async function exists(file: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(file));
        return true;
    } catch {
        return false;
    }
}

async function isFolder(file: string): Promise<boolean> {
    try {
        return ((await vscode.workspace.fs.stat(vscode.Uri.file(file))).type & vscode.FileType.Directory) !== 0;
    } catch {
        return false;
    }
}

/** The document text, if it still has the configuration the form showed. */
function checkedText(document: vscode.TextDocument, index: number, name: string): string {
    const text = document.getText();
    const config = readConfigurations(text).configurations?.find((c) => c.index === index);
    if (config?.name !== name) {
        throw new Error("launch.json changed while you edited it, please try again.");
    }
    return text;
}

export async function applyAndSave(document: vscode.TextDocument, edits: Edit[]): Promise<void> {
    if (edits.length === 0) {
        return;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const e of edits) {
        const range = new vscode.Range(document.positionAt(e.offset), document.positionAt(e.offset + e.length));
        edit.replace(document.uri, range, e.content);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error("VS Code did not accept the change to launch.json.");
    }
    if (!(await document.save())) {
        throw new Error("VS Code could not save launch.json.");
    }
}
