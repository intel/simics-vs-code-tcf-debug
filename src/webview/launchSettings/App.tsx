import * as React from "react";
import type { LaunchConfiguration } from "@/launchSettings/launchJson";
import type { StateMessage } from "@/launchSettings/protocol";
import { agentAddress, type Field, fieldPath, valueAtPath } from "@/launchSettings/schema";
import {
    applyFocusLater,
    Control,
    type Editor,
    IconButton,
    Setting,
    TextInput,
    Unsupported,
} from "./components/controls";
import { loadState, onMessage, post, saveState } from "./vscode";

/*
 * The launch configurations form: configuration names on the left, the attributes
 * of the selected one on the right. It keeps no data of its own, every
 * change goes to the extension, which updates launch.json and sends back a
 * new state.
 */

interface Selection {
    index: number;
    name: string;
}

interface SavedState {
    selected: Selection;
    advancedOpen: boolean;
}

const NAME_FIELD: Field = {
    key: "name",
    label: "Name",
    kind: "string",
    description: "Shown in the Run and Debug view.",
};
const FIXED_KEYS = new Set(["type", "request", "name"]);

export function App() {
    const saved = React.useMemo(() => loadState<SavedState>(), []);
    const [state, setState] = React.useState<StateMessage>();
    /** The configurations last read without error, shown read-only while launch.json is broken. */
    const [configs, setConfigs] = React.useState<LaunchConfiguration[]>([]);
    const [selected, setSelected] = React.useState(saved.selected);
    const [advancedOpen, setAdvancedOpen] = React.useState(saved.advancedOpen ?? false);
    /** Set by a click on Start: no "why disabled" tooltip until the mouse leaves. */
    const [quietStart, setQuietStart] = React.useState(false);

    React.useEffect(() => {
        const stop = onMessage((message) => {
            if (message.type !== "state") {
                return;
            }
            setState(message);
            if (message.error === undefined) {
                setConfigs(message.configurations);
            }
            const wanted = message.configurations.find((c) => c.index === message.select);
            if (wanted) {
                setSelected({ index: wanted.index, name: wanted.name });
            }
        });
        post({ type: "ready" });
        return stop;
    }, []);

    React.useEffect(applyFocusLater, [state]);

    React.useEffect(() => {
        if (!quietStart) {
            return undefined;
        }
        const move = (e: MouseEvent) => {
            if (!(e.target as Element).closest("button.start")) {
                setQuietStart(false);
            }
        };
        document.addEventListener("mousemove", move);
        return () => document.removeEventListener("mousemove", move);
    }, [quietStart]);

    const config = currentConfiguration(configs, selected);
    // Follows the configuration when it is renamed or moved, and is kept for when the form opens again.
    React.useEffect(() => {
        const shown = config && { index: config.index, name: config.name };
        if (shown?.index !== selected?.index || shown?.name !== selected?.name) {
            setSelected(shown);
        }
        saveState({ selected: shown, advancedOpen });
    }, [config?.index, config?.name, advancedOpen]);

    if (!state) {
        return null;
    }
    const actions = (c: LaunchConfiguration) => (
        <ItemActions
            config={c}
            problem={startProblem(c, state)}
            quiet={quietStart}
            onStart={() => {
                setQuietStart(true);
                post({ type: "start", index: c.index, name: c.name });
            }}
        />
    );
    const readOnly = state.error !== undefined;
    return (
        <>
            {readOnly && (
                <div className="banner">
                    <span>{`launch.json cannot be read (${state.error}). Fix it in the text editor.`}</span>
                    <button onClick={() => post({ type: "openText" })}>Open as Text</button>
                </div>
            )}
            <fieldset className="layout" disabled={readOnly}>
                <ConfigurationList
                    configs={configs}
                    active={config}
                    onSelect={(c) => setSelected({ index: c.index, name: c.name })}
                    actions={actions}
                />
                {config ? (
                    // A new key for another configuration drops refused text and scrolls to the top.
                    <Details
                        key={config.index}
                        config={config}
                        configs={configs}
                        state={state}
                        advancedOpen={advancedOpen}
                        onAdvancedToggle={setAdvancedOpen}
                        actions={actions}
                    />
                ) : (
                    <main className="details">
                        <p className="empty">Use the + button to create a TCF launch configuration.</p>
                    </main>
                )}
            </fieldset>
        </>
    );
}

/** The configuration to show: the one selected, else the one most like it. */
function currentConfiguration(
    configs: LaunchConfiguration[],
    selected: Selection | undefined,
): LaunchConfiguration | undefined {
    return (
        configs.find((c) => c.index === selected?.index && c.name === selected?.name) ??
        configs.find((c) => c.name === selected?.name) ??
        configs.find((c) => c.index === selected?.index) ??
        configs[0]
    );
}

