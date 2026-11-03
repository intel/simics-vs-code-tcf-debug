import type { LaunchConfiguration } from "../launchJson";
import type { JsonPath, StateMessage, WebviewMessage } from "../protocol";
import {
    editList,
    Field,
    FieldKind,
    fieldPath,
    filterSuggestions,
    parseInput,
    toggleChoice,
    valueAtPath,
} from "../schema";

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
const savedState = vscode.getState() as
    { selected?: Selection; advancedOpen?: boolean; consoleOpen?: boolean } | undefined;
let selected = savedState?.selected;
let advancedOpen = savedState?.advancedOpen ?? false;
let consoleOpen = savedState?.consoleOpen ?? false;
let pendingFocus: string | undefined;
/** Text that failed validation, by focus key, so a new render does not drop it. */
const drafts = new Map<string, { text: string; error: string }>();
/** Set by a click on Start: no "why disabled" tooltip until the mouse leaves. */
let quietStart = false;
/** The focus key of the open multi-select dropdown, so it stays open when the form is rendered again. */
let openMultiSelect: string | undefined;

document.addEventListener("click", (e) => {
    document.querySelectorAll<HTMLDetailsElement>("details.multi-select[open]").forEach((d) => {
        if (!d.contains(e.target as Node)) {
            d.open = false;
        }
    });
});

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
    restoreFocus(focus);
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
    drafts.clear();
    if (focus) {
        pendingFocus = `item:${config.index}`;
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

/** host:port of the agent, with the same defaults as the debug session. */
function address(config: LaunchConfiguration): string {
    const { host, port } = config.values;
    return `${String(host ?? "localhost")}:${String(port ?? 1534)}`;
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
    if (state?.debugging) {
        return "A Simics Target Debug session is already running";
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
    };
    const sameName = (nameCounts(configs).get(config.name) ?? 0) > 1;
    const known = new Set(state.fields.map((f) => fieldPath(f)[0]));
    const others = Object.keys(config.values).filter((k) => !known.has(k) && !FIXED_KEYS.has(k));
    const own = state.fields.filter((f) => f.group === undefined);
    const consoleFields = state.fields.filter((f) => f.group === "console");
    const advanced = state.fields.filter((f) => f.group === "advanced");
    const settingValues = state.settings;
    const settingEdit = (f: Field): Editor => ({
        ...edit,
        set: (_path, value) => vscode.postMessage({ type: "setSetting", key: f.key, value }),
        remove: () => vscode.postMessage({ type: "setSetting", key: f.key }),
    });
    const settings = (fields: Field[]) =>
        fields.map((f) => {
            if (f.setting) {
                const s = settingValues[f.key];
                const e = settingEdit(f);
                return setting(f, s?.modified ? s.value : undefined, true, e, control(f, s?.value, e));
            }
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
        foldDown("Console", consoleOpen, settings(consoleFields), (open) => (consoleOpen = open)),
        foldDown("Advanced", advancedOpen, settings(advanced), (open) => (advancedOpen = open)),
        others.length > 0 ? otherAttributes(config, others) : "",
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
    vscode.setState({ selected, advancedOpen, consoleOpen });
}

interface Editor {
    set(path: JsonPath, value: unknown): void;
    remove(path: JsonPath): void;
    browse(path: JsonPath, pick: "file" | "folder"): void;
    /** True if the path at `path` does not exist on the extension's host. */
    isMissing(path: JsonPath): boolean;
}

/** A toolbar button showing only a codicon, like in VS Code view title bars. */
function iconButton(icon: string, label: string, onclick: () => void): HTMLButtonElement {
    return h(
        "button",
        { className: "icon toolbar", title: label, "aria-label": label, onclick },
        h("span", { className: `codicon codicon-${icon}`, "aria-hidden": "true" }),
    );
}

/** One attribute, laid out like an entry in the Settings editor. */
function setting(
    field: Field,
    value: unknown,
    canReset: boolean,
    edit: Editor,
    content: Node | (Node | string)[],
): HTMLElement {
    const modified = value !== undefined;
    return h(
        "div",
        { className: modified ? "setting modified" : "setting" },
        h(
            "div",
            { className: "setting-title" },
            h("span", { className: "label" }, field.label),
            h("span", { className: "key" }, field.setting?.section ?? field.key),
            modified && canReset
                ? h(
                      "button",
                      {
                          className: "link",
                          title: field.setting
                              ? "Remove the workspace setting, so the user setting or default is used"
                              : "Remove the attribute, so its default is used",
                          onclick: () => edit.remove(fieldPath(field)),
                      },
                      "Reset",
                  )
                : "",
        ),
        field.kind === "boolean" || !field.description ? "" : h("div", { className: "description" }, field.description),
        ...(Array.isArray(content) ? content : [content]),
    );
}

function control(field: Field, value: unknown, edit: Editor): Node {
    switch (field.kind) {
        case "string":
        case "number":
        case "integer":
        case "stringOrInteger":
            return textInput(field, value, fieldPath(field), edit);
        case "enum":
            return enumInput(field, value, fieldPath(field), edit);
        case "multiEnum":
            return multiSelect(field, value, fieldPath(field), edit);
        case "boolean":
            return checkbox(field, value, fieldPath(field), edit);
        case "objectList":
            return value === undefined || Array.isArray(value) ? objectList(field, value, edit) : unsupported(value);
        default:
            return unsupported(value);
    }
}

/**
 * A text box that writes its value when it loses focus or Enter is pressed.
 * Empty text removes the attribute, unless `emptyError` says it may not be empty.
 */
function textInput(field: Field, value: unknown, path: JsonPath, edit: Editor, emptyError?: string): HTMLElement {
    const shown = value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    const focusKey = `field:${path.join("/")}`;
    const draft = drafts.get(focusKey);
    const input = h("input", {
        type: "text",
        value: draft?.text ?? shown,
        placeholder: field.default === undefined ? "" : String(field.default),
        spellcheck: false,
        "aria-label": field.label,
        "data-focus": focusKey,
    });
    // Before the Enter handler below, which then writes the picked suggestion.
    const combo = field.suggestions ? comboBox(input, field.suggestions) : undefined;
    const message = h("div", { className: "validation", hidden: true });
    const showError = (text: string | undefined) => {
        input.classList.toggle("invalid", text !== undefined);
        message.textContent = text ?? "";
        message.hidden = text === undefined;
        if (text === undefined) {
            drafts.delete(focusKey);
        } else {
            drafts.set(focusKey, { text: input.value, error: text });
        }
    };
    if (draft) {
        showError(draft.error);
    }
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            input.dispatchEvent(new Event("change"));
        }
    });
    input.addEventListener("change", () => {
        const parsed = parseInput(field.kind as FieldKind, input.value);
        if ("error" in parsed) {
            showError(parsed.error);
        } else if ("remove" in parsed) {
            if (emptyError) {
                showError(emptyError);
            } else if (field.required) {
                showError(undefined);
                edit.set(path, "");
            } else if (value !== undefined) {
                showError(undefined);
                edit.remove(path);
            } else {
                showError(undefined);
            }
        } else if (parsed.value !== value) {
            showError(undefined);
            edit.set(path, parsed.value);
        } else {
            showError(undefined);
        }
    });
    // Native dialogs on Linux and Windows cannot offer files and folders at once, hence two buttons.
    const buttons =
        field.browse === "file"
            ? [iconButton("file", "Browse...", () => edit.browse(path, "file"))]
            : field.browse === "fileOrFolder"
              ? [
                    iconButton("file", "Browse for a File...", () => edit.browse(path, "file")),
                    iconButton("folder-opened", "Browse for a Folder...", () => edit.browse(path, "folder")),
                ]
              : [];
    // Problems with the saved value, unlike `message` which is about the text being typed.
    const problem = draft
        ? undefined
        : field.required && (value === undefined || value === "")
          ? "Required"
          : edit.isMissing(path)
            ? "Not found on this host"
            : undefined;
    const controls = [input, ...(combo ? [combo.button] : []), ...buttons];
    const row = controls.length > 1 ? h("div", { className: "input-row" }, ...controls) : input;
    return h(
        "div",
        { className: problem ? "input problem" : "input" },
        combo ? h("div", { className: "combo" }, row, combo.list) : row,
        message,
        problem ? h("div", { className: "validation problem-text" }, problem) : "",
    );
}

