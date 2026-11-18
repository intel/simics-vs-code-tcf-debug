import type { LaunchConfiguration } from "./launchJson";
import type { Field } from "./schema";

/** Sent to the launch form when it starts and after every change of launch.json. */
export interface StateMessage {
    type: "state";
    fields: Field[];
    configurations: LaunchConfiguration[];
    /** Set if launch.json cannot be read, configurations is then empty. */
    error?: string;
    /** Position of a configuration to select, for example one just added. */
    select?: number;
    /** Host paths that do not exist, as "<configuration index>:<JsonPath joined by />". */
    missingPaths: string[];
    /** Agents (see agentAddress) a Simics Target Debug session runs on or is starting on. */
    busyAgents: string[];
}

export type JsonPath = (string | number)[];

/**
 * Sent by the launch form. `index` and `name` say which configuration the
 * form showed, so a change is refused if launch.json changed under the form.
 */
export type WebviewMessage =
    | { type: "ready" }
    | { type: "set"; index: number; name: string; path: JsonPath; value: unknown }
    | { type: "remove"; index: number; name: string; path: JsonPath }
    /** Pick a file or folder for the path attribute at `path`. */
    | { type: "browse"; index: number; name: string; path: JsonPath; pick: "file" | "folder" }
    | { type: "add" }
    | { type: "duplicate"; index: number; name: string }
    | { type: "delete"; index: number; name: string }
    | { type: "deleteAll"; configurations: { index: number; name: string }[] }
    | { type: "start"; index: number; name: string }
    | { type: "openSettings" }
    | { type: "openText" };

/** The settings a tab of the settings view changes, like the tabs of VS Code's Settings editor. */
export type SettingsTarget = "user" | "workspace";

/** Sent to the settings view when it starts and after every change of its settings. */
export interface SettingsStateMessage {
    type: "settingsState";
    fields: Field[];
    /** False if no folder or workspace is open, there are only user settings then. */
    hasWorkspace: boolean;
    /** The values of the fields in each tab, by field key. */
    values: Record<SettingsTarget, Record<string, SettingValue>>;
}

export interface SettingValue {
    /** The value that applies in the tab, already inverted if the field says so. */
    value: unknown;
    /** Set in the tab's settings, so it can be reset. */
    modified: boolean;
    /** In the User tab: the workspace settings set it too, and win. */
    overridden?: boolean;
}

/** Sent by the settings view. */
export type SettingsWebviewMessage =
    | { type: "ready" }
    /** The tab shown, after it started or changed. */
    | { type: "tab"; target: SettingsTarget }
    /** No value resets the setting. */
    | { type: "setSetting"; key: string; target: SettingsTarget; value?: unknown }
    /** Open the settings.json of `target`. */
    | { type: "openJson"; target: SettingsTarget };
