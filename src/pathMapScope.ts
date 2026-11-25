import * as vscode from "vscode";
import { ContextScope, TargetContext } from "./contextChoices";
import { listContexts, pickContexts } from "./contextPicker";
import { PathMapRule } from "./pathMapper";

type Scope = Pick<PathMapRule, "contexts" | "contextQuery">;

/** The scope of a rule, also of one with the old single "context". */
export function pathMapRuleScope(rule: Pick<PathMapRule, "contexts" | "context" | "contextQuery">): ContextScope {
    if (rule.contextQuery) {
        return { contextQuery: rule.contextQuery };
    }
    return { contexts: rule.contexts ?? (rule.context ? [rule.context] : []) };
}

/**
 * Asks which contexts a path map rule applies to, with the context picker of
 * breakpoints and symbol files. `contextId` is offered first, for example the
 * context of a missing source file; else the selected call-stack context.
 * Shared by the Path Map view and Locate Source File.
 */
export async function promptPathMapScope(
    session: vscode.DebugSession,
    current: Pick<PathMapRule, "contexts" | "context" | "contextQuery"> = {},
    contextId?: string,
): Promise<Scope | undefined> {
    let contexts: TargetContext[] = [];
    try {
        contexts = await listContexts(session);
    } catch (err) {
        void vscode.window.showWarningMessage(
            `Could not list TCF contexts, type their IDs: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const active = vscode.debug.activeStackItem;
    const threadId = active?.session.id === session.id ? active.threadId : undefined;
    const selectedId =
        contextId ?? contexts.find((context) => threadId !== undefined && context.threadId === threadId)?.id;
    if (selectedId !== undefined && !contexts.some((context) => context.id === selectedId)) {
        contexts = [{ id: selectedId, name: selectedId }, ...contexts];
    }
    const scope = await pickContexts({
        title: "Path Map Contexts",
        contexts,
        scope: pathMapRuleScope(current),
        selectedId,
        placeholder: "Check the contexts the rule applies to",
        allowTyped: true,
        idsOnly: true,
    });
    if (scope === undefined) {
        return undefined;
    }
    if ("contextQuery" in scope) {
        return { contextQuery: scope.contextQuery };
    }
    return scope.contexts.length > 0 ? { contexts: scope.contexts } : {};
}
