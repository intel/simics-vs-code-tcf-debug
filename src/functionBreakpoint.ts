export const FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR = " @ ";

export interface ParsedFunctionBreakpointName {
    location: string;
    contextId?: string;
    hasContextDelimiter: boolean;
}

export function formatFunctionBreakpointName(location: string, contextId?: string): string {
    return contextId ? `${location}${FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR}${contextId}` : location;
}

export function parseFunctionBreakpointName(name: string): ParsedFunctionBreakpointName {
    const separator = name.lastIndexOf(FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR);
    const hasContextDelimiter = separator >= 0;
    return {
        location: hasContextDelimiter ? name.slice(0, separator).trim() : name,
        contextId: hasContextDelimiter
            ? name.slice(separator + FUNCTION_BREAKPOINT_CONTEXT_SEPARATOR.length).trim()
            : undefined,
        hasContextDelimiter,
    };
}
