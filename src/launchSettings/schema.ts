/*
 * Builds the fields of the launch configurations form from the debugger's
 * "configurationAttributes" in package.json, so new attributes show up in the
 * form without UI changes. No vscode or Node.js imports: the webview uses
 * this file too.
 */

export type FieldKind =
    | "string"
    | "enum"
    | "multiEnum"
    | "number"
    | "integer"
    | "boolean"
    | "stringOrInteger"
    | "objectList"
    | "unsupported";

export type FieldGroup = "console" | "advanced";

export interface Field {
    key: string;
    /** Where the attribute is, for attributes inside objects. Their key is the path joined by dots. */
    path?: string[];
    label: string;
    kind: FieldKind;
    description?: string;
    default?: unknown;
    required?: boolean;
    /** Allowed values of an 'enum' field, or of the items of a 'multiEnum' field. */
    values?: string[];
    /** Text to show for each of `values`, if not the values themselves. */
    valueLabels?: string[];
    /** The properties of the objects in an 'objectList' field. */
    columns?: Field[];
    /** The item an 'objectList' field gets when one is added, from the "default" of its items. */
    newItem?: Record<string, unknown>;
    /** Values a 'string' field offers in a dropdown, from "examples". Other text is allowed too. */
    suggestions?: string[];
    /**
     * What a path field may be set to with Browse buttons, from "format" in
     * package.json: "file-path" or "file-or-folder-path". The latter is a
     * path on this host, the form warns if it does not exist.
     */
    browse?: "file" | "fileOrFolder";
    /** Set for fields the form shows last, in a fold-down that is closed at first. */
    group?: FieldGroup;
    /**
     * Set for fields stored in a VS Code setting of the workspace instead of
     * launch.json. With `invert`, the field shows the opposite boolean value.
     */
    setting?: { section: string; invert?: boolean };
}

/*
 * VS Code adds its general launch attributes (type, request, name,
 * preLaunchTask, ...) to every debugger's attributes at run time, also in the
 * object extensions get as packageJSON. To keep the form simple, these are not
 * shown: the form has its own name field, and the others are fixed or rarely
 * needed. They can still be set in the text of launch.json.
 */
const HIDDEN_KEYS = new Set([
    "type",
    "request",
    "name",
    "debugServer",
    "preLaunchTask",
    "postDebugTask",
    "presentation",
    "suppressMultipleSessionWarning",
]);

/** VS Code's general attributes that the form does show, with plain descriptions. */
export const VSCODE_FIELDS: Field[] = [
    {
        key: "internalConsoleOptions",
        label: "Debug Console",
        kind: "enum",
        values: ["neverOpen", "openOnSessionStart", "openOnFirstSessionStart"],
        valueLabels: ["Never", "When each session starts", "When the first session starts"],
        description:
            "When to open the Debug Console: never, every time a session starts, or only " +
            "when the first session starts. If not set, the setting debug.internalConsoleOptions decides. " +
            "Not used while Open Console is on: the Debug Console then never opens.",
    },
];

const VSCODE_KEYS = new Set(VSCODE_FIELDS.map((f) => f.key));

/** Fields stored in VS Code settings, the same for all configurations. */
export const SETTING_FIELDS: Field[] = [
    {
        key: "stayInConsole",
        label: "Stay in Console",
        kind: "boolean",
        default: false,
        setting: { section: "debug.focusEditorOnBreak", invert: true },
        description:
            "Keep the focus in the Simics CLI when the target stops, so that Enter repeats the command. " +
            "Sets debug.focusEditorOnBreak for the workspace.",
    },
];

/** The fold-downs, in this order, with their fields in order and shorter labels under the heading. */
const GROUPS: { group: FieldGroup; keys: string[]; labels?: Record<string, string> }[] = [
    {
        group: "console",
        keys: [
            "consoles.simicsCli.open",
            "consoles.simicsCli.historySessions",
            "consoles.simicsCli.editingKeys",
            "stayInConsole",
        ],
        labels: {
            "consoles.simicsCli.open": "Open Console",
            "consoles.simicsCli.historySessions": "History Sessions",
            "consoles.simicsCli.editingKeys": "Editing Keys",
        },
    },
    {
        group: "advanced",
        keys: ["connectTimeout", "disassemblyFunctionHeaders", "internalConsoleOptions", "traceTcf", "traceTcfSilence"],
    },
];

/** List attributes whose default is used when they are not set. Other list defaults are only completion templates. */
const LIST_DEFAULT_KEYS = new Set(["traceTcfSilence"]);

const GROUPED_KEYS = new Set(GROUPS.flatMap((g) => g.keys));

/**
 * The fields of an "attach" configuration of `debugType`: its own attributes
 * in package.json order, then the grouped ones.
 */