let comboCount = 0;

/**
 * Makes `input` a combobox: typing or the arrow button shows the matching
 * suggestions below it. Any other text can still be typed.
 */
function comboBox(input: HTMLInputElement, suggestions: readonly string[]) {
    const id = `combo-${++comboCount}`;
    const list = h("ul", { className: "combo-list", id, role: "listbox", hidden: true });
    let shown: string[] = [];
    let active = -1;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", id);
    input.setAttribute("aria-expanded", "false");
    const highlight = (i: number) => {
        active = i;
        [...list.children].forEach((li, j) => li.classList.toggle("active", j === i));
        const li = list.children[i];
        if (li) {
            li.scrollIntoView({ block: "nearest" });
            input.setAttribute("aria-activedescendant", li.id);
        } else {
            input.removeAttribute("aria-activedescendant");
        }
    };
    const close = () => {
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
        highlight(-1);
    };
    const pick = (s: string) => {
        input.value = s;
        close();
        input.dispatchEvent(new Event("change"));
    };
    const open = (text: string) => {
        shown = filterSuggestions(suggestions, text);
        list.replaceChildren(
            ...shown.map((s, i) =>
                h(
                    "li",
                    {
                        id: `${id}-${i}`,
                        role: "option",
                        className: "combo-option",
                        // Keeps the focus in the text box, so it does not write the typed text first.
                        onmousedown: (e: MouseEvent) => e.preventDefault(),
                        onclick: () => pick(s),
                    },
                    s,
                ),
            ),
        );
        list.hidden = shown.length === 0;
        input.setAttribute("aria-expanded", String(!list.hidden));
        highlight(-1);
    };
    input.addEventListener("input", () => open(input.value));
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (list.hidden) {
                open("");
            }
            if (shown.length > 0) {
                const down = e.key === "ArrowDown";
                highlight(
                    active < 0
                        ? down
                            ? 0
                            : shown.length - 1
                        : (active + (down ? 1 : -1) + shown.length) % shown.length,
                );
            }
        } else if (e.key === "Enter") {
            if (!list.hidden && active >= 0) {
                input.value = shown[active];
            }
            close();
        } else if (e.key === "Escape" && !list.hidden) {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    });
    const button = h(
        "button",
        {
            className: "icon combo-button",
            tabIndex: -1,
            title: "Show suggestions",
            "aria-label": "Show suggestions",
            onmousedown: (e: MouseEvent) => e.preventDefault(),
            onclick: () => {
                if (list.hidden) {
                    input.focus();
                    open("");
                } else {
                    close();
                }
            },
        },
        h("span", { className: "codicon codicon-chevron-down", "aria-hidden": "true" }),
    );
    return { button, list };
}

