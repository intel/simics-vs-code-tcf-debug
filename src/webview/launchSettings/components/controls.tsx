import * as React from "react";
import type { JsonPath } from "@/launchSettings/protocol";
import { type ContextScope, parseContextList } from "@/contextChoices";
import {
    type Field,
    type FieldKind,
    fieldPath,
    parseInput,
    readContextScope,
    withContextScope,
} from "@/launchSettings/schema";

/*
 * The inputs of the launch configurations form, laid out like the Settings
 * editor. They show values and report changes through an Editor, they keep
 * no data except what the user is typing.
 */

export interface Editor {
    set(path: JsonPath, value: unknown): void;
    remove(path: JsonPath): void;
    browse(path: JsonPath, pick: "file" | "folder"): void;
    /** True if the path at `path` does not exist on the extension's host. */
    isMissing(path: JsonPath): boolean;
    /** Opens launch.json as text, for values the form cannot edit. */
    openText(): void;
    /** Picks the contexts of the list item at `path` from the running session. */
    pickContexts(path: JsonPath): void;
    /** True if a session runs to the configuration's agent, so that pickContexts can list its contexts. */
    canPickContexts: boolean;
}

/** The data-focus key of a control to focus when the next state is shown. */
let pendingFocus: string | undefined;

/** Focuses the control with data-focus `key` when it is shown, for example in a row not added yet. */
export function focusLater(key: string): void {
    pendingFocus = key;
}

/** Focuses the control asked for with focusLater, if it is shown now. */
export function applyFocusLater(): void {
    const key = pendingFocus;
    pendingFocus = undefined;
    if (key) {
        document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)?.focus();
    }
}

function focusKey(path: JsonPath): string {
    return `field:${path.join("/")}`;
}

/** A toolbar button showing only a codicon, like in VS Code view title bars. */
export function IconButton(props: {
    icon: string;
    label: string;
    onClick(): void;
    /** The tooltip, if not the label. */
    title?: string;
    disabled?: boolean;
    className?: string;
}) {
    return (
        <button
            className={props.className ? `icon toolbar ${props.className}` : "icon toolbar"}
            title={props.title ?? props.label}
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <span className={`codicon codicon-${props.icon}`} aria-hidden="true" />
        </button>
    );
}

/** One attribute, laid out like an entry in the Settings editor. */
export function Setting(props: {
    field: Field;
    value: unknown;
    edit: Editor;
    canReset?: boolean;
    children: React.ReactNode;
}) {
    const { field } = props;
    const modified = props.value !== undefined;
    return (
        <div className={modified ? "setting modified" : "setting"}>
            <div className="setting-title">
                <span className="label">{field.label}</span>
                <span className="key">{field.key}</span>
                {modified && props.canReset !== false && (
                    <button
                        className="link"
                        title="Remove the attribute, so its default is used"
                        onClick={() => props.edit.remove(fieldPath(field))}
                    >
                        Reset
                    </button>
                )}
            </div>
            {field.kind !== "boolean" && field.description && <div className="description">{field.description}</div>}
            {props.children}
        </div>
    );
}

export function Control({ field, value, edit }: { field: Field; value: unknown; edit: Editor }) {
    const path = fieldPath(field);
    switch (field.kind) {
        case "string":
        case "number":
        case "integer":
        case "stringOrInteger":
            return <TextInput field={field} value={value} path={path} edit={edit} />;
        case "enum":
            return <EnumInput field={field} value={value} path={path} edit={edit} />;
        case "boolean":
            return <Checkbox field={field} value={value} path={path} edit={edit} />;
        case "objectList":
            return value === undefined || Array.isArray(value) ? (
                <ObjectList field={field} value={value} edit={edit} />
            ) : (
                <Unsupported value={value} edit={edit} />
            );
        default:
            return <Unsupported value={value} edit={edit} />;
    }
}

interface InputProps {
    field: Field;
    value: unknown;
    path: JsonPath;
    edit: Editor;
}

/**
 * A text box that writes its value when it loses focus or Enter is pressed.
 * Empty text removes the attribute, unless `emptyError` says it may not be
 * empty.
 */