export function launchFields(packageJson: unknown, debugType: string): Field[] {
    const attach = debugger_(packageJson, debugType)?.configurationAttributes?.attach;
    const properties = attach?.properties;
    if (!isObject(properties)) {
        return [];
    }
    const own = attributeFields(properties, attach?.required).filter(
        (f) => !HIDDEN_KEYS.has(f.key) && !VSCODE_KEYS.has(f.key),
    );
    const all = [...own, ...VSCODE_FIELDS, ...SETTING_FIELDS];
    const grouped = GROUPS.flatMap(({ group, keys, labels }) =>
        keys
            .flatMap((k) => all.filter((f) => f.key === k))
            .map((f) => ({ ...f, group, label: labels?.[f.key] ?? f.label })),
    );
    return [...all.filter((f) => !GROUPED_KEYS.has(f.key)), ...grouped];
}

/** The configuration used for "Add configuration": the first initial configuration. */
export function launchTemplate(packageJson: unknown, debugType: string): Record<string, unknown> {
    const initial = debugger_(packageJson, debugType)?.initialConfigurations;
    if (Array.isArray(initial) && isObject(initial[0])) {
        return { ...initial[0] };
    }
    return { type: debugType, request: "attach", name: debugType };
}

export function fieldsFromSchema(properties: Record<string, unknown>, required: unknown = []): Field[] {
    const requiredKeys = Array.isArray(required) ? required : [];
    return Object.entries(properties).map(([key, schema]) =>
        field(key, isObject(schema) ? schema : {}, requiredKeys.includes(key)),
    );
}

/** Like fieldsFromSchema, but with one field for each attribute inside an object attribute. */
function attributeFields(properties: Record<string, unknown>, required: unknown, parent: string[] = []): Field[] {
    return fieldsFromSchema(properties, required).flatMap((f) => {
        const schema = properties[f.key] as Schema;
        const path = [...parent, f.key];
        if (schema?.type === "object" && isObject(schema.properties)) {
            return attributeFields(schema.properties, schema.required, path);
        }
        return parent.length > 0 ? [{ ...f, key: path.join("."), path }] : [f];
    });
}

/** Where the field's value is in a configuration. */
export function fieldPath(f: Field): string[] {
    return f.path ?? [f.key];
}

/** The value at `path` in `values`, if there is one. */
export function valueAtPath(values: unknown, path: readonly (string | number)[]): unknown {
    let v = values;
    for (const key of path) {
        if (typeof v !== "object" || v === null) {
            return undefined;
        }
        v = (v as Record<string | number, unknown>)[key];
    }
    return v;
}

export type ParsedInput = { value: unknown } | { remove: true } | { error: string };

/**
 * A copy of `rows` with `value` at `path` (an item index, then optionally an
 * item property), or without it if `value` is undefined. Index -1 appends.
 */
export function editList(rows: readonly unknown[], path: readonly (string | number)[], value: unknown): unknown[] {
    const copy = rows.map((r) => (isObject(r) ? { ...r } : r));
    const [index, key] = path;
    if (typeof index !== "number") {
        return copy;
    }
    if (key === undefined) {
        if (value === undefined) {
            copy.splice(index, 1);
        } else if (index === -1) {
            copy.push(value);
        } else {
            copy[index] = value;
        }
    } else {
        const row = copy[index];
        if (isObject(row)) {
            if (value === undefined) {
                delete row[key];
            } else {
                row[key] = value;
            }
        }
    }
    return copy;
}

/**
 * The choices of a 'multiEnum' field after `value` is checked or unchecked, in
 * the order of `values`. "*" (all) excludes the others. The last choice cannot
 * be unchecked.
 */
export function toggleChoice(
    values: readonly string[],
    selected: readonly string[],
    value: string,
    on: boolean,
): string[] {
    if (!on) {
        const rest = selected.filter((v) => v !== value);
        return rest.length > 0 ? rest : [...selected];
    }
    if (value === "*") {
        return ["*"];
    }
    const next = new Set([...selected.filter((v) => v !== "*"), value]);
    return values.filter((v) => next.has(v));
}

/**
 * Converts the text typed into a field to the value to store. An empty text
 * removes the attribute, so its default applies.
 */
export function parseInput(kind: FieldKind, text: string): ParsedInput {
    const t = text.trim();
    if (t.length === 0) {
        return { remove: true };
    }
    switch (kind) {
        case "number": {
            const n = Number(t);
            return Number.isFinite(n) ? { value: n } : { error: "Enter a number" };
        }
        case "integer": {
            const n = Number(t);
            return Number.isSafeInteger(n) ? { value: n } : { error: "Enter a whole number" };
        }
        case "stringOrInteger": {
            const n = Number(t);
            return /^\d+$/.test(t) && Number.isSafeInteger(n) ? { value: n } : { value: t };
        }
        default:
            return { value: text };
    }
}

