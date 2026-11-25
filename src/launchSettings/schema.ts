/*
 * Builds the fields of the launch configurations form from the debugger's
 * "configurationAttributes" in package.json, so new attributes show up in the
 * form without UI changes. No vscode or Node.js imports: the webview uses
 * this file too.
 */

import type { ContextScope } from "@/contextChoices";

export type FieldKind =
    | "string"
    | "enum"
    | "number"
    | "integer"
    | "boolean"
    | "stringOrInteger"
    | "objectList"
    | "contextScope"
    | "unsupported";

export interface Field {
    key: string;
    /** Where the attribute is, for attributes inside objects. Their key is the path joined by dots. */
    path?: string[];
    label: string;
    kind: FieldKind;
    description?: string;
    default?: unknown;
    required?: boolean;
    /** Allowed values of an 'enum' field. */
    values?: string[];
    /** Text to show for each of `values`, if not the values themselves. */
    valueLabels?: string[];
    /**
     * The properties of the objects in an 'objectList' field. Objects with
     * "contexts" (a list of strings) and "contextQuery" have one
     * 'contextScope' column for both, see readContextScope.
     */
    columns?: Field[];
    /**
     * What a path field may be set to with Browse buttons, from "format" in
     * package.json: "file-path" or "file-or-folder-path". The latter is a
     * path on this host, the form warns if it does not exist.
     */
    browse?: "file" | "fileOrFolder";
    /** Set for fields the form shows last, in a fold-down that is closed at first. */
    group?: "advanced";
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
            "Not used while the setting simics-target-debug.console.open is on: the Debug Console then never opens.",
    },
];

const VSCODE_KEYS = new Set(VSCODE_FIELDS.map((f) => f.key));

/** The attributes in the Advanced fold-down, in this order. */
const ADVANCED_KEYS = ["connectTimeout", "internalConsoleOptions"];

/**
 * The fields of an "attach" configuration of `debugType`: its own attributes
 * in package.json order, then the advanced ones.
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
    const all = [...own, ...VSCODE_FIELDS];
    const advanced = ADVANCED_KEYS.flatMap((k) => all.filter((f) => f.key === k)).map((f) => ({
        ...f,
        group: "advanced" as const,
    }));
    return [...all.filter((f) => !ADVANCED_KEYS.includes(f.key)), ...advanced];
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

/** host:port of the agent a configuration connects to, with the same defaults as the debug session. */
export function agentAddress(values: Record<string, unknown>): string {
    const { host, port } = values;
    return `${String(host ?? "localhost")}:${String(port ?? 1534)}`;
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
    format?: unknown;
    items?: unknown;
    properties?: unknown;
    required?: unknown;
    deprecationMessage?: unknown;
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
    if (f.kind === "enum") {
        f.values = (schema.enum as unknown[]).map(String);
    }
    if (f.kind === "objectList") {
        const items = schema.items as Schema;
        f.columns = objectColumns(items.properties as Record<string, unknown>, items.required);
        // A list default in package.json is only a completion template.
        delete f.default;
    }
    return f;
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
                if (
                    items?.type === "object" &&
                    isObject(items.properties) &&
                    objectColumns(items.properties).every((c) => COLUMN_KINDS.has(c.kind))
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

const COLUMN_KINDS = new Set<FieldKind>([
    "string",
    "enum",
    "number",
    "integer",
    "boolean",
    "stringOrInteger",
    "contextScope",
]);

/** The keys of the attributes a 'contextScope' column edits. "context" is the deprecated single context. */
const CONTEXT_SCOPE_KEYS = ["contexts", "contextQuery", "context"];

/**
 * The columns of an object list: one per property, except deprecated ones,
 * and with one 'contextScope' column for "contexts" and "contextQuery".
 */
function objectColumns(properties: Record<string, unknown>, required: unknown = []): Field[] {
    const contexts = properties.contexts as Schema | undefined;
    const hasScope =
        contexts?.type === "array" &&
        (contexts.items as Schema | undefined)?.type === "string" &&
        (properties.contextQuery as Schema | undefined)?.type === "string";
    return fieldsFromSchema(properties, required).flatMap((f) => {
        if ((properties[f.key] as Schema | undefined)?.deprecationMessage !== undefined) {
            return [];
        }
        if (hasScope && f.key === "contextQuery") {
            return [];
        }
        if (hasScope && f.key === "contexts") {
            return [{ ...f, kind: "contextScope" as const }];
        }
        return [f];
    });
}

/** The contexts or context query of a list item with a 'contextScope' column. */
export function readContextScope(item: unknown): ContextScope {
    const v = isObject(item) ? item : {};
    if (typeof v.contextQuery === "string" && v.contextQuery.length > 0) {
        return { contextQuery: v.contextQuery };
    }
    if (Array.isArray(v.contexts)) {
        return { contexts: v.contexts.filter((c): c is string => typeof c === "string" && c.length > 0) };
    }
    return { contexts: typeof v.context === "string" && v.context.length > 0 ? [v.context] : [] };
}

/**
 * The list item with its scope attributes replaced by `scope`, where the
 * first of them was, else after "path", else last. All contexts leaves them
 * out.
 */
export function withContextScope(item: Record<string, unknown>, scope: ContextScope): Record<string, unknown> {
    const attributes: Record<string, unknown> =
        "contextQuery" in scope
            ? { contextQuery: scope.contextQuery }
            : scope.contexts.length > 0
              ? { contexts: scope.contexts }
              : {};
    const keys = Object.keys(item);
    const after = keys.find((k) => CONTEXT_SCOPE_KEYS.includes(k)) ?? (keys.includes("path") ? "path" : undefined);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
        if (!CONTEXT_SCOPE_KEYS.includes(key)) {
            result[key] = value;
        }
        if (key === after) {
            Object.assign(result, attributes);
        }
    }
    return after === undefined ? { ...result, ...attributes } : result;
}

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
