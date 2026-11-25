import type { ContextScope } from "./contextChoices";

export const FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR = " @ ";
export const FUNCTION_BREAKPOINT_CONTEXT_LIST_SEPARATOR = ", ";
export const FUNCTION_BREAKPOINT_QUERY_SEPARATOR = " @? ";

export interface ParsedFunctionBreakpointName {
    location: string;
    /** The distinct context IDs after the separator, empty for a global breakpoint. */
    contextIds: string[];
    /** The context query after " @? ", if the breakpoint has one. */
    contextQuery?: string;
    hasContextDelimiter: boolean;
    /** True if the context list or query has an empty entry, for example "f @ ", "f @ a, , b" or "f @? ". */
    hasEmptyContext: boolean;
}

/** "f", "f @ id1, id2" for context IDs, or "f @? query" for a context query. */
export function formatFunctionBreakpointName(location: string, scope: ContextScope = { contexts: [] }): string {
    if ("contextQuery" in scope) {
        return `${location}${FUNCTION_BREAKPOINT_QUERY_SEPARATOR}${scope.contextQuery}`;
    }
    return scope.contexts.length > 0
        ? `${location}${FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR}${scope.contexts.join(FUNCTION_BREAKPOINT_CONTEXT_LIST_SEPARATOR)}`
        : location;
}

export function parseFunctionBreakpointName(name: string): ParsedFunctionBreakpointName {
    // Checked first, as a query may contain " @ " but a symbol never has " @? ".
    const query = name.indexOf(FUNCTION_BREAKPOINT_QUERY_SEPARATOR);
    if (query >= 0) {
        const contextQuery = name.slice(query + FUNCTION_BREAKPOINT_QUERY_SEPARATOR.length).trim();
        return {
            location: name.slice(0, query).trim(),
            contextIds: [],
            ...(contextQuery && { contextQuery }),
            hasContextDelimiter: true,
            hasEmptyContext: !contextQuery,
        };
    }
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

/** The scope of a parsed function breakpoint name. */
export function functionBreakpointScope(parsed: ParsedFunctionBreakpointName): ContextScope {
    return parsed.contextQuery !== undefined ? { contextQuery: parsed.contextQuery } : { contexts: parsed.contextIds };
}
