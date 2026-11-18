import { findNodeAtLocation, parseTree } from "jsonc-parser";
import * as vscode from "vscode";
import { setWebviewHtml } from "./editorProvider";
import { SettingValue, SettingsStateMessage, SettingsTarget, SettingsWebviewMessage } from "./protocol";
import { Field, settingFields } from "./schema";

/** Must match "onWebviewPanel:..." in package.json. */
const SETTINGS_VIEW_TYPE = "simics-target-debug.settings";
const TITLE = "Simics Target Debug Settings";

/**
 * The settings of the extension, and the VS Code settings it uses, in a form
 * like the launch configurations form. One panel at a time. The settings are
 * the only state: every change is written to them, and every change of them,
 * also from settings.json, updates the form.
 */
export function registerSettingsView(context: vscode.ExtensionContext): void {
    const fields = settingFields(context.extension.packageJSON);
    let current: vscode.WebviewPanel | undefined;
    /** The tab the panel shows, the settings.json the editor title button opens. */
    let tab: SettingsTarget = "user";
    const show = (panel: vscode.WebviewPanel) => {
        current = panel;
        panel.onDidDispose(() => {
            if (current === panel) {
                current = undefined;
            }
        });
        resolveSettingsView(panel, context.extensionUri, fields, (shown) => (tab = shown));
    };
    context.subscriptions.push(
        vscode.commands.registerCommand("simics-target-debug.openSettings", () => {
            if (current) {
                current.reveal();
            } else {
                show(vscode.window.createWebviewPanel(SETTINGS_VIEW_TYPE, TITLE, vscode.ViewColumn.Active));
            }
        }),
        vscode.commands.registerCommand("simics-target-debug.openSettingsJson", () => openSettingsJson(tab, fields)),
        // Opens the panel again after a window reload.
        vscode.window.registerWebviewPanelSerializer(SETTINGS_VIEW_TYPE, {
            deserializeWebviewPanel: async (panel) => show(panel),
        }),
    );
}

function resolveSettingsView(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    fields: Field[],
    tabShown: (target: SettingsTarget) => void,
): void {
    const webview = panel.webview;
    setWebviewHtml(webview, extensionUri, "settings.js", TITLE);
    const post = () => {
        const message: SettingsStateMessage = {
            type: "settingsState",
            fields,
            hasWorkspace: vscode.workspace.workspaceFolders !== undefined,
            values: settingValues(fields),
        };
        void webview.postMessage(message);
    };
    const subscriptions = [
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (fields.some((f) => f.setting && e.affectsConfiguration(f.setting.section))) {
                post();
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(post),
        webview.onDidReceiveMessage(async (message: SettingsWebviewMessage) => {
            try {
                await handle(message, fields, post, tabShown);
            } catch (err) {
                void vscode.window.showErrorMessage(`${TITLE}: ${err instanceof Error ? err.message : String(err)}`);
                post();
            }
        }),
    ];
    panel.onDidDispose(() => subscriptions.forEach((s) => s.dispose()));
}

async function handle(
    message: SettingsWebviewMessage,
    fields: Field[],
    post: () => void,
    tabShown: (target: SettingsTarget) => void,
): Promise<void> {
    switch (message.type) {
        case "ready":
            post();
            return;
        case "tab":
            tabShown(message.target);
            return;
        case "openJson":
            await openSettingsJson(message.target, fields);
            return;
        case "setSetting": {
            const setting = fields.find((f) => f.key === message.key)?.setting;
            if (!setting) {
                return;
            }
            const value = setting.invert && typeof message.value === "boolean" ? !message.value : message.value;
            await vscode.workspace
                .getConfiguration()
                .update(setting.section, value, configurationTarget(message.target));
            return;
        }
    }
}

/**
 * Opens the settings.json of `target` at the first of the fields' settings
 * it sets, else after its last setting, where a new one would go.
 */
async function openSettingsJson(target: SettingsTarget, fields: Field[]): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const key = fields
        .map((f) => f.setting?.section)
        .find((section) => {
            const i = section === undefined ? undefined : config.inspect(section);
            return (target === "user" ? i?.globalValue : i?.workspaceValue) !== undefined;
        });
    await vscode.commands.executeCommand(
        target === "user" ? "workbench.action.openSettingsJson" : "workbench.action.openWorkspaceSettingsFile",
        key === undefined ? undefined : { revealSetting: { key } },
    );
    if (key === undefined) {
        revealEnd(vscode.window.activeTextEditor);
    }
}

/** Puts the cursor after the last setting of a settings.json or .code-workspace file. */
function revealEnd(editor: vscode.TextEditor | undefined): void {
    if (!editor || !/(settings\.json|\.code-workspace)$/.test(editor.document.uri.path)) {
        return;
    }
    const document = editor.document;
    const text = document.getText();
    const root = parseTree(text, [], { allowTrailingComma: true });
    const settings = document.uri.path.endsWith(".code-workspace")
        ? root && findNodeAtLocation(root, ["settings"])
        : root;
    if (settings?.type !== "object") {
        return;
    }
    const last = settings.children?.at(-1);
    // After the last setting, or after the "{" of an empty object.
    const offset = last ? last.offset + last.length : settings.offset + 1;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function configurationTarget(target: SettingsTarget): vscode.ConfigurationTarget {
    return target === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
}

/**
 * The value each field shows in each tab: the one set in the tab's settings,
 * else the one it inherits, like in the Settings editor.
 */
function settingValues(fields: Field[]): Record<SettingsTarget, Record<string, SettingValue>> {
    const config = vscode.workspace.getConfiguration();
    const values: Record<SettingsTarget, Record<string, SettingValue>> = { user: {}, workspace: {} };
    for (const f of fields) {
        if (!f.setting) {
            continue;
        }
        const invert = f.setting.invert === true;
        const shown = (v: unknown) => (invert && typeof v === "boolean" ? !v : v);
        const i = config.inspect(f.setting.section);
        const user = i?.globalValue ?? i?.defaultValue;
        values.user[f.key] = {
            value: shown(user),
            modified: i?.globalValue !== undefined,
            overridden: i?.workspaceValue !== undefined,
        };
        values.workspace[f.key] = {
            value: shown(i?.workspaceValue ?? user),
            modified: i?.workspaceValue !== undefined,
        };
    }
    return values;
}
