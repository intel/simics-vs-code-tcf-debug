export const FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR = " @ ";
export const FUNCTION_BREAKPOINT_CONTEXT_LIST_SEPARATOR = ", ";

export interface ParsedFunctionBreakpointName {
    location: string;
    /** The distinct context IDs after the separator, empty for a global breakpoint. */
    contextIds: string[];
    hasContextDelimiter: boolean;
    /** True if the context list has an empty entry, for example "f @ " or "f @ a, , b". */
    hasEmptyContext: boolean;
}

export function formatFunctionBreakpointName(location: string, contextIds: readonly string[] = []): string {
    return contextIds.length > 0
        ? `${location}${FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR}${contextIds.join(FUNCTION_BREAKPOINT_CONTEXT_LIST_SEPARATOR)}`
        : location;
}

export function parseFunctionBreakpointName(name: string): ParsedFunctionBreakpointName {
    const separator = name.lastIndexOf(FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR);
    if (separator < 0) {
        return { location: name, contextIds: [], hasContextDelimiter: false, hasEmptyContext: false };
    }
    const entries = name
        .slice(separator + FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR.length)
        .split(",")
        .map((id) => id.trim());
    const contextIds = [...new Set(entries.filter((id) => id))];
    return {
        location: name.slice(0, separator).trim(),
        contextIds,
        hasContextDelimiter: true,
        hasEmptyContext: entries.some((id) => !id),
    };
}
