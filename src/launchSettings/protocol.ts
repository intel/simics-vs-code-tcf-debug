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
    /** Pick the contexts of the list item at `path` from a session to the configuration's agent. */
    | { type: "pickContexts"; index: number; name: string; path: JsonPath }
    | { type: "add" }
    | { type: "duplicate"; index: number; name: string }
    | { type: "delete"; index: number; name: string }
    | { type: "deleteAll"; configurations: { index: number; name: string }[] }
    | { type: "start"; index: number; name: string }
    | { type: "openSettings" }
    | { type: "openText" };
