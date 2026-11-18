import type { TraceMessage, TraceMessageType } from "./channel";

export const TRACE_MESSAGE_TYPES: readonly TraceMessageType[] = ["command", "event", "flowControl"];

/**
 * TCF messages left out of the trace: those of `service` with one of the
 * types in `type` and named `name`. "*" matches anything, also a message
 * without a service or name (flow control). Missing `type` and `name` mean "*".
 * A command's results have its type and name.
 */
export interface TraceSilenceRule {
    service: string;
    type?: (TraceMessageType | "*")[];
    name?: string;
}

/** Keep in sync with the default of "simics-target-debug.tcfTrace.silence" in package.json. */
export const DEFAULT_TRACE_SILENCE: readonly string[] = [
    "Locator/event/peerHeartBeat",
    "Locator/event/peerAdded",
    "Locator/event/peerRemoved",
    "Locator/event/peerChanged",
    "CommandLine",
    "SimicsLogs/event",
];

/**
 * The rules of the setting simics-target-debug.tcfTrace.silence: a list of
 * "service/type/name" strings. The defaults if it is not set. `invalid` has
 * the items that are not rules.
 */
export function parseTraceSilence(value: unknown): { rules: TraceSilenceRule[]; invalid: unknown[] } {
    const items = value === undefined ? DEFAULT_TRACE_SILENCE : Array.isArray(value) ? value : [value];
    const rules: TraceSilenceRule[] = [];
    const invalid: unknown[] = [];
    for (const item of items) {
        const rule = typeof item === "string" ? parseRule(item) : undefined;
        if (rule) {
            rules.push(rule);
        } else {
            invalid.push(item);
        }
    }
    return { rules, invalid };
}

/** "service", "service/type" or "service/type/name"; type is "*" or a comma list of message types. */
function parseRule(key: string): TraceSilenceRule | undefined {
    const [service, type, name, ...rest] = key.split("/");
    const types = type?.split(",");
    const validTypes =
        type === "*" || types?.every((t) => TRACE_MESSAGE_TYPES.includes(t as TraceMessageType)) !== false;
    if (!service || type === "" || name === "" || rest.length > 0 || !validTypes) {
        return undefined;
    }
    return {
        service,
        ...(types && { type: types as TraceSilenceRule["type"] }),
        ...(name !== undefined && { name }),
    };
}

export function isSilenced(rules: readonly TraceSilenceRule[], message: TraceMessage): boolean {
    return rules.some(
        (rule) =>
            matches(rule.service, message.service) &&
            matches(rule.name ?? "*", message.name) &&
            (rule.type ?? ["*"]).some((t) => t === "*" || t === message.type),
    );
}

function matches(pattern: string, value: string | undefined): boolean {
    return pattern === "*" || pattern === value;
}
