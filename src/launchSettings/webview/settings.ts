import type { JsonPath, SettingsStateMessage, SettingsTarget, SettingsWebviewMessage } from "@/launchSettings/protocol";
import { editList, Field } from "@/launchSettings/schema";
import { control, Editor, h, iconButton, restoreFocus, saveFocus, setting } from "./controls";

/*
 * The Simics Target Debug settings, laid out like the Settings editor: a tab
 * for the user settings and one for the workspace settings, and a heading per
 * group of settings. Every change goes to the extension, which updates the
 * settings and sends back a new state.
 */

interface VsCodeApi {
    postMessage(message: SettingsWebviewMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const TABS: { target: SettingsTarget; label: string }[] = [
    { target: "user", label: "User" },
    { target: "workspace", label: "Workspace" },
];

const RESET_TITLES: Record<SettingsTarget, string> = {
    user: "Remove the user setting, so the default is used",
    workspace: "Remove the workspace setting, so the user setting or the default is used",
};

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;

let state: SettingsStateMessage | undefined;
let target: SettingsTarget = (vscode.getState() as { target?: SettingsTarget } | undefined)?.target ?? "user";
/** The tab last reported to the extension. */
let reported: SettingsTarget | undefined;

window.addEventListener("message", (event: MessageEvent<SettingsStateMessage>) => {
    if (event.data?.type === "settingsState") {
        state = event.data;
        render();
    }
});
vscode.postMessage({ type: "ready" });

function render(): void {
    if (!state) {
        return;
    }
    const focus = saveFocus();
    const scroll = app.querySelector(".details")?.scrollTop ?? 0;
    const shown = state.hasWorkspace ? target : "user";
    if (shown !== reported) {
        reported = shown;
        vscode.postMessage({ type: "tab", target: shown });
    }
    const groups = [...new Set(state.fields.map((f) => f.group))];
    app.replaceChildren(
        h(
            "main",
            { className: "details" },
            h(
                "div",
                { className: "details-header tabs" },
                h(
                    "div",
                    { role: "tablist" },
                    ...TABS.filter((t) => state?.hasWorkspace || t.target === "user").map((t) => tab(t, shown)),
                ),
                iconButton("json", "Open Settings (JSON)", () =>
                    vscode.postMessage({ type: "openJson", target: shown }),
                ),
            ),
            ...groups.map((group) =>
                h(
                    "section",
                    { role: "tabpanel" },
                    group ? h("h2", { className: "group-title" }, group) : "",
                    ...state!.fields.filter((f) => f.group === group).map((f) => settingRow(f, shown)),
                ),
            ),
        ),
    );
    app.querySelector(".details")?.scrollTo({ top: scroll });
    restoreFocus(app, focus);
}

function tab(t: (typeof TABS)[number], shown: SettingsTarget): HTMLElement {
    const selected = t.target === shown;
    return h(
        "button",
        {
            className: selected ? "tab selected" : "tab",
            role: "tab",
            "aria-selected": String(selected),
            "data-focus": `tab:${t.target}`,
            onclick: () => {
                target = t.target;
                vscode.setState({ target });
                render();
            },
        },
        t.label,
    );
}

function settingRow(f: Field, shown: SettingsTarget): HTMLElement {
    const s = state?.values[shown][f.key];
    const edit = editor(f, s?.value, shown);
    return setting(f, s?.modified ? s.value : undefined, true, edit, [
        control(f, s?.value, edit),
        s?.overridden
            ? h("div", { className: "note" }, "Also set in the workspace settings, which apply in this workspace.")
            : "",
    ]);
}

/**
 * Writes whole values: a change inside a list, at a path below the field,
 * is applied to the list shown, which may be the user or default value.
 */
function editor(f: Field, current: unknown, shown: SettingsTarget): Editor {
    const write = (value?: unknown) => vscode.postMessage({ type: "setSetting", key: f.key, target: shown, value });
    const changed = (path: JsonPath, value: unknown) =>
        editList(Array.isArray(current) ? current : [], path.slice(1), value);
    return {
        set: (path, value) => write(path.length > 1 ? changed(path, value) : value),
        remove: (path) => write(path.length > 1 ? changed(path, undefined) : undefined),
        browse: () => undefined,
        isMissing: () => false,
        openText: () => vscode.postMessage({ type: "openJson", target: shown }),
        textName: "settings.json",
        resetTitle: RESET_TITLES[shown],
    };
}