function enumInput(field: Field, value: unknown, path: JsonPath, edit: Editor): HTMLElement {
    const fallback = field.default === undefined ? "(not set)" : `(default: ${String(field.default)})`;
    const select = h(
        "select",
        { "aria-label": field.label, "data-focus": `field:${path.join("/")}` },
        h("option", { value: "" }, fallback),
        ...(field.values ?? []).map((v, i) =>
            h("option", { value: v, selected: v === value }, field.valueLabels?.[i] ?? v),
        ),
    );
    select.addEventListener("change", () => {
        if (select.value === "") {
            edit.remove(path);
        } else {
            edit.set(path, select.value);
        }
    });
    return select;
}

function checkbox(field: Field, value: unknown, path: JsonPath, edit: Editor): HTMLElement {
    const box = h("input", {
        type: "checkbox",
        checked: typeof value === "boolean" ? value : field.default === true,
        "aria-label": field.label,
        "data-focus": `field:${path.join("/")}`,
        onchange: (e: Event) => edit.set(path, (e.target as HTMLInputElement).checked),
    });
    return h("label", { className: "checkbox" }, box, h("span", {}, field.description ?? field.label));
}

/**
 * A table with one row per list item and one column per item property. If the
 * list is not set, it shows the default items, and the first change stores
 * them, changed, in launch.json.
 */
