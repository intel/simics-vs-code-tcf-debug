import * as vscode from "vscode";
import {
    ContextChoice,
    ContextScope,
    ScopeMenuItem,
    TargetContext,
    contextChoices,
    pickedValues,
    scopeMenuItems,
} from "./contextChoices";

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
    /** A context to offer first, such as the one selected in the Call Stack view. */
    selectedId?: string;
    /** The placeholder of the checklist. */
    placeholder?: string;
    /** Offer typed text as a context ID or name to check, for contexts that are not listed. */
    allowTyped?: boolean;
    /** Typed text is a context ID only, not a name. */
    idsOnly?: boolean;
}

/** The scope picked, Back, or undefined when cancelled. */
type Step<T> = { scope: ContextScope } | { back: T } | undefined;

/**
 * Lets the user choose the contexts something applies to: first all
 * contexts, the selected call-stack context or the current scope, or the
 * steps to check contexts or enter a TCF context query. Those steps have a
 * Back button to the first one. Returns undefined if cancelled.
 */
export async function pickContexts(options: PickContextsOptions): Promise<ContextScope | undefined> {
    let checked = "contexts" in options.scope ? options.scope.contexts : [];
    let query = "contextQuery" in options.scope ? options.scope.contextQuery : "";
    for (;;) {
        const action = await chooseScope(options);
        if (action === undefined || "scope" in action) {
            return action?.scope;
        }
        if (action.step === "pick") {
            const step = await check(options, checked);
            if (step === undefined || "scope" in step) {
                return step?.scope;
            }
            checked = step.back;
        } else {
            const step = await enterQuery(options, query);
            if (step === undefined || "scope" in step) {
                return step?.scope;
            }
            query = step.back;
        }
    }
}

type MenuItem = vscode.QuickPickItem & { action: ScopeMenuItem["action"] };

function chooseScope(options: PickContextsOptions): Promise<MenuItem["action"] | undefined> {
    return new Promise((resolve) => {
        const picker = vscode.window.createQuickPick<MenuItem>();
        picker.title = options.title;
        picker.placeholder = "Choose the contexts it applies to";
        picker.matchOnDescription = true;
        const menu = scopeMenuItems(options.scope, options.contexts, options.selectedId);
        const items: MenuItem[] = menu.map(({ label, description, action }) => ({ label, description, action }));
        picker.items = items;
        const active = items[menu.findIndex((item) => item.active)];
        if (active) {
            picker.activeItems = [active];
        }
        let finished = false;

        function finish(action: MenuItem["action"] | undefined): void {
            if (finished) {
                return;
            }
            finished = true;
            picker.hide();
            picker.dispose();
            resolve(action);
        }

        picker.onDidAccept(() => {
            const item = picker.activeItems[0];
            if (item) {
                finish(item.action);
            }
        });
        picker.onDidHide(() => finish(undefined));
        picker.show();
    });
}

type Item = ContextChoice & vscode.QuickPickItem;

function check(options: PickContextsOptions, initial: readonly string[]): Promise<Step<string[]>> {
    return new Promise((resolve) => {
        const picker = vscode.window.createQuickPick<Item>();
        picker.title = options.title;
        picker.placeholder = options.placeholder ?? "Check one or more contexts";
        picker.canSelectMany = true;
        picker.matchOnDescription = true;
        picker.matchOnDetail = true;
        picker.buttons = [vscode.QuickInputButtons.Back];
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
                    description: `${typedOnly ? "Press Enter or check" : "Check"} to use this context ${
                        options.idsOnly ? "ID" : "ID or name"
                    }`,
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
        picker.onDidTriggerButton(() => finish({ back: pickedValues(picker.selectedItems) }));
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
        input.prompt = "TCF context query";
        input.placeholder = "Context query";
        input.value = initial;
        input.buttons = [vscode.QuickInputButtons.Back];
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
        input.onDidTriggerButton(() => finish({ back: input.value.trim() }));
        input.onDidAccept(() => {
            const query = input.value.trim();
            if (!query) {
                input.validationMessage = "Enter a context query";
                return;
            }
            finish({ scope: { contextQuery: query } });
        });
        input.onDidHide(() => finish(undefined));
        input.show();
    });
}
