import * as vscode from "vscode";
import { ContextChoice, ContextScope, TargetContext, contextChoices, pickedValues } from "./contextChoices";

/**
 * The contexts of a session to pick from: the cores (contexts with state),
 * and with `includeContainers` all run control contexts.
 */
export function listContexts(session: vscode.DebugSession, includeContainers = false): Promise<TargetContext[]> {
    return session.customRequest(
        "getFunctionBreakpointContexts",
        includeContainers ? { includeContainers: true } : undefined,
    ) as Promise<TargetContext[]>;
}

export interface PickContextsOptions {
    title: string;
    /** The contexts to offer. Checked entries that are not among them are kept as extra items. */
    contexts: readonly TargetContext[];
    /** The scope to start with. */
    scope: ContextScope;
    /** A context to list first, such as the one selected in the Call Stack view. */
    selectedId?: string;
    placeholder?: string;
    /** Offer a button to enter a TCF context query instead of checking contexts. */
    allowQuery?: boolean;
    /** Offer typed text as a context ID or name to check, for contexts that are not listed. */
    allowTyped?: boolean;
}

/** The scope picked, or what was entered when the user switched to the other way of picking. */
type Step<T> = { scope: ContextScope } | { switched: T } | undefined;

const QUERY_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("filter"),
    tooltip: "Use a Context Query Instead",
};
const CONTEXTS_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("checklist"),
    tooltip: "Check Contexts Instead",
};

/**
 * Lets the user check the contexts something applies to, or enter a context
 * query when `allowQuery` is set. No checked context means all contexts.
 * Returns undefined if cancelled.
 */
export async function pickContexts(options: PickContextsOptions): Promise<ContextScope | undefined> {
    let byQuery = "contextQuery" in options.scope;
    let contexts = "contexts" in options.scope ? options.scope.contexts : [];
    let query = "contextQuery" in options.scope ? options.scope.contextQuery : "";
    for (;;) {
        if (byQuery) {
            const step = await enterQuery(options, query);
            if (step === undefined || "scope" in step) {
                return step?.scope;
            }
            query = step.switched;
        } else {
            const step = await check(options, contexts);
            if (step === undefined || "scope" in step) {
                return step?.scope;
            }
            contexts = step.switched;
        }
        byQuery = !byQuery;
    }
}

type Item = ContextChoice & vscode.QuickPickItem;

function check(options: PickContextsOptions, initial: readonly string[]): Promise<Step<string[]>> {
    return new Promise((resolve) => {
        const picker = vscode.window.createQuickPick<Item>();
        picker.title = options.title;
        picker.placeholder = options.placeholder ?? "Check the contexts, or check none for all contexts";
        picker.canSelectMany = true;
        picker.matchOnDescription = true;
        picker.matchOnDetail = true;
        picker.buttons = options.allowQuery ? [QUERY_BUTTON] : [];
        let finished = false;

        function finish(step: Step<string[]>): void {
            if (finished) {
                return;
            }
            finished = true;
            picker.hide();
            picker.dispose();
            resolve(step);
        }

        /** The typed text, if it is offered as an item because it matches no listed item. */
        let typedItem: Item | undefined;
        /** True if Enter takes the typed text too, as it filters out all listed items. */
        let typedOnly = false;

        function update(checked: readonly string[]): void {
            const items: Item[] = contextChoices(options.contexts, checked, options.selectedId);
            const typed = picker.value.trim();
            typedItem = undefined;
            if (
                options.allowTyped &&
                typed &&
                !items.some((item) => item.value === typed || item.label === typed || item.detail === typed)
            ) {
                const lower = typed.toLowerCase();
                typedOnly = !items.some((item) =>
                    [item.label, item.description, item.detail].some((text) => text?.toLowerCase().includes(lower)),
                );
                typedItem = {
                    label: typed,
                    description: typedOnly
                        ? "Press Enter or check to use this context ID or name"
                        : "Check to use this context ID or name",
                    value: typed,
                    picked: false,
                    alwaysShow: true,
                };
                items.unshift(typedItem);
            }
            picker.items = items;
            picker.selectedItems = items.filter((item) => item.picked);
        }

        if (options.allowTyped) {
            picker.onDidChangeValue(() => update(pickedValues(picker.selectedItems)));
        }
        picker.onDidTriggerButton(() => finish({ switched: pickedValues(picker.selectedItems) }));
        picker.onDidAccept(() => {
            const picked = pickedValues(picker.selectedItems);
            if (typedItem && typedOnly && !picked.includes(typedItem.value)) {
                picked.push(typedItem.value);
            }
            finish({ scope: { contexts: picked } });
        });
        picker.onDidHide(() => finish(undefined));
        update(initial);
        picker.show();
    });
}

function enterQuery(options: PickContextsOptions, initial: string): Promise<Step<string>> {
    return new Promise((resolve) => {
        const input = vscode.window.createInputBox();
        input.title = options.title;
        input.prompt = "TCF context query, for example **/HasState=true";
        input.placeholder = "Context query";
        input.value = initial;
        input.buttons = [CONTEXTS_BUTTON];
        let finished = false;

        function finish(step: Step<string>): void {
            if (finished) {
                return;
            }
            finished = true;
            input.hide();
            input.dispose();
            resolve(step);
        }

        input.onDidChangeValue(() => {
            input.validationMessage = undefined;
        });
        input.onDidTriggerButton(() => finish({ switched: input.value.trim() }));
        input.onDidAccept(() => {
            const query = input.value.trim();
            if (!query) {
                input.validationMessage = "Enter a context query, or use the button to check contexts";
                return;
            }
            finish({ scope: { contextQuery: query } });
        });
        input.onDidHide(() => finish(undefined));
        input.show();
    });
}