function objectList(field: Field, value: unknown[] | undefined, edit: Editor): HTMLElement {
    const defaults = value === undefined && Array.isArray(field.default) ? (field.default as unknown[]) : undefined;
    const rows = value ?? defaults ?? [];
    if (defaults) {
        const key = field.key;
        const base = edit;
        edit = {
            ...base,
            set: (path, v) => base.set([key], editList(defaults, path.slice(1), v)),
            remove: (path) => base.set([key], editList(defaults, path.slice(1), undefined)),
        };
    }
    const columns = field.columns ?? [];
    const removeButton = (row: number) =>
        h(
            "button",
            {
                className: "icon",
                title: "Remove item",
                "aria-label": `Remove item ${row + 1}`,
                onclick: () => edit.remove([field.key, row]),
            },
            "\u2715",
        );
    // Flow control messages have no service or name, so a row that selects them gets "*" in its text columns.
    const cellEditor = (column: Field, row: Record<string, unknown>, r: number): Editor => {
        if (column.kind !== "multiEnum") {
            return edit;
        }
        const had = Array.isArray(row[column.key]) && (row[column.key] as unknown[]).includes(FLOW_CONTROL);
        return {
            ...edit,
            set: (path, v) => {
                if (!had && Array.isArray(v) && v.includes(FLOW_CONTROL)) {
                    const any = columns.filter((c) => c.kind === "string").map((c) => [c.key, "*"]);
                    edit.set([field.key, r], { ...row, ...Object.fromEntries(any), [column.key]: v });
                } else {
                    edit.set(path, v);
                }
            },
        };
    };
    const body = rows.map((row, r) => {
        if (typeof row !== "object" || row === null || Array.isArray(row)) {
            return h("tr", {}, h("td", { colSpan: columns.length }, unsupported(row)), h("td", {}, removeButton(r)));
        }
        const values = row as Record<string, unknown>;
        return h(
            "tr",
            {},
            ...columns.map((c) => h("td", {}, cell(c, values[c.key], [field.key, r, c.key], cellEditor(c, values, r)))),
            h("td", {}, removeButton(r)),
        );
    });
    const newRow = {
        ...Object.fromEntries(columns.filter((c) => c.required).map((c) => [c.key, ""])),
        ...field.newItem,
    };
    // Focus the new row, so its empty cells are not marked before the user had a chance to fill them.
    const addItem = () => {
        if (columns.length > 0) {
            pendingFocus = `field:${field.key}/${rows.length}/${columns[0].key}`;
        }
        edit.set([field.key, -1], newRow);
    };
    return h(
        "div",
        { className: "object-list" },
        rows.length > 0
            ? h(
                  "table",
                  {},
                  h(
                      "thead",
                      {},
                      h(
                          "tr",
                          {},
                          ...columns.map((c) =>
                              h("th", { title: c.description ?? "" }, c.required ? `${c.label} *` : c.label),
                          ),
                          h("th", {}),
                      ),
                  ),
                  h("tbody", {}, ...body),
              )
            : h("p", { className: "empty" }, "No items."),
        defaults ? h("div", { className: "description" }, "Default items, used while the attribute is not set.") : "",
        iconButton("add", "Add item", addItem),
    );
}

function cell(column: Field, value: unknown, path: JsonPath, edit: Editor): Node {
    switch (column.kind) {
        case "boolean":
            return checkbox({ ...column, description: "" }, value, path, edit);
        case "enum":
            return enumInput(column, value, path, edit);
        case "multiEnum":
            return multiSelect(column, value, path, edit);
        default:
            return textInput(column, value, path, edit);
    }
}

const FLOW_CONTROL = "flowControl";