/**
 * The suggestions that contain `text`, ignoring case, those starting with it
 * first. All of them for an empty text.
 */
export function filterSuggestions(suggestions: readonly string[], text: string): string[] {
    const t = text.trim().toLowerCase();
    if (t.length === 0) {
        return [...suggestions];
    }
    const matching = suggestions.filter((s) => s.toLowerCase().includes(t));
    return [
        ...matching.filter((s) => s.toLowerCase().startsWith(t)),
        ...matching.filter((s) => !s.toLowerCase().startsWith(t)),
    ];
}

/** "connectTimeout" -> "Connect Timeout", "traceTcf" -> "Trace TCF". */
export function labelFor(key: string): string {
    return key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[\s_-]+/)
        .map((word) =>
            ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
        )
        .join(" ");
}

const ACRONYMS = new Set(["tcf", "id", "ip", "url", "elf"]);

interface Schema {
    type?: unknown;
    description?: unknown;
    markdownDescription?: unknown;
    default?: unknown;
    enum?: unknown;
    enumItemLabels?: unknown;
    examples?: unknown;
    format?: unknown;
    items?: unknown;
    properties?: unknown;
    required?: unknown;
}

function field(key: string, schema: Schema, required: boolean): Field {
    const description =
        typeof schema.description === "string"
            ? schema.description
            : typeof schema.markdownDescription === "string"
              ? schema.markdownDescription
              : undefined;
    const f: Field = { key, label: labelFor(key), kind: kindOf(schema), description, default: schema.default };
    if (required) {
        f.required = true;
    }
    if (f.kind === "string" && schema.format === "file-path") {
        f.browse = "file";
    }
    if (f.kind === "string" && schema.format === "file-or-folder-path") {
        f.browse = "fileOrFolder";
    }
    if (f.kind === "string" && Array.isArray(schema.examples)) {
        f.suggestions = schema.examples.map(String);
    }
    if (f.kind === "enum") {
        f.values = (schema.enum as unknown[]).map(String);
        f.valueLabels = itemLabels(schema, f.values);
    }
    if (f.kind === "multiEnum") {
        const items = schema.items as Schema;
        f.values = (items.enum as unknown[]).map(String);
        f.valueLabels = itemLabels(items, f.values);
    }
    if (f.kind === "objectList") {
        const items = schema.items as Schema;
        f.columns = fieldsFromSchema(items.properties as Record<string, unknown>, items.required);
        if (isObject(items.default)) {
            f.newItem = items.default;
        }
        if (!LIST_DEFAULT_KEYS.has(key)) {
            delete f.default;
        }
    }
    return f;
}

/** The "enumItemLabels" of an enum schema, if there is one label for each value. */
function itemLabels(schema: Schema, values: string[]): string[] | undefined {
    const labels = schema.enumItemLabels;
    return Array.isArray(labels) && labels.length === values.length ? labels.map(String) : undefined;
}

function kindOf(schema: Schema): FieldKind {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((t) => t !== "null");
    if (types.length === 1) {
        switch (types[0]) {
            case "string":
                return Array.isArray(schema.enum) ? "enum" : "string";
            case "number":
            case "integer":
            case "boolean":
                return types[0] as FieldKind;
            case "array": {
                const items = isObject(schema.items) ? (schema.items as Schema) : undefined;
                if (items?.type === "string" && Array.isArray(items.enum)) {
                    return "multiEnum";
                }
                if (
                    items?.type === "object" &&
                    isObject(items.properties) &&
                    fieldsFromSchema(items.properties).every((c) => SIMPLE_KINDS.has(c.kind))
                ) {
                    return "objectList";
                }
                return "unsupported";
            }
        }
    }
    if (types.length === 2 && types.includes("string") && types.includes("integer")) {
        return "stringOrInteger";
    }
    return "unsupported";
}

const SIMPLE_KINDS = new Set<FieldKind>([
    "string",
    "enum",
    "multiEnum",
    "number",
    "integer",
    "boolean",
    "stringOrInteger",
]);

interface DebuggerContribution {
    type?: unknown;
    configurationAttributes?: { attach?: { properties?: unknown; required?: unknown } };
    initialConfigurations?: unknown;
}

function debugger_(packageJson: unknown, debugType: string): DebuggerContribution | undefined {
    const debuggers = (packageJson as { contributes?: { debuggers?: unknown } })?.contributes?.debuggers;
    return Array.isArray(debuggers)
        ? debuggers.find((d): d is DebuggerContribution => isObject(d) && d.type === debugType)
        : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