function ConfigurationList(props: {
    configs: LaunchConfiguration[];
    active: LaunchConfiguration | undefined;
    onSelect(config: LaunchConfiguration): void;
    actions(config: LaunchConfiguration): React.ReactNode;
}) {
    const { configs } = props;
    const counts = nameCounts(configs);
    return (
        <nav className="list">
            <div className="list-header">
                <span>Configurations</span>
                <div className="actions">
                    <IconButton
                        icon="add"
                        label="Add a TCF launch configuration"
                        onClick={() => post({ type: "add" })}
                    />
                    <IconButton
                        icon="close-all"
                        label="Delete All TCF Launch Configurations"
                        disabled={configs.length === 0}
                        onClick={() =>
                            post({
                                type: "deleteAll",
                                configurations: configs.map((c) => ({ index: c.index, name: c.name })),
                            })
                        }
                    />
                </div>
            </div>
            {configs.length > 0 ? (
                <ul role="listbox" aria-label="TCF launch configurations">
                    {configs.map((c, i) => {
                        const active = c.index === props.active?.index;
                        return (
                            <li
                                key={c.index}
                                className={active ? "selected" : ""}
                                tabIndex={0}
                                role="option"
                                aria-selected={active}
                                onClick={() => props.onSelect(c)}
                                onKeyDown={(e) => {
                                    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : -1;
                                    if (configs[next]) {
                                        e.preventDefault();
                                        props.onSelect(configs[next]);
                                        (e.currentTarget.parentElement?.children[next] as HTMLElement).focus();
                                    }
                                }}
                            >
                                <div className="item-text">
                                    <span className="item-name">
                                        {c.name || "(no name)"}
                                        {(counts.get(c.name) ?? 0) > 1 && (
                                            <span className="position">{` #${c.index + 1}`}</span>
                                        )}
                                    </span>
                                    <span className="item-address">{agentAddress(c.values)}</span>
                                </div>
                                {props.actions(c)}
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <p className="empty">No TCF launch configurations yet.</p>
            )}
        </nav>
    );
}

/** Start, Duplicate and Delete for one configuration. */
function ItemActions(props: {
    config: LaunchConfiguration;
    problem: string | undefined;
    quiet: boolean;
    onStart(): void;
}) {
    const target = { index: props.config.index, name: props.config.name };
    const label = props.problem ?? "Start Debugging";
    return (
        <span className="actions" onClick={(e) => e.stopPropagation()}>
            <IconButton
                icon="debug-start"
                label={label}
                title={props.problem && props.quiet ? "" : label}
                className="start"
                disabled={props.problem !== undefined}
                onClick={props.onStart}
            />
            <IconButton icon="copy" label="Duplicate" onClick={() => post({ type: "duplicate", ...target })} />
            <IconButton icon="trash" label="Delete" onClick={() => post({ type: "delete", ...target })} />
        </span>
    );
}

/** Why the configuration cannot be started now, if it cannot. */
function startProblem(config: LaunchConfiguration, state: StateMessage): string | undefined {
    const address = agentAddress(config.values);
    if (state.busyAgents.includes(address)) {
        return `A Simics Target Debug session to ${address} is already running`;
    }
    const empty = (v: unknown) => v === undefined || v === "";
    const emptyCell = (row: unknown, key: string) => empty((row as Record<string, unknown> | null)?.[key]);
    const missing = state.fields.find((f) => {
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

function Details(props: {
    config: LaunchConfiguration;
    configs: LaunchConfiguration[];
    state: StateMessage;
    advancedOpen: boolean;
    onAdvancedToggle(open: boolean): void;
    actions(config: LaunchConfiguration): React.ReactNode;
}) {
    const { config, state } = props;
    const target = { index: config.index, name: config.name };
    const missing = new Set(state.missingPaths);
    const edit: Editor = {
        set: (path, value) => post({ type: "set", ...target, path, value }),
        remove: (path) => post({ type: "remove", ...target, path }),
        browse: (path, pick) => post({ type: "browse", ...target, path, pick }),
        isMissing: (path) => missing.has(`${config.index}:${path.join("/")}`),
        openText: () => post({ type: "openText" }),
    };
    const sameName = (nameCounts(props.configs).get(config.name) ?? 0) > 1;
    const known = new Set(state.fields.map((f) => fieldPath(f)[0]));
    const others = Object.keys(config.values).filter((k) => !known.has(k) && !FIXED_KEYS.has(k));
    const own = state.fields.filter((f) => f.group === undefined);
    const advanced = state.fields.filter((f) => f.group === "advanced");
    const settings = (fields: Field[]) =>
        fields.map((f) => {
            const value = valueAtPath(config.values, fieldPath(f));
            return (
                <Setting key={f.key} field={f} value={value} edit={edit}>
                    <Control field={f} value={value} edit={edit} />
                </Setting>
            );
        });

    return (
        <main className="details">
            <div className="details-header">{props.actions(config)}</div>
            <Setting field={NAME_FIELD} value={config.name} canReset={false} edit={edit}>
                <TextInput
                    field={NAME_FIELD}
                    value={config.values.name}
                    path={["name"]}
                    edit={edit}
                    emptyError="The name must not be empty"
                />
                {sameName && <div className="note">Another configuration has the same name.</div>}
            </Setting>
            {settings(own)}
            {advanced.length > 0 && (
                <details
                    className="fold-down"
                    open={props.advancedOpen}
                    onToggle={(e) => props.onAdvancedToggle(e.currentTarget.open)}
                >
                    <summary>Advanced</summary>
                    {settings(advanced)}
                </details>
            )}
            {others.length > 0 && (
                <div className="setting">
                    <div className="setting-title">
                        <span className="label">Other Attributes</span>
                    </div>
                    <div className="description">Attributes this form does not know about.</div>
                    {others.map((k) => (
                        <div key={k} className="other">
                            <span className="key">{k}</span>
                            <Unsupported value={config.values[k]} edit={edit} />
                        </div>
                    ))}
                </div>
            )}
            <p className="settings-hint">
                The Simics console, call stack, disassembly and TCF trace options apply to all configurations. They are
                in{" "}
                <button className="link" onClick={() => post({ type: "openSettings" })}>
                    the settings
                </button>
                .
            </p>
        </main>
    );
}

function nameCounts(configs: LaunchConfiguration[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const c of configs) {
        counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    }
    return counts;
}