export function TextInput({ field, value, path, edit, emptyError }: InputProps & { emptyError?: string }) {
    const shown = value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    const [text, setText] = React.useState(shown);
    /** Why the typed text was not written. */
    const [error, setError] = React.useState<string>();
    const input = React.useRef<HTMLInputElement>(null);
    /** The text written last, so leaving the box after Enter does not write it again. */
    const written = React.useRef<string>(undefined);
    // A new saved value replaces the text, unless it is being typed or was refused.
    React.useEffect(() => {
        written.current = undefined;
        if (error === undefined && document.activeElement !== input.current) {
            setText(shown);
        }
    }, [shown]);

    const write = (t: string) => {
        written.current = t;
        const parsed = parseInput(field.kind as FieldKind, t);
        if ("error" in parsed) {
            setError(parsed.error);
        } else if ("remove" in parsed) {
            setError(emptyError);
            if (emptyError) {
                return;
            }
            if (field.required) {
                edit.set(path, "");
            } else if (value !== undefined) {
                edit.remove(path);
            }
        } else {
            setError(undefined);
            if (parsed.value !== value) {
                edit.set(path, parsed.value);
            }
        }
    };

    // Native dialogs on Linux and Windows cannot offer files and folders at once, hence two buttons.
    const buttons =
        field.browse === "file" ? (
            <IconButton icon="file" label="Browse..." onClick={() => edit.browse(path, "file")} />
        ) : field.browse === "fileOrFolder" ? (
            <>
                <IconButton icon="file" label="Browse for a File..." onClick={() => edit.browse(path, "file")} />
                <IconButton
                    icon="folder-opened"
                    label="Browse for a Folder..."
                    onClick={() => edit.browse(path, "folder")}
                />
            </>
        ) : undefined;
    // Problems with the saved value, unlike `error` which is about the text typed.
    const problem =
        error !== undefined
            ? undefined
            : field.required && (value === undefined || value === "")
              ? "Required"
              : edit.isMissing(path)
                ? "Not found on this host"
                : undefined;

    const box = (
        <input
            ref={input}
            type="text"
            className={error === undefined ? undefined : "invalid"}
            value={text}
            placeholder={field.default === undefined ? "" : String(field.default)}
            spellCheck={false}
            aria-label={field.label}
            data-focus={focusKey(path)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    write(text);
                }
            }}
            onBlur={() => {
                if (text === shown) {
                    setError(undefined);
                } else if (text !== written.current) {
                    write(text);
                }
            }}
        />
    );
    return (
        <div className={problem ? "input problem" : "input"}>
            {buttons ? (
                <div className="input-row">
                    {box}
                    {buttons}
                </div>
            ) : (
                box
            )}
            <div className="validation" hidden={error === undefined}>
                {error}
            </div>
            {problem && <div className="validation problem-text">{problem}</div>}
        </div>
    );
}

function EnumInput({ field, value, path, edit }: InputProps) {
    return (
        <select
            aria-label={field.label}
            data-focus={focusKey(path)}
            value={value === undefined ? "" : String(value)}
            onChange={(e) => (e.target.value === "" ? edit.remove(path) : edit.set(path, e.target.value))}
        >
            <option value="">
                {field.default === undefined ? "(not set)" : `(default: ${String(field.default)})`}
            </option>
            {(field.values ?? []).map((v, i) => (
                <option key={v} value={v}>
                    {field.valueLabels?.[i] ?? v}
                </option>
            ))}
        </select>
    );
}

function Checkbox({ field, value, path, edit }: InputProps) {
    return (
        <label className="checkbox">
            <input
                type="checkbox"
                checked={typeof value === "boolean" ? value : field.default === true}
                aria-label={field.label}
                data-focus={focusKey(path)}
                onChange={(e) => edit.set(path, e.target.checked)}
            />
            <span>{field.description ?? field.label}</span>
        </label>
    );
}

