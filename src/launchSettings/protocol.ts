import type { LaunchConfiguration } from "./launchJson";
import type { Field } from "./schema";

/** Sent to the webview when it starts and after every change of launch.json. */
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
    /** A Simics Target Debug session runs or is starting, only one is allowed. */
    debugging: boolean;
    /** Values of the fields stored in VS Code settings, by field key. */
    settings: Record<string, SettingValue>;
}

export interface SettingValue {
    /** The value the field shows, already inverted if the field says so. */
    value: unknown;
    /** Set in the workspace settings, so it can be reset. */
    modified: boolean;
}

export type JsonPath = (string | number)[];

/**
 * Sent by the webview. `index` and `name` say which configuration the form
 * showed, so a change is refused if launch.json changed under the form.
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
    /** Set the VS Code setting of a field with `setting`; no value resets it. */
    | { type: "setSetting"; key: string; value?: unknown }
    | { type: "openText" };
