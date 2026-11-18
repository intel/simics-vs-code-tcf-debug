import type { LaunchConfiguration } from "@/launchSettings/launchJson";
import type { StateMessage, WebviewMessage } from "@/launchSettings/protocol";
import { agentAddress, Field, fieldPath, valueAtPath } from "@/launchSettings/schema";
import {
    clearDrafts,
    control,
    Editor,
    focusLater,
    h,
    iconButton,
    restoreFocus,
    saveFocus,
    setting,
    textInput,
    unsupported,
} from "./controls";

/*
 * The launch configurations form: configuration names on the left, the attributes
 * of the selected one on the right. It keeps no data of its own, every
 * change goes to the extension, which updates launch.json and sends back a
 * new state.
 */

interface VsCodeApi {
    postMessage(message: WebviewMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface Selection {
    index: number;
    name: string;
}

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;

let state: StateMessage | undefined;
/** The configurations last read without error, shown read-only while launch.json is broken. */
let lastGood: LaunchConfiguration[] = [];
const savedState = vscode.getState() as { selected?: Selection; advancedOpen?: boolean } | undefined;
let selected = savedState?.selected;
let advancedOpen = savedState?.advancedOpen ?? false;
/** Set by a click on Start: no "why disabled" tooltip until the mouse leaves. */
let quietStart = false;

document.addEventListener("mousemove", (e) => {
    if (quietStart && !(e.target as Element).closest("button.start")) {
        quietStart = false;
        document.querySelectorAll("button.start").forEach((b) => {
            b.setAttribute("title", b.getAttribute("aria-label") ?? "");
        });
    }
});

const NAME_FIELD: Field = {
    key: "name",
    label: "Name",
    kind: "string",
    description: "Shown in the Run and Debug view.",
};
const FIXED_KEYS = new Set(["type", "request", "name"]);

window.addEventListener("message", (event: MessageEvent<StateMessage>) => {
    if (event.data?.type === "state") {
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
    const listScroll = app.querySelector(".list")?.scrollTop ?? 0;
    const detailsScroll = app.querySelector(".details")?.scrollTop ?? 0;
    const previous = selected;
    const readOnly = state.error !== undefined;
    if (!readOnly) {
        lastGood = state.configurations;
    }
    const configs = lastGood;
    const config = currentConfiguration(configs);
    state.select = undefined;
    selected = config && { index: config.index, name: config.name };
    saveState();

    app.replaceChildren(
        readOnly
            ? h(
                  "div",
                  { className: "banner" },
                  h("span", {}, `launch.json cannot be read (${state.error}). Fix it in the text editor.`),
                  h("button", { onclick: () => vscode.postMessage({ type: "openText" }) }, "Open as Text"),
              )
            : "",
        h(
            "fieldset",
            { className: "layout", disabled: readOnly },
            renderList(configs, config),
            renderDetails(config, configs),
        ),
    );
    // The panes are new elements, so they would start scrolled to the top.
    app.querySelector(".list")?.scrollTo({ top: listScroll });
    if (config && previous?.index === config.index && previous.name === config.name) {
        app.querySelector(".details")?.scrollTo({ top: detailsScroll });
    }
    restoreFocus(app, focus);
}

/** The configuration to show: the one asked for, else the same one as before. */
function currentConfiguration(configs: LaunchConfiguration[]): LaunchConfiguration | undefined {
    const wanted = state?.select;
    return (
        configs.find((c) => c.index === wanted) ??
        configs.find((c) => c.index === selected?.index && c.name === selected?.name) ??
        configs.find((c) => c.name === selected?.name) ??
        configs.find((c) => c.index === selected?.index) ??
        configs[0]
    );
}

function select(config: LaunchConfiguration, focus = false): void {
    selected = { index: config.index, name: config.name };
    clearDrafts();
    if (focus) {
        focusLater(`item:${config.index}`);
    }
    render();
}

function renderList(configs: LaunchConfiguration[], active: LaunchConfiguration | undefined): HTMLElement {
    const counts = nameCounts(configs);
    const items = configs.map((c, i) =>
        h(
            "li",
            {
                className: c === active ? "selected" : "",
                tabIndex: 0,
                role: "option",
                "aria-selected": String(c === active),
                "data-focus": `item:${c.index}`,
                onclick: () => select(c),
                onkeydown: (e: KeyboardEvent) => {
                    const next =
                        e.key === "ArrowDown" ? configs[i + 1] : e.key === "ArrowUp" ? configs[i - 1] : undefined;
                    if (next) {
                        e.preventDefault();
                        select(next, true);
                    }
                },
            },
            h(
                "div",
                { className: "item-text" },
                h(
                    "span",
                    { className: "item-name" },
                    c.name || "(no name)",
                    (counts.get(c.name) ?? 0) > 1 ? h("span", { className: "position" }, ` #${c.index + 1}`) : "",
                ),
                h("span", { className: "item-address" }, address(c)),
            ),
            itemActions(c),
        ),
    );
    const deleteAll = iconButton("close-all", "Delete All TCF Launch Configurations", () =>
        vscode.postMessage({
            type: "deleteAll",
            configurations: configs.map((c) => ({ index: c.index, name: c.name })),
        }),
    );
    deleteAll.disabled = configs.length === 0;
    return h(
        "nav",
        { className: "list" },
        h(
            "div",
            { className: "list-header" },
            h("span", {}, "Configurations"),
            h(
                "div",
                { className: "actions" },
                iconButton("add", "Add a TCF launch configuration", () => vscode.postMessage({ type: "add" })),
                deleteAll,
            ),
        ),
        configs.length > 0
            ? h("ul", { role: "listbox", "aria-label": "TCF launch configurations" }, ...items)
            : h("p", { className: "empty" }, "No TCF launch configurations yet."),
    );
}

function address(config: LaunchConfiguration): string {
    return agentAddress(config.values);
}

/** Start, Duplicate and Delete for one configuration. */
function itemActions(config: LaunchConfiguration): HTMLElement {
    const target = { index: config.index, name: config.name };
    const problem = startProblem(config);
    const start = iconButton("debug-start", problem ?? "Start Debugging", () => {
        quietStart = true;
        vscode.postMessage({ type: "start", ...target });
    });
    start.classList.add("start");
    start.disabled = problem !== undefined;
    if (start.disabled && quietStart) {
        start.title = "";
    }
    return h(
        "span",
        { className: "actions", onclick: (e: Event) => e.stopPropagation() },
        start,
        iconButton("copy", "Duplicate", () => vscode.postMessage({ type: "duplicate", ...target })),
        iconButton("trash", "Delete", () => vscode.postMessage({ type: "delete", ...target })),
    );
}

/** Why the configuration cannot be started now, if it cannot. */
function startProblem(config: LaunchConfiguration): string | undefined {
    if (state?.busyAgents.includes(address(config))) {
        return `A Simics Target Debug session to ${address(config)} is already running`;
    }
    const empty = (v: unknown) => v === undefined || v === "";
    const emptyCell = (row: unknown, key: string) => empty((row as Record<string, unknown> | null)?.[key]);
    const missing = (state?.fields ?? []).find((f) => {
        const value = valueAtPath(config.values, fieldPath(f));
        if (f.required && empty(value)) {
            return true;
        }
        const required = (f.columns ?? []).filter((c) => c.required);
        return Array.isArray(value) && value.some((row) => required.some((c) => emptyCell(row, c.key)));
    });
    if (!config.name) {
        return "Cannot start: the name is empty";
    }
    return missing ? `Cannot start: ${missing.label} needs a value` : undefined;
}

function renderDetails(config: LaunchConfiguration | undefined, configs: LaunchConfiguration[]): HTMLElement {
    if (!config || !state) {
        return h(
            "main",
            { className: "details" },
            h("p", { className: "empty" }, "Use the + button to create a TCF launch configuration."),
        );
    }
    const target = { index: config.index, name: config.name };
    const missing = new Set(state.missingPaths);
    const edit: Editor = {
        set: (path, value) => vscode.postMessage({ type: "set", ...target, path, value }),
        remove: (path) => vscode.postMessage({ type: "remove", ...target, path }),
        browse: (path, pick) => vscode.postMessage({ type: "browse", ...target, path, pick }),
        isMissing: (path) => missing.has(`${config.index}:${path.join("/")}`),
        openText: () => vscode.postMessage({ type: "openText" }),
    };
    const sameName = (nameCounts(configs).get(config.name) ?? 0) > 1;
    const known = new Set(state.fields.map((f) => fieldPath(f)[0]));
    const others = Object.keys(config.values).filter((k) => !known.has(k) && !FIXED_KEYS.has(k));
    const own = state.fields.filter((f) => f.group === undefined);
    const advanced = state.fields.filter((f) => f.group === "advanced");
    const settings = (fields: Field[]) =>
        fields.map((f) => {
            const value = valueAtPath(config.values, fieldPath(f));
            return setting(f, value, true, edit, control(f, value, edit));
        });

    return h(
        "main",
        { className: "details" },
        h("div", { className: "details-header" }, itemActions(config)),
        setting(NAME_FIELD, config.name, false, edit, [
            textInput(NAME_FIELD, config.values.name, ["name"], edit, "The name must not be empty"),
            sameName ? h("div", { className: "note" }, "Another configuration has the same name.") : "",
        ]),
        ...settings(own),
        foldDown("Advanced", advancedOpen, settings(advanced), (open) => (advancedOpen = open)),
        others.length > 0 ? otherAttributes(config, others, edit) : "",
        h(
            "p",
            { className: "settings-hint" },
            "The Simics console, call stack, disassembly and TCF trace options apply to all configurations. " +
                "They are in ",
            h(
                "button",
                { className: "link", onclick: () => vscode.postMessage({ type: "openSettings" }) },
                "the settings",
            ),
            ".",
        ),
    );
}

function foldDown(title: string, open: boolean, children: HTMLElement[], toggled: (open: boolean) => void) {
    if (children.length === 0) {
        return "";
    }
    return h(
        "details",
        {
            className: "fold-down",
            open,
            ontoggle: (e: Event) => {
                toggled((e.target as HTMLDetailsElement).open);
                saveState();
            },
        },
        h("summary", {}, title),
        ...children,
    );
}

function saveState(): void {
    vscode.setState({ selected, advancedOpen });
}

function otherAttributes(config: LaunchConfiguration, keys: string[], edit: Editor): HTMLElement {
    return h(
        "div",
        { className: "setting" },
        h("div", { className: "setting-title" }, h("span", { className: "label" }, "Other Attributes")),
        h("div", { className: "description" }, "Attributes this form does not know about."),
        ...keys.map((k) =>
            h("div", { className: "other" }, h("span", { className: "key" }, k), unsupported(config.values[k], edit)),
        ),
    );
}

function nameCounts(configs: LaunchConfiguration[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const c of configs) {
        counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    }
    return counts;
}
