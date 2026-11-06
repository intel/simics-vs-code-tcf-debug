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

export interface FunctionBreakpointContext {
    id: string;
    name: string;
}

export interface FunctionBreakpointContextChoice {
    label: string;
    description?: string;
    detail?: string;
    id: string;
    picked: boolean;
}

/**
 * The items of the context checklist: the selected call-stack context first,
 * then the session's contexts, then checked IDs the session does not have, so
 * that editing a breakpoint never drops part of its scope silently.
 */
export function functionBreakpointContextChoices(
    contexts: readonly FunctionBreakpointContext[],
    checkedIds: readonly string[],
    selectedId?: string,
): FunctionBreakpointContextChoice[] {
    const selected = contexts.find((context) => context.id === selectedId);
    const ordered = selected ? [selected, ...contexts.filter((context) => context !== selected)] : contexts;
    const known = new Set(contexts.map((context) => context.id));
    return [
        ...ordered.map((context) =>
            context === selected
                ? {
                      label: context.name,
                      description: "Selected call-stack context",
                      detail: context.id,
                      id: context.id,
                      picked: checkedIds.includes(context.id),
                  }
                : {
                      label: context.name,
                      description: context.id,
                      id: context.id,
                      picked: checkedIds.includes(context.id),
                  },
        ),
        ...checkedIds
            .filter((id) => !known.has(id))
            .map((id) => ({ label: id, description: "Not available in this session", id, picked: true })),
    ];
}