/** A table with one row per list item and one column per item property. */
function ObjectList({ field, value, edit }: { field: Field; value: unknown[] | undefined; edit: Editor }) {
    const rows = value ?? [];
    const columns = field.columns ?? [];
    const newRow = Object.fromEntries(columns.filter((c) => c.required).map((c) => [c.key, ""]));
    // Focus the new row, so its empty cells are not marked before the user had a chance to fill them.
    const addItem = () => {
        if (columns.length > 0) {
            focusLater(focusKey([field.key, rows.length, columns[0].key]));
        }
        edit.set([field.key, -1], newRow);
    };
    const removeButton = (r: number) => (
        <button
            className="icon"
            title="Remove item"
            aria-label={`Remove item ${r + 1}`}
            onClick={() => edit.remove([field.key, r])}
        >
            {"\u2715"}
        </button>
    );
    return (
        <div className="object-list">
            {rows.length > 0 ? (
                <table>
                    <thead>
                        <tr>
                            {columns.map((c) => (
                                <th key={c.key} title={c.description ?? ""}>
                                    {c.required ? `${c.label} *` : c.label}
                                </th>
                            ))}
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, r) => (
                            <tr key={r}>
                                {typeof row !== "object" || row === null || Array.isArray(row) ? (
                                    <td colSpan={columns.length}>
                                        <Unsupported value={row} edit={edit} />
                                    </td>
                                ) : (
                                    columns.map((c) => (
                                        <td key={c.key}>
                                            {c.kind === "contextScope" ? (
                                                <ContextScopeCell
                                                    item={row as Record<string, unknown>}
                                                    path={[field.key, r]}
                                                    edit={edit}
                                                />
                                            ) : (
                                                <Cell
                                                    field={c}
                                                    value={(row as Record<string, unknown>)[c.key]}
                                                    path={[field.key, r, c.key]}
                                                    edit={edit}
                                                />
                                            )}
                                        </td>
                                    ))
                                )}
                                <td>{removeButton(r)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <p className="empty">No items.</p>
            )}
            <IconButton icon="add" label="Add item" onClick={addItem} />
        </div>
    );
}

function Cell(props: InputProps) {
    switch (props.field.kind) {
        case "boolean":
            return <Checkbox {...props} field={{ ...props.field, description: "" }} />;
        case "enum":
            return <EnumInput {...props} />;
        default:
            return <TextInput {...props} />;
    }
}

type ScopeMode = "all" | "contexts" | "query";

const CONTEXTS_INPUT: Field = {
    key: "contexts",
    label: "Contexts",
    kind: "string",
    default: "Separated by commas",
};
const QUERY_INPUT: Field = { key: "contextQuery", label: "Context Query", kind: "string" };

/**
 * The contexts of a list item: all, listed IDs or names, or a context query.
 * Each change writes the whole item, so that the attributes of the other
 * choices are removed at the same time.
 */
function ContextScopeCell({ item, path, edit }: { item: Record<string, unknown>; path: JsonPath; edit: Editor }) {
    const scope = readContextScope(item);
    const saved: ScopeMode = "contextQuery" in scope ? "query" : scope.contexts.length > 0 ? "contexts" : "all";
    /** The choice made while nothing is saved for it yet, such as Contexts before any is typed. */
    const [chosen, setChosen] = React.useState<ScopeMode>("all");
    const mode = saved === "all" ? chosen : saved;
    const write = (next: ContextScope) => edit.set(path, withContextScope(item, next));
    const textEditor = (toScope: (text: string) => ContextScope): Editor => ({
        ...edit,
        set: (_path, value) => write(toScope(String(value))),
        remove: () => write({ contexts: [] }),
        isMissing: () => false,
    });
    return (
        <div className="context-scope">
            <div className="input-row">
                <select
                    aria-label="Contexts"
                    value={mode}
                    onChange={(e) => {
                        setChosen(e.target.value as ScopeMode);
                        if (saved !== "all") {
                            write({ contexts: [] });
                        }
                    }}
                >
                    <option value="all">All contexts</option>
                    <option value="contexts">Contexts</option>
                    <option value="query">Context query</option>
                </select>
                <IconButton
                    icon="checklist"
                    label="Pick Contexts..."
                    title={
                        edit.canPickContexts
                            ? "Pick from the contexts of the running session"
                            : "Start a session to this agent to pick from its contexts"
                    }
                    disabled={!edit.canPickContexts}
                    onClick={() => edit.pickContexts(path)}
                />
            </div>
            {mode === "contexts" && (
                <TextInput
                    field={CONTEXTS_INPUT}
                    value={"contexts" in scope && scope.contexts.length > 0 ? scope.contexts.join(", ") : undefined}
                    path={[...path, "contexts"]}
                    edit={textEditor((text) => ({ contexts: parseContextList(text) }))}
                />
            )}
            {mode === "query" && (
                <TextInput
                    field={QUERY_INPUT}
                    value={"contextQuery" in scope ? scope.contextQuery : undefined}
                    path={[...path, "contextQuery"]}
                    edit={textEditor((text) => (text.trim() ? { contextQuery: text.trim() } : { contexts: [] }))}
                />
            )}
        </div>
    );
}

export function Unsupported({ value, edit }: { value: unknown; edit: Editor }) {
    return (
        <div className="unsupported">
            <code>{value === undefined ? "(not set)" : JSON.stringify(value)}</code>
            <button className="link" onClick={() => edit.openText()}>
                Edit in launch.json
            </button>
        </div>
    );
}
