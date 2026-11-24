import * as React from "react";
import type { JsonPath } from "@/launchSettings/protocol";
import {
    type Field,
    type FieldKind,
    fieldPath,
    filterSuggestions,
    parseInput,
    toggleChoice,
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
        case "multiEnum":
            return <MultiSelect field={field} value={value} path={path} edit={edit} />;
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
 * empty. With suggestions, typing or the arrow button shows the matching
 * ones below it; any other text can still be typed.
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

    const combo = useCombo(field.suggestions, (s) => {
        setText(s);
        write(s);
    });

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
            {...combo?.inputProps}
            onChange={(e) => {
                setText(e.target.value);
                combo?.typed(e.target.value);
            }}
            onKeyDown={(e) => {
                if (combo?.keyDown(e)) {
                    return;
                }
                if (e.key === "Enter") {
                    const t = combo?.active ?? text;
                    combo?.close();
                    setText(t);
                    write(t);
                }
            }}
            onBlur={() => {
                combo?.close();
                if (text === shown) {
                    setError(undefined);
                } else if (text !== written.current) {
                    write(text);
                }
            }}
        />
    );
    const row =
        combo || buttons ? (
            <div className="input-row">
                {box}
                {combo?.button}
                {buttons}
            </div>
        ) : (
            box
        );
    return (
        <div className={problem ? "input problem" : "input"}>
            {combo ? (
                <div className="combo">
                    {row}
                    {combo.list}
                </div>
            ) : (
                row
            )}
            <div className="validation" hidden={error === undefined}>
                {error}
            </div>
            {problem && <div className="validation problem-text">{problem}</div>}
        </div>
    );
}

/** The suggestion list of a text box, undefined without suggestions. */
function useCombo(suggestions: readonly string[] | undefined, pick: (s: string) => void) {
    const id = React.useId();
    const [shown, setShown] = React.useState<string[]>();
    const [active, setActive] = React.useState(-1);
    const list = React.useRef<HTMLUListElement>(null);
    React.useEffect(() => {
        list.current?.children[active]?.scrollIntoView({ block: "nearest" });
    }, [active]);
    if (!suggestions) {
        return undefined;
    }
    const open = (text: string) => {
        const matches = filterSuggestions(suggestions, text);
        setShown(matches.length > 0 ? matches : undefined);
        setActive(-1);
        return matches;
    };
    const close = () => {
        setShown(undefined);
        setActive(-1);
    };
    /** Handles the keys for the list, true if the text box should do nothing else. */
    const keyDown = (e: React.KeyboardEvent): boolean => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const matches = shown ?? open("");
            const down = e.key === "ArrowDown";
            const from = shown ? active : -1;
            if (matches.length > 0) {
                setActive(
                    from < 0
                        ? down
                            ? 0
                            : matches.length - 1
                        : (from + (down ? 1 : -1) + matches.length) % matches.length,
                );
            }
            return true;
        }
        if (e.key === "Escape" && shown) {
            e.preventDefault();
            e.stopPropagation();
            close();
            return true;
        }
        return false;
    };
    return {
        inputProps: {
            role: "combobox",
            "aria-autocomplete": "list" as const,
            "aria-controls": id,
            "aria-expanded": shown !== undefined,
            "aria-activedescendant": shown && active >= 0 ? `${id}-${active}` : undefined,
        },
        /** The highlighted suggestion, which Enter picks. */
        active: shown && active >= 0 ? shown[active] : undefined,
        typed: open,
        keyDown,
        close,
        button: (
            <button
                className="icon combo-button"
                tabIndex={-1}
                title="Show suggestions"
                aria-label="Show suggestions"
                // Keeps the focus in the text box, so it does not write the typed text first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                    if (shown) {
                        close();
                    } else {
                        (e.currentTarget.parentElement?.querySelector("input") as HTMLInputElement | null)?.focus();
                        open("");
                    }
                }}
            >
                <span className="codicon codicon-chevron-down" aria-hidden="true" />
            </button>
        ),
        list: (
            <ul ref={list} className="combo-list" id={id} role="listbox" hidden={shown === undefined}>
                {shown?.map((s, i) => (
                    <li
                        key={s}
                        id={`${id}-${i}`}
                        role="option"
                        aria-selected={i === active}
                        className={i === active ? "combo-option active" : "combo-option"}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                            close();
                            pick(s);
                        }}
                    >
                        {s}
                    </li>
                ))}
            </ul>
        ),
    };
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
    const newRow = {
        ...Object.fromEntries(columns.filter((c) => c.required).map((c) => [c.key, ""])),
        ...field.newItem,
    };
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
                                            <Cell
                                                field={c}
                                                value={(row as Record<string, unknown>)[c.key]}
                                                path={[field.key, r, c.key]}
                                                edit={edit}
                                            />
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
        case "multiEnum":
            return <MultiSelect {...props} />;
        default:
            return <TextInput {...props} />;
    }
}

/** A dropdown with a checkbox for each value. Without a value, the default is checked. */
function MultiSelect({ field, value, path, edit }: InputProps) {
    const [open, setOpen] = React.useState(false);
    const details = React.useRef<HTMLDetailsElement>(null);
    // Closes on a click anywhere else.
    React.useEffect(() => {
        if (!open) {
            return undefined;
        }
        const click = (e: MouseEvent) => {
            if (!details.current?.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("click", click);
        return () => document.removeEventListener("click", click);
    }, [open]);
    const values = field.values ?? [];
    const current = Array.isArray(value) ? value : Array.isArray(field.default) ? field.default : [];
    const selected = current.map(String);
    const label = (v: string) => field.valueLabels?.[values.indexOf(v)] ?? v;
    const text = selected.map(label).join(", ");
    return (
        <details
            ref={details}
            className="multi-select"
            open={open}
            onToggle={(e) => setOpen(e.currentTarget.open)}
            onKeyDown={(e) => {
                if (e.key === "Escape" && open) {
                    setOpen(false);
                    details.current?.querySelector("summary")?.focus();
                }
            }}
        >
            <summary
                aria-label={field.label}
                data-focus={focusKey(path)}
                className={Array.isArray(value) ? "" : "default"}
            >
                <span className="multi-select-text" title={text}>
                    {text}
                </span>
                <span className="codicon codicon-chevron-down" aria-hidden="true" />
            </summary>
            <div className="multi-select-options">
                {values.map((v) => {
                    const checked = selected.includes(v);
                    return (
                        <label key={v} className="multi-select-option">
                            <input
                                type="checkbox"
                                checked={checked}
                                disabled={checked && selected.length === 1}
                                onChange={(e) => edit.set(path, toggleChoice(values, selected, v, e.target.checked))}
                            />
                            <span>{label(v)}</span>
                        </label>
                    );
                })}
            </div>
        </details>
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
