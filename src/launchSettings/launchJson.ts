import {
    Edit,
    FormattingOptions,
    JSONPath,
    Node,
    ParseError,
    applyEdits,
    findNodeAtLocation,
    getNodeValue,
    modify,
    parseTree,
    printParseErrorCode,
} from "jsonc-parser";

/*
 * Reads and edits the simics-target-debug configurations in the text of a launch.json
 * file. Changes are returned as small text edits, so comments, formatting and
 * all other content of the file are kept.
 */

export const DEBUG_TYPE = "simics-target-debug";

export interface LaunchConfiguration {
    /** Position in the "configurations" list, edits refer to it. */
    index: number;
    name: string;
    /** The attributes as written in the file. */
    values: Record<string, unknown>;
}

export type ReadResult =
    { configurations: LaunchConfiguration[]; error?: undefined } | { configurations?: undefined; error: string };

/** Lists the simics-target-debug configurations, or describes why the text cannot be read. */
export function readConfigurations(text: string): ReadResult {
    const doc = parse(text);
    if (typeof doc === "string") {
        return { error: doc };
    }
    const configurations: LaunchConfiguration[] = [];
    doc.items.forEach((node, index) => {
        const values = nodeValue(node);
        if (isTcfConfiguration(values)) {
            configurations.push({ index, name: typeof values.name === "string" ? values.name : "", values });
        }
    });
    return { configurations };
}

/**
 * Sets an attribute of the configuration at `index`, or removes it if
 * `value` is undefined. `path` can go into lists and objects, for example
 * ['pathMap', 0, 'source']. Objects left empty by a removal are removed too.
 */
export function setValue(
    text: string,
    index: number,
    path: JSONPath,
    value: unknown,
    formatting: FormattingOptions,
): Edit[] {
    if (path.length === 0) {
        throw new Error("No attribute given");
    }
    const { values } = tcfItem(text, index);
    if (value === undefined) {
        const fullPath = ["configurations", index, ...removalPath(values, path)];
        return modify(text, fullPath, undefined, {}).map((edit) => withLineComment(text, edit));
    }
    return modify(text, ["configurations", index, ...path], value, { formattingOptions: formatting });
}

/** `path`, or the outermost object that has nothing else in it. */
function removalPath(values: Record<string, unknown>, path: JSONPath): JSONPath {
    let target = path;
    while (target.length > 1 && typeof target[target.length - 1] === "string") {
        let parent: unknown = values;
        for (const key of target.slice(0, -1)) {
            parent =
                typeof parent === "object" && parent !== null ? (parent as Record<string, unknown>)[key] : undefined;
        }
        if (
            typeof parent !== "object" ||
            parent === null ||
            Array.isArray(parent) ||
            Object.keys(parent).join() !== String(target[target.length - 1])
        ) {
            break;
        }
        target = target.slice(0, -1);
    }
    return target;
}

/** Updates only the uniquely named TCF configuration's path map. */
export function setPathMapRules(
    text: string,
    configName: string,
    rules: readonly {
        source: string;
        destination: string;
        context?: string;
        contextQuery?: string;
    }[],
    append = false,
): Edit[] {
    const config = namedConfiguration(text, configName);
    const existing = config.values.pathMap;
    if (append && Array.isArray(existing) && rules.length === 1) {
        return setValue(text, config.index, ["pathMap", existing.length], rules[0], detectFormatting(text));
    }
    return setValue(
        text,
        config.index,
        ["pathMap"],
        append && Array.isArray(existing) ? [...existing, ...rules] : rules,
        detectFormatting(text),
    );
}

/** Sets `key`, or the attribute at a path such as ["consoles", "simicsCli", "open"]; undefined removes it. */
export function setNamedConfigurationValue(
    text: string,
    configName: string,
    key: string | JSONPath,
    value: unknown,
): Edit[] {
    const config = namedConfiguration(text, configName);
    return setValue(text, config.index, typeof key === "string" ? [key] : key, value, detectFormatting(text));
}

function namedConfiguration(text: string, configName: string): LaunchConfiguration {
    const read = readConfigurations(text);
    if (read.error !== undefined) {
        throw new Error(read.error);
    }
    const matches = read.configurations.filter((c) => c.name === configName);
    if (matches.length !== 1) {
        throw new Error(
            `Expected one TCF configuration named "${configName}" in ` +
                "launch.json. Give the configuration a unique name.",
        );
    }
    return matches[0];
}

/**
 * Adds a configuration at the end of the list. The type is set to simics-target-debug
 * and the name is made unique. Returns the edits and the new index.
 */
export function addConfiguration(
    text: string,
    config: Record<string, unknown>,
    formatting: FormattingOptions,
): { edits: Edit[]; index: number } {
    const doc = parseOrThrow(text);
    const name = uniqueName(typeof config.name === "string" ? config.name : DEBUG_TYPE, allNames(doc.items));
    const value = { type: DEBUG_TYPE, ...config, name };
    value.type = DEBUG_TYPE;
    if (text.trim().length === 0) {
        const content = JSON.stringify(
            { version: "0.2.0", configurations: [value] },
            null,
            formatting.insertSpaces === false ? "\t" : " ".repeat(formatting.tabSize ?? 4),
        );
        const eol = formatting.eol ?? "\n";
        return { edits: [{ offset: 0, length: text.length, content: content.replace(/\n/g, eol) + eol }], index: 0 };
    }
    const edits = modify(text, ["configurations", -1], value, { formattingOptions: formatting });
    return { edits, index: doc.items.length };
}

