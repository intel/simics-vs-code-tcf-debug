import { getLocation } from "jsonc-parser";
import { TRACE_MESSAGE_TYPES } from "./tcf/traceSilence";

export const SILENCE_SETTING = "simics-target-debug.tcfTrace.silence";

/** The services of the Simics TCF agent. Other services can be typed too. */
export const TRACE_SERVICES = [
    "Breakpoints",
    "CommandLine",
    "ContextQuery",
    "ContextReset",
    "Disassembly",
    "DPrintf",
    "Expressions",
    "LineNumbers",
    "Locator",
    "Memory",
    "MemoryDevices",
    "MemoryMap",
    "PathMap",
    "Registers",
    "RegistersExt",
    "RunControl",
    "Simics",
    "SimicsExecTraces",
    "SimicsLogs",
    "Simulation",
    "SimUtils",
    "StackTrace",
    "Streams",
    "Symbols",
    "SymbolsProxyV1",
    "SymbolsProxyV2",
    "Trace",
    "ZeroCopy",
];

/**
 * What can be typed at `offset` in the text of a settings.json or
 * .code-workspace file, if it is in a "service/type/name" rule of the
 * silence setting: a service, or a message type after the first "/" or a
 * ",". Names get no suggestions. `start` is where the part being typed starts.
 */
export function silenceRuleCompletions(text: string, offset: number): { start: number; values: string[] } | undefined {
    const location = getLocation(text, offset);
    const rule = location.previousNode;
    const parent = location.path.slice(0, -1).join("\n");
    if (
        rule?.type !== "string" ||
        typeof location.path.at(-1) !== "number" ||
        (parent !== SILENCE_SETTING && parent !== `settings\n${SILENCE_SETTING}`)
    ) {
        return undefined;
    }
    const typed = text.slice(rule.offset + 1, offset);
    if (typed.includes('"') || offset <= rule.offset) {
        return undefined;
    }
    const [, type, ...rest] = typed.split("/");
    if (type === undefined) {
        return { start: rule.offset + 1, values: ["*", ...TRACE_SERVICES] };
    }
    if (rest.length > 0) {
        return undefined;
    }
    const chosen = type.split(",").slice(0, -1);
    if (chosen.includes("*")) {
        return undefined;
    }
    const current = type.slice(type.lastIndexOf(",") + 1);
    return {
        start: offset - current.length,
        values: [...(chosen.length === 0 ? ["*"] : []), ...TRACE_MESSAGE_TYPES.filter((t) => !chosen.includes(t))],
    };
}