/** A dropdown with a checkbox for each value. Without a value, the default is checked. */
function multiSelect(field: Field, value: unknown, path: JsonPath, edit: Editor): HTMLElement {
    const key = `field:${path.join("/")}`;
    const values = field.values ?? [];
    const current = Array.isArray(value) ? value : Array.isArray(field.default) ? field.default : [];
    const selected = current.map(String);
    const label = (v: string) => field.valueLabels?.[values.indexOf(v)] ?? v;
    const options = values.map((v) => {
        const checked = selected.includes(v);
        return h(
            "label",
            { className: "multi-select-option" },
            h("input", {
                type: "checkbox",
                checked,
                disabled: checked && selected.length === 1,
                "data-focus": `${key}/${v}`,
                onchange: (e: Event) =>
                    edit.set(path, toggleChoice(values, selected, v, (e.target as HTMLInputElement).checked)),
            }),
            h("span", {}, label(v)),
        );
    });
    const details = h(
        "details",
        {
            className: "multi-select",
            open: openMultiSelect === key,
            ontoggle: () => {
                if (details.open) {
                    openMultiSelect = key;
                } else if (openMultiSelect === key) {
                    openMultiSelect = undefined;
                }
            },
            onkeydown: (e: KeyboardEvent) => {
                if (e.key === "Escape" && details.open) {
                    details.open = false;
                    details.querySelector("summary")?.focus();
                }
            },
        },
        h(
            "summary",
            { "aria-label": field.label, "data-focus": key, className: Array.isArray(value) ? "" : "default" },
            h(
                "span",
                { className: "multi-select-text", title: selected.map(label).join(", ") },
                selected.map(label).join(", "),
            ),
            h("span", { className: "codicon codicon-chevron-down", "aria-hidden": "true" }),
        ),
        h("div", { className: "multi-select-options" }, ...options),
    );
    return details;
}

function unsupported(value: unknown): HTMLElement {
    return h(
        "div",
        { className: "unsupported" },
        h("code", {}, value === undefined ? "(not set)" : JSON.stringify(value)),
        h(
            "button",
            { className: "link", onclick: () => vscode.postMessage({ type: "openText" }) },
            "Edit in launch.json",
        ),
    );
}

function otherAttributes(config: LaunchConfiguration, keys: string[]): HTMLElement {
    return h(
        "div",
        { className: "setting" },
        h("div", { className: "setting-title" }, h("span", { className: "label" }, "Other Attributes")),
        h("div", { className: "description" }, "Attributes this form does not know about."),
        ...keys.map((k) =>
            h("div", { className: "other" }, h("span", { className: "key" }, k), unsupported(config.values[k])),
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

interface SavedFocus {
    key: string;
    value?: string;
    start?: number | null;
    end?: number | null;
}

/** Remembers the focused control, so a new render does not take the focus away. */
function saveFocus(): SavedFocus | undefined {
    const el = document.activeElement;
    const key = el instanceof HTMLElement ? el.dataset.focus : undefined;
    if (!key) {
        return undefined;
    }
    if (el instanceof HTMLInputElement && el.type === "text") {
        return { key, value: el.value, start: el.selectionStart, end: el.selectionEnd };
    }
    return { key };
}

function restoreFocus(saved: SavedFocus | undefined): void {
    const key = pendingFocus ?? saved?.key;
    pendingFocus = undefined;
    const el = key ? app.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`) : null;
    if (!el) {
        return;
    }
    if (el instanceof HTMLInputElement && saved && saved.key === key && saved.value !== undefined) {
        el.value = saved.value;
        el.setSelectionRange(saved.start ?? null, saved.end ?? null);
    }
    el.focus();
}

type Child = Node | string;

/** Creates an element. Properties starting with "on" are event handlers. */
function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, unknown> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined) {
            continue;
        }
        if (key.startsWith("on") && typeof value === "function") {
            el.addEventListener(key.slice(2), value as EventListener);
        } else if (key.includes("-")) {
            el.setAttribute(key, String(value));
        } else {
            (el as unknown as Record<string, unknown>)[key] = value;
        }
    }
    el.append(...children.filter((c) => c !== ""));
    return el;
}