/** Inserts a copy of the configuration at `index` after it, with a unique name. */
export function duplicateConfiguration(
    text: string,
    index: number,
    formatting: FormattingOptions,
): { edits: Edit[]; index: number } {
    const { doc, values } = tcfItem(text, index);
    const base = typeof values.name === "string" ? values.name : DEBUG_TYPE;
    const value = { ...values, name: uniqueName(base, allNames(doc.items)) };
    const edits = modify(text, ["configurations", index + 1], value, {
        formattingOptions: formatting,
        isArrayInsertion: true,
    });
    return { edits, index: index + 1 };
}

export function removeConfiguration(text: string, index: number, formatting: FormattingOptions): Edit[] {
    tcfItem(text, index);
    return modify(text, ["configurations", index], undefined, { formattingOptions: formatting });
}

/** Removes the configurations at `indexes`, as one edit. */
export function removeConfigurations(text: string, indexes: number[], formatting: FormattingOptions): Edit[] {
    let result = text;
    // From the last one, so the positions of the others do not change.
    for (const index of [...new Set(indexes)].sort((a, b) => b - a)) {
        result = applyEdits(result, removeConfiguration(result, index, formatting));
    }
    return result === text ? [] : [changedPart(text, result)];
}

/** Returns `base`, or `base (2)`, `base (3)`, ... if that name is taken. */
export function uniqueName(base: string, taken: Iterable<string>): string {
    const names = new Set(taken);
    if (!names.has(base)) {
        return base;
    }
    let n = 2;
    while (names.has(`${base} (${n})`)) {
        n++;
    }
    return `${base} (${n})`;
}

/** Guesses the indentation and line endings of the file, so edits match it. */
export function detectFormatting(text: string): FormattingOptions {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    // Only lines starting with JSON content, comment lines may be indented oddly.
    const indents = text
        .split(/\r?\n/)
        .map((line) => /^([ \t]+)["{}[\]]/.exec(line)?.[1])
        .filter((indent): indent is string => indent !== undefined);
    if (indents.some((indent) => indent.startsWith("\t"))) {
        return { insertSpaces: false, tabSize: 4, eol };
    }
    const tabSize = indents.length > 0 ? Math.min(...indents.map((indent) => indent.length)) : 4;
    return { insertSpaces: true, tabSize, eol };
}

interface ParsedDocument {
    items: Node[];
}

function isTcfConfiguration(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).type === DEBUG_TYPE
    );
}

function parse(text: string): ParsedDocument | string {
    if (text.trim().length === 0) {
        return { items: [] };
    }
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
        const e = errors[0];
        return `${printParseErrorCode(e.error)} on line ${text.slice(0, e.offset).split("\n").length}`;
    }
    if (root?.type !== "object") {
        return "launch.json must contain a JSON object";
    }
    const list = findNodeAtLocation(root, ["configurations"]);
    if (list === undefined) {
        return { items: [] };
    }
    if (list.type !== "array") {
        return '"configurations" must be a list';
    }
    return { items: list.children ?? [] };
}

function parseOrThrow(text: string): ParsedDocument {
    const doc = parse(text);
    if (typeof doc === "string") {
        throw new Error(`Cannot change launch.json: ${doc}`);
    }
    return doc;
}

/** The parsed document and the values of the simics-target-debug configuration at `index`. */
function tcfItem(text: string, index: number): { doc: ParsedDocument; values: Record<string, unknown> } {
    const doc = parseOrThrow(text);
    const values = doc.items[index] && nodeValue(doc.items[index]);
    if (!isTcfConfiguration(values)) {
        throw new Error(`launch.json has no ${DEBUG_TYPE} configuration at position ${index}`);
    }
    return { doc, values };
}

/** Names of all configurations, of any type, as all share the Run and Debug list. */
function allNames(items: Node[]): string[] {
    return items
        .map((node) => findNodeAtLocation(node, ["name"])?.value)
        .filter((name): name is string => typeof name === "string");
}

/** The value of a node as plain objects (getNodeValue makes objects without prototype). */
function nodeValue(node: Node): unknown {
    return JSON.parse(JSON.stringify(getNodeValue(node)));
}

/** One edit that turns `before` into `after`, replacing only the text that differs. */
function changedPart(before: string, after: string): Edit {
    const max = Math.min(before.length, after.length);
    let start = 0;
    while (start < max && before[start] === after[start]) {
        start++;
    }
    let end = 0;
    while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
        end++;
    }
    return { offset: start, length: before.length - start - end, content: after.slice(start, after.length - end) };
}

/**
 * Makes a removal also remove a // comment that follows the removed value on
 * the same line, otherwise the comment ends up after the previous property.
 */
function withLineComment(text: string, edit: Edit): Edit {
    const end = edit.offset + edit.length;
    const m = /^(,?)[ \t]*\/\/[^\r\n]*/.exec(text.slice(end));
    if (edit.content !== "" || !m) {
        return edit;
    }
    return { offset: edit.offset, length: edit.length + m[0].length, content: m[1] };
}
