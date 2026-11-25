/*
 * The items of the context picker shared by function breakpoints, symbol
 * files and the launch configurations form. No vscode imports, so that it
 * can be tested and used by the webview.
 */

/** A context the agent offers to pick, from the getSymbolContexts or getFunctionBreakpointContexts request. */
export interface TargetContext {
    id: string;
    name: string;
    /** The DAP thread of the context, if it has one. */
    threadId?: number;
}

/** The contexts something applies to: listed IDs or names (empty for all), or a TCF context query. */
export type ContextScope = { contexts: string[] } | { contextQuery: string };

export interface ContextChoice {
    label: string;
    description?: string;
    detail?: string;
    /** What picking the item gives: the checked ID or name it matched, else the context ID. */
    value: string;
    picked: boolean;
}

/**
 * The items of the context checklist: the selected call-stack context first,
 * then the session's contexts, then checked entries the session does not
 * have, so that editing never drops part of a scope silently. A checked entry
 * matches a context by ID, or else by name, and is kept as it was written.
 */
export function contextChoices(
    contexts: readonly TargetContext[],
    checked: readonly string[],
    selectedId?: string,
): ContextChoice[] {
    const ids = new Set(contexts.map((context) => context.id));
    const matched = new Set<string>();
    const entryFor = (context: TargetContext): string | undefined => {
        const entry = checked.find((e) => e === context.id) ?? checked.find((e) => !ids.has(e) && e === context.name);
        if (entry !== undefined) {
            matched.add(entry);
        }
        return entry;
    };
    const selected = contexts.find((context) => context.id === selectedId);
    const ordered = selected ? [selected, ...contexts.filter((context) => context !== selected)] : contexts;
    const choices: ContextChoice[] = ordered.map((context) => {
        const entry = entryFor(context);
        const choice: ContextChoice = {
            label: context.name,
            description: context.id,
            value: entry ?? context.id,
            picked: entry !== undefined,
        };
        if (context === selected) {
            choice.description = "Selected call-stack context";
            choice.detail = context.id;
        }
        return choice;
    });
    return [
        ...choices,
        ...checked
            .filter((entry) => !matched.has(entry))
            .map((entry) => ({
                label: entry,
                description: "Not available in this session",
                value: entry,
                picked: true,
            })),
    ];
}

/** The distinct values of picked items, in order. */
export function pickedValues(choices: readonly Pick<ContextChoice, "value">[]): string[] {
    return [...new Set(choices.map((choice) => choice.value))];
}

/** Parses a comma-separated list of context IDs or names. */
export function parseContextList(text: string): string[] {
    return [
        ...new Set(
            text
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
        ),
    ];
}

/** "all contexts", the listed contexts, or "contexts matching <query>". */
export function describeContextScope(scope: { contexts?: readonly string[]; contextQuery?: string }): string {
    if (scope.contextQuery !== undefined) {
        return `contexts matching ${scope.contextQuery}`;
    }
    return scope.contexts && scope.contexts.length > 0 ? scope.contexts.join(", ") : "all contexts";
}
