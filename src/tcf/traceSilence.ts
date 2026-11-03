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

/** Keep in sync with the default of "traceTcfSilence" in package.json. */
export const DEFAULT_TRACE_SILENCE: readonly TraceSilenceRule[] = [
    { service: "Locator", type: ["event"], name: "peerHeartBeat" },
    { service: "Locator", type: ["event"], name: "peerAdded" },
    { service: "Locator", type: ["event"], name: "peerRemoved" },
    { service: "Locator", type: ["event"], name: "peerChanged" },
    { service: "CommandLine", type: ["*"], name: "*" },
];

/**
 * The rules of a "traceTcfSilence" attribute: the defaults if it is not set.
 * `invalid` has the entries that are not rules.
 */
export function parseTraceSilence(value: unknown): { rules: TraceSilenceRule[]; invalid: unknown[] } {
    if (value === undefined) {
        return { rules: [...DEFAULT_TRACE_SILENCE], invalid: [] };
    }
    const entries = Array.isArray(value) ? value : [value];
    const rules: TraceSilenceRule[] = [];
    const invalid: unknown[] = [];
    for (const e of entries) {
        if (isRule(e)) {
            rules.push(e);
        } else {
            invalid.push(e);
        }
    }
    return { rules, invalid };
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

function isRule(e: unknown): e is TraceSilenceRule {
    if (typeof e !== "object" || e === null) {
        return false;
    }
    const r = e as Record<string, unknown>;
    const validType = (t: unknown) => t === "*" || TRACE_MESSAGE_TYPES.includes(t as TraceMessageType);
    return (
        typeof r.service === "string" &&
        (r.name === undefined || typeof r.name === "string") &&
        (r.type === undefined || (Array.isArray(r.type) && r.type.length > 0 && r.type.every(validType)))
    );
}
