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

export interface ScopeMenuItem {
    label: string;
    description?: string;
    /** A scope to accept at once, or the next step: the checklist or the context query input. */
    action: { scope: ContextScope } | { step: "pick" | "query" };
    /** The item that stands for the scope the menu starts with. */
    active?: boolean;
}

/**
 * The first step of the context picker: all contexts, the selected
 * call-stack context, the current scope if it is neither of those, and the
 * steps to check contexts or enter a context query. Labels have codicons.
 */
export function scopeMenuItems(
    scope: ContextScope,
    contexts: readonly TargetContext[],
    selectedId?: string,
): ScopeMenuItem[] {
    const selected = contexts.find((context) => context.id === selectedId);
    const checked = "contexts" in scope ? scope.contexts : [];
    const isAll = "contexts" in scope && checked.length === 0;
    const isSelected = selected !== undefined && checked.length === 1 && checked[0] === selected.id;
    const items: ScopeMenuItem[] = [];
    if (!isAll && !isSelected) {
        const names = checked.map((entry) => contexts.find((context) => context.id === entry)?.name ?? entry);
        items.push({
            label: `$(check) ${"contextQuery" in scope ? `Contexts matching ${scope.contextQuery}` : names.join(", ")}`,
            description: "Current",
            action: { scope },
            active: true,
        });
    }
    items.push({
        label: "$(globe) All contexts",
        description: "No context filter",
        action: { scope: { contexts: [] } },
        active: isAll,
    });
    if (selected) {
        items.push({
            label: `$(debug-stackframe) ${selected.name}`,
            description: `Selected call-stack context (${selected.id})`,
            action: { scope: { contexts: [selected.id] } },
            active: isSelected,
        });
    }
    items.push(
        { label: "$(checklist) Pick Contexts...", description: "Check one or more contexts", action: { step: "pick" } },
        {
            label: "$(filter) Context Query...",
            description: "Enter a TCF context query",
            action: { step: "query" },
        },
    );
    return items;
}
