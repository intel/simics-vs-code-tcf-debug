import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DebugProtocol } from "@vscode/debugprotocol";
import { parseCallStackContext } from "./callStackFrame";
import { parseInstructionReference } from "./disassembly";
import { registerFunctionHeaderFileSystem } from "./functionHeaderFileSystem";
import { applyAndSave, registerLaunchSettings } from "./launchSettings/editorProvider";
import { setNamedConfigurationValue } from "./launchSettings/launchJson";
import { formatFunctionBreakpointName } from "./functionBreakpoint";
import { MissingSource, SourceLocator } from "./locateSource";
import { pathMapProblems } from "./pathMapper";
import { registerPathMapView } from "./pathMapView";
import {
    ForeignSymbolFile,
    SymbolFileConfig,
    describeForeignSymbolFile,
    symbolFileBreakpointContext,
} from "./symbolFiles";
import { suggestSymbolPaths } from "./symbolPath";
import { registerConsolesView } from "./consolesView";
import { CONSOLE_AVAILABLE_EVENT, simicsCliOptions } from "./simicsConsole";
import { SimicsConsoleManager } from "./simicsConsoleManager";
import { TcfDebugSession, TcfLog } from "./tcfDebugSession";
import { TargetMemoryManager } from "./targetMemory/targetMemoryManager";

/** Must match the debugger "type" in package.json. */
const DEBUG_TYPE = "simics-target-debug";
const SYMBOL_FILES_VIEW = "simics-target-debug.symbolFiles";

export function activate(context: vscode.ExtensionContext): void {
    const symbolFiles = new SymbolFilesProvider();
    const tcfLog = vscode.window.createOutputChannel("Simics Target Debug", { log: true });
    const terminatedSessions = new WeakSet<vscode.DebugSession>();
    const sessions = new Map<string, vscode.DebugSession>();
    const sourceLocator = new SourceLocator();
    const adapters = new Map<string, TcfDebugSession>();
    const consoles = new SimicsConsoleManager(
        DEBUG_TYPE,
        (session) => adapters.get(session.id)?.tcfChannel,
        context.workspaceState,
    );
    context.subscriptions.push(
        tcfLog,
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new TcfConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
            createDebugAdapterDescriptor: (session) => {
                const adapter = new TcfDebugSession(sessionLog(tcfLog, session.name));
                adapters.set(session.id, adapter);
                return new vscode.DebugAdapterInlineImplementation(adapter);
            },
        }),
        vscode.window.registerTreeDataProvider(SYMBOL_FILES_VIEW, symbolFiles),
        registerFunctionHeaderFileSystem(),
        vscode.debug.onDidStartDebugSession((session) => {
            sessions.set(session.id, session);
            symbolFiles.refresh();
        }),
        vscode.debug.onDidTerminateDebugSession((session) => {
            sessions.delete(session.id);
            adapters.delete(session.id);
            terminatedSessions.add(session);
            symbolFiles.refresh();
        }),
        vscode.debug.onDidChangeActiveDebugSession(() => symbolFiles.refresh()),
        vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
            if (event.session.type === DEBUG_TYPE && event.event === "symbolFilesChanged") {
                symbolFiles.refresh();
            }
            if (event.session.type === DEBUG_TYPE && event.event === "symbolFilesMissing") {
                const missing = (event.body as { files?: { index: number; path: string }[] } | undefined)?.files;
                if (Array.isArray(missing)) {
                    void warnMissingSymbolFiles(event.session, missing, () => terminatedSessions.has(event.session));
                }
            }
            if (event.session.type === DEBUG_TYPE && event.event === "sourceNotFound") {
                void sourceLocator.sourceNotFound(event.session, event.body as MissingSource);
            }
            if (event.session.type === DEBUG_TYPE && event.event === CONSOLE_AVAILABLE_EVENT) {
                consoles.available(event.session, (event.body as { open?: unknown } | undefined)?.open !== false);
            }
        }),
        consoles,
        vscode.commands.registerCommand("simics-target-debug.openConsole", () => consoles.open()),
        vscode.commands.registerCommand("simics-target-debug.locateSourceFile", () => {
            const session = vscode.debug.activeDebugSession;
            return sourceLocator.locateCommand(session?.type === DEBUG_TYPE ? session : undefined);
        }),
        // Invoked from the Call Stack view context menu: the source URI, then
        // the frame context.
        vscode.commands.registerCommand("simics-target-debug.copyFrameAddress", (_source: unknown, context: unknown) =>
            copyFrameAddress(sessions, context),
        ),
        vscode.commands.registerCommand("simics-target-debug.addSymbolFile", () => addSymbolFile(symbolFiles)),
        vscode.commands.registerCommand(
            "simics-target-debug.addFunctionBreakpointInContext",
            (_source: unknown, frameContext: unknown) => addFunctionBreakpointInContext(sessions, frameContext),
        ),
        vscode.commands.registerCommand(
            "simics-target-debug.addSymbolFileBreakpoint",
            (item?: SymbolFileViewItem) => item && addFunctionBreakpointInContext(sessions, undefined, item),
        ),
        vscode.commands.registerCommand("simics-target-debug.editSymbolFile", (item?: SymbolFileViewItem) =>
            editSymbolFile(item),
        ),
        vscode.commands.registerCommand("simics-target-debug.removeSymbolFile", (item: SymbolFileViewItem) =>
            changeSymbolFiles("removeSymbolFile", item),
        ),
        vscode.commands.registerCommand("simics-target-debug.reloadSymbolFile", (item: SymbolFileViewItem) =>
            changeSymbolFiles("reloadSymbolFile", item),
        ),
        vscode.commands.registerCommand("simics-target-debug.reloadSymbolFiles", () =>
            changeSymbolFiles("reloadSymbolFiles"),
        ),
        vscode.commands.registerCommand("simics-target-debug.saveSymbolFiles", saveSymbolFiles),
        symbolFiles,
        new TargetMemoryManager(context, DEBUG_TYPE),
    );
    registerLaunchSettings(context);
    registerPathMapView(context);
    registerConsolesView(context, [consoles]);
}

export function deactivate(): void {
    // Nothing to clean up, sessions are disposed by VS Code.
}

/**
 * Copies the address of a Call Stack frame: the PC for the top frame, the
 * return address for callers.
 */
async function copyFrameAddress(sessions: Map<string, vscode.DebugSession>, context: unknown): Promise<void> {
    const frame = parseCallStackContext(context);
    const session = frame && sessions.get(frame.sessionId);
    if (!frame || session?.type !== DEBUG_TYPE) {
        return;
    }
    try {
        const result = (await session.customRequest("stackTrace", {
            threadId: frame.threadId,
            startFrame: frame.frameIndex,
            levels: 1,
        })) as DebugProtocol.StackTraceResponse["body"];
        const reference = result.stackFrames[0]?.instructionPointerReference;
        if (!reference) {
            throw new Error("The frame has no address");
        }
        const { address } = parseInstructionReference(reference);
        const text = `0x${address.toString(16)}`;
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(`Copied ${text}`, 3000);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Cannot copy the frame address: ${message}`);
    }
}

/** One debug session's lines in the shared log, marked with the session name. */
function sessionLog(channel: vscode.LogOutputChannel, session: string): TcfLog {
    return {
        name: channel.name,
        info: (line) => channel.info(`[${session}] ${line}`),
        error: (line) => channel.error(`[${session}] ${line}`),
    };
}

async function addFunctionBreakpointInContext(
    sessions: Map<string, vscode.DebugSession>,
    frameContext: unknown,
    symbolFile?: SymbolFileViewItem,
): Promise<void> {
    const frame = parseCallStackContext(frameContext);
    const active = vscode.debug.activeStackItem;
    const session =
        symbolFile?.session ??
        (frame ? sessions.get(frame.sessionId) : (active?.session ?? vscode.debug.activeDebugSession));
    if (session?.type !== DEBUG_TYPE) {
        void vscode.window.showErrorMessage(
            "Start or select an active Simics Target Debug session before adding a function breakpoint.",
        );
        return;
    }
    const threadId = frame?.threadId ?? (active?.session.id === session.id ? active.threadId : undefined);
    try {
        const contexts = (await session.customRequest(
            "getFunctionBreakpointContexts",
            symbolFile ? { includeContainers: true } : undefined,
        )) as {
            id: string;
            name: string;
            threadId?: number;
        }[];
        const selected = contexts.find((context) => threadId !== undefined && context.threadId === threadId);
        const choices: SymbolContextChoice[] = [
            ...(selected
                ? [
                      {
                          label: selected.name,
                          description: "Selected call-stack context",
                          detail: selected.id,
                          id: selected.id,
                          picked: true,
                      },
                  ]
                : []),
            ...contexts
                .filter((context) => context !== selected)
                .map((context) => ({ label: context.name, description: context.id, id: context.id })),
        ];
        const contextIds = symbolFile
            ? [symbolFileBreakpointContext(symbolFile.file, contexts)]
            : (
                  await vscode.window.showQuickPick(choices, {
                      title: "Function Breakpoint Contexts",
                      placeHolder: "Check the cores to stop in, or check none for all contexts",
                      canPickMany: true,
                      matchOnDescription: true,
                      matchOnDetail: true,
                  })
              )?.map((choice) => choice.id);
        if (!contextIds) {
            return;
        }
        const symbol = await vscode.window.showInputBox({
            title: "Add Function Breakpoint",
            prompt: contextIds.length > 0 ? `Symbol in ${contextIds.join(", ")}` : "Symbol in all contexts",
            validateInput: (value) => (!value.trim() ? "Enter a symbol or expression" : undefined),
        });
        if (!symbol?.trim()) {
            return;
        }
        const name = formatFunctionBreakpointName(symbol.trim(), contextIds);
        if (
            !vscode.debug.breakpoints.some((bp) => bp instanceof vscode.FunctionBreakpoint && bp.functionName === name)
        ) {
            vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(name)]);
        }
    } catch (err) {
        void vscode.window.showErrorMessage(
            `Could not add function breakpoint: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

async function addSymbolFile(symbolFiles: SymbolFilesProvider): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== DEBUG_TYPE) {
        void vscode.window.showErrorMessage("Start a Simics Target Debug session before adding a symbol file.");
        return;
    }

    const filePath = await promptSymbolFilePath(session.workspaceFolder?.uri.fsPath);
    if (filePath === undefined) {
        return;
    }
    const contextId = await promptSymbolContext(session);
    if (contextId === undefined) {
        return;
    }
    const contextQuery = await vscode.window.showInputBox({
        title: "Context Query",
        prompt: "Optional TCF context query, for example **/HasState=true",
    });
    if (contextQuery === undefined) {
        return;
    }
    const load = await promptLoadAddress();
    if (load === undefined) {
        return;
    }

    const resolvedPath = filePath.trim();
    const symbolFile = {
        path:
            session.workspaceFolder && !path.isAbsolute(resolvedPath)
                ? path.join(session.workspaceFolder.uri.fsPath, resolvedPath)
                : resolvedPath,
        ...(contextId.trim() && { context: contextId.trim() }),
        ...(contextQuery.trim() && { contextQuery: contextQuery.trim() }),
        ...load,
    };
    try {
        await session.customRequest("addSymbolFile", symbolFile);
        symbolFiles.refresh();
        void vscode.window.showInformationMessage(`Symbol file ${symbolFile.path} added to ${session.name}.`);
    } catch (err) {
        void vscode.window.showErrorMessage(
            `Could not add symbol file: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

interface SymbolPathChoice extends vscode.QuickPickItem {
    path: string;
    directory?: boolean;
}

function promptSymbolFilePath(workspaceFolder?: string, initialPath = ""): Promise<string | undefined> {
    return new Promise((resolve) => {
        const picker = vscode.window.createQuickPick<SymbolPathChoice>();
        picker.title = initialPath ? "Update Symbol File Path" : "Add Symbol File";
        picker.placeholder = "Type an agent path or select a suggested local file or folder";
        let finished = false;

        function finish(value?: string): void {
            if (finished) {
                return;
            }
            finished = true;
            picker.hide();
            picker.dispose();
            resolve(value);
        }

        async function update(value: string): Promise<void> {
            const typed = value.trim();
            const manual: SymbolPathChoice[] = typed
                ? [{ label: typed, description: "Use this path", path: typed }]
                : [];
            picker.items = manual;
            picker.busy = true;
            const suggestions = await suggestSymbolPaths(value, workspaceFolder);
            if (finished || picker.value !== value) {
                return;
            }
            picker.items = [
                ...manual,
                ...suggestions.map((suggestion) => ({
                    label: suggestion.path + (suggestion.directory ? path.sep : ""),
                    description: suggestion.directory ? "Folder" : "File",
                    path: suggestion.path,
                    directory: suggestion.directory,
                })),
            ];
            picker.busy = false;
        }

        picker.onDidChangeValue((value) => {
            void update(value);
        });
        picker.onDidAccept(() => {
            const selected = picker.activeItems[0];
            if (selected?.directory) {
                picker.value = selected.path + path.sep;
            } else if (selected?.path || picker.value.trim()) {
                finish(selected?.path ?? picker.value.trim());
            }
        });
        picker.onDidHide(() => finish());
        picker.value = initialPath;
        picker.show();
        void update(initialPath);
    });
}

async function warnMissingSymbolFiles(
    session: vscode.DebugSession,
    missing: { index: number; path: string }[],
    isTerminated: () => boolean,
): Promise<void> {
    for (const entry of missing) {
        if (isTerminated()) {
            return;
        }
        const choice = await vscode.window.showWarningMessage(
            `Symbol file ${entry.path} was not found on this host. It may still exist on the TCF agent.`,
            "Update Path",
            "Keep Path",
        );
        if (choice !== "Update Path" || isTerminated()) {
            continue;
        }
        try {
            const result = (await session.customRequest("getSymbolFiles")) as { files: SymbolFileConfig[] };
            const file = result.files[entry.index];
            if (file?.path === entry.path) {
                await updateSymbolFilePath(session, entry.index, file);
            }
        } catch (err) {
            void vscode.window.showErrorMessage(
                `Could not update symbol file: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}

async function updateSymbolFilePath(
    session: vscode.DebugSession,
    index: number,
    file: SymbolFileConfig,
): Promise<void> {
    const newPath = await promptSymbolFilePath(session.workspaceFolder?.uri.fsPath, file.path);
    if (newPath === undefined || newPath.trim() === file.path) {
        return;
    }
    const trimmed = newPath.trim();
    const resolvedPath =
        session.workspaceFolder && !path.isAbsolute(trimmed)
            ? path.join(session.workspaceFolder.uri.fsPath, trimmed)
            : trimmed;
    await replaceSymbolFile(session, index, file, { ...file, path: resolvedPath });
}

async function editSymbolFile(item?: SymbolFileViewItem): Promise<void> {
    if (!item || vscode.debug.activeDebugSession !== item.session) {
        void vscode.window.showErrorMessage("Select a symbol file in the active TCF session to edit its mapping.");
        return;
    }
    const { session, index, file } = item;
    const selected = await vscode.window.showQuickPick(
        [
            { label: "Path", description: file.path, field: "path" },
            { label: "Context", description: file.context || "All contexts", field: "context" },
            { label: "Context Query", description: file.contextQuery || "None", field: "contextQuery" },
            { label: "Load Address", description: describeLoadAddress(file), field: "address" },
        ],
        { title: "Edit Symbol Mapping", placeHolder: "Select a field to update" },
    );
    if (!selected) {
        return;
    }
    const updated: SymbolFileConfig = { ...file };
    if (selected.field === "path") {
        const newPath = await promptSymbolFilePath(session.workspaceFolder?.uri.fsPath, file.path);
        if (newPath === undefined) {
            return;
        }
        const trimmed = newPath.trim();
        updated.path =
            session.workspaceFolder && !path.isAbsolute(trimmed)
                ? path.join(session.workspaceFolder.uri.fsPath, trimmed)
                : trimmed;
    } else if (selected.field === "context") {
        const contextId = await promptSymbolContext(session, file.context ?? "");
        if (contextId === undefined) {
            return;
        }
        updated.context = contextId.trim();
    } else if (selected.field === "contextQuery") {
        const contextQuery = await vscode.window.showInputBox({
            title: "Context Query",
            prompt: "Leave blank to remove the context query",
            value: file.contextQuery ?? "",
        });
        if (contextQuery === undefined) {
            return;
        }
        updated.contextQuery = contextQuery.trim() || undefined;
    } else {
        const load = await promptLoadAddress(file);
        if (load === undefined) {
            return;
        }
        updated.address = load.address;
        if (load.absolute) {
            updated.absolute = true;
        } else {
            delete updated.absolute;
        }
    }
    if (
        updated.path === file.path &&
        updated.context === file.context &&
        updated.contextQuery === file.contextQuery &&
        updated.address === file.address &&
        (updated.absolute === true) === (file.absolute === true)
    ) {
        return;
    }
    if (vscode.debug.activeDebugSession !== session) {
        return;
    }
    await replaceSymbolFile(session, index, file, updated);
}

interface LoadAddressChoice extends vscode.QuickPickItem {
    mode: "file" | "relative" | "absolute";
}

/**
 * Asks how a symbol file is placed in memory: at its own addresses, shifted
 * by an offset (the default, like Simics add-symbol-file -relative), or with
 * its first loadable segment at an absolute load address. Returns undefined
 * when cancelled.
 */
async function promptLoadAddress(
    current?: SymbolFileConfig,
): Promise<{ address?: string; absolute?: true } | undefined> {
    const currentMode = current?.address === undefined ? "file" : current.absolute ? "absolute" : "relative";
    const choices: LoadAddressChoice[] = [
        { mode: "file", label: "Use the addresses in the file" },
        {
            mode: "relative",
            label: "Relocate by offset",
            detail: "Added to all addresses in the file, like add-symbol-file -relative",
        },
        {
            mode: "absolute",
            label: "Absolute load address",
            detail: "Address of the loadable segment with the lowest file offset (normally the first one)",
        },
    ];
    const items = choices.map((c) => (c.mode === currentMode ? { ...c, description: "(current)" } : c));
    const mode = await vscode.window.showQuickPick(items, {
        title: "Load Address",
        placeHolder: "How are the symbols placed in memory?",
    });
    if (!mode) {
        return undefined;
    }
    if (mode.mode === "file") {
        return {};
    }
    const absolute = mode.mode === "absolute";
    const value = await vscode.window.showInputBox({
        title: absolute ? "Absolute Load Address" : "Relocation Offset",
        prompt: absolute
            ? "Address of the first loadable segment, hex or decimal (for example 0x100000)"
            : "Offset added to the file addresses, hex or decimal, may be negative (for example 0x1000 or -0x1000)",
        value: currentMode === mode.mode ? formatConfigAddress(current?.address) : "",
        validateInput: (v) =>
            (absolute ? /^(0x[0-9a-f]+|\d+)$/i : /^-?\s*(0x[0-9a-f]+|\d+)$/i).test(v.trim())
                ? undefined
                : absolute
                  ? "Enter a non-negative hex or decimal address"
                  : "Enter a hex or decimal offset",
    });
    if (value === undefined) {
        return undefined;
    }
    return absolute ? { address: value.trim(), absolute: true } : { address: value.trim().replace(/\s+/g, "") };
}

/** Shows an address from a symbol file configuration as hex, keeping the text if it is not a number. */
function formatConfigAddress(address: string | number | undefined): string {
    if (address === undefined) {
        return "";
    }
    try {
        const text = String(address).trim();
        const negative = text.startsWith("-");
        const value = BigInt(negative ? text.slice(1).trim() : text);
        return `${negative ? "-" : ""}0x${value.toString(16)}`;
    } catch {
        return String(address);
    }
}

function describeLoadAddress(file: SymbolFileConfig): string {
    if (file.address === undefined) {
        return "File addresses";
    }
    const value = formatConfigAddress(file.address);
    if (file.absolute) {
        return `At ${value}`;
    }
    return `Relocated by ${value.startsWith("-") ? value : `+${value}`}`;
}

function loadAddressSuffix(file: SymbolFileConfig): string {
    if (file.address === undefined) {
        return "";
    }
    const value = formatConfigAddress(file.address);
    return file.absolute ? ` @ ${value}` : ` ${value.startsWith("-") ? value : `+${value}`}`;
}

async function replaceSymbolFile(
    session: vscode.DebugSession,
    index: number,
    file: SymbolFileConfig,
    updated: SymbolFileConfig,
): Promise<void> {
    try {
        await session.customRequest("replaceSymbolFile", { index, ...file, file: updated });
        void vscode.window.showInformationMessage(`Symbol mapping updated for this session: ${updated.path}`);
    } catch (err) {
        void vscode.window.showErrorMessage(
            `Could not update symbol mapping: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

interface SymbolContextChoice extends vscode.QuickPickItem {
    id: string;
}

async function promptSymbolContext(session: vscode.DebugSession, initialContext = ""): Promise<string | undefined> {
    let contexts: { id: string; name: string }[];
    try {
        contexts = (await session.customRequest("getSymbolContexts")) as { id: string; name: string }[];
    } catch (err) {
        void vscode.window.showWarningMessage(
            `Could not list TCF contexts: ${err instanceof Error ? err.message : String(err)}`,
        );
        return vscode.window.showInputBox({
            title: "Context ID or Name",
            prompt: "Leave blank to apply to all contexts",
            value: initialContext,
        });
    }
    return new Promise((resolve) => {
        const picker = vscode.window.createQuickPick<SymbolContextChoice>();
        picker.title = "Context ID or Name";
        picker.placeholder = "Choose a context, type an ID or name, or select All contexts";
        picker.matchOnDescription = true;
        let finished = false;

        function finish(value?: string): void {
            if (finished) {
                return;
            }
            finished = true;
            picker.hide();
            picker.dispose();
            resolve(value);
        }

        function update(value: string): void {
            const typed = value.trim();
            picker.items = [
                typed
                    ? { label: typed, description: "Use ID or name as entered", id: typed }
                    : { label: "All contexts", description: "No context filter", id: "" },
                ...contexts.map((context) => ({ label: context.name, description: context.id, id: context.id })),
            ];
        }

        picker.onDidChangeValue(update);
        picker.onDidAccept(() => finish(picker.activeItems[0]?.id ?? picker.value.trim()));
        picker.onDidHide(() => finish());
        picker.value = initialContext;
        picker.show();
        update(initialContext);
    });
}

async function saveSymbolFiles(): Promise<void> {
    try {
        const session = vscode.debug.activeDebugSession;
        if (session?.type !== DEBUG_TYPE) {
            throw new Error("Select an active Simics Target Debug session.");
        }
        const folder = session.workspaceFolder;
        if (!folder) {
            throw new Error("This session has no workspace debug configuration.");
        }
        const { supported, files } = (await session.customRequest("getSymbolFiles")) as {
            supported: boolean;
            files: SymbolFileConfig[];
        };
        if (!supported) {
            throw new Error("The active TCF session does not provide the MemoryMap service");
        }
        const choice = await vscode.window.showWarningMessage(
            `Replace the symbolFiles in "${session.configuration.name}" ` + `with the ${files.length} session file(s)?`,
            { modal: true },
            "Save",
        );
        if (choice !== "Save") {
            return;
        }
        if (vscode.debug.activeDebugSession !== session) {
            throw new Error("The active debug session changed. Please retry.");
        }
        const document = await vscode.workspace.openTextDocument(
            vscode.Uri.joinPath(folder.uri, ".vscode", "launch.json"),
        );
        const edits = setNamedConfigurationValue(document.getText(), session.configuration.name, "symbolFiles", files);
        await applyAndSave(document, edits);
        void vscode.window.showInformationMessage(`Saved symbol files to "${session.configuration.name}".`);
    } catch (err) {
        void vscode.window.showErrorMessage(
            "Could not save symbol files: " + (err instanceof Error ? err.message : String(err)),
        );
    }
}

async function changeSymbolFiles(command: string, item?: SymbolFileViewItem): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== DEBUG_TYPE || (item && item.session !== session)) {
        void vscode.window.showErrorMessage("Select an active TCF session and refresh the Symbol Files view.");
        return;
    }
    try {
        await session.customRequest(command, item && { index: item.index, ...item.file });
    } catch (err) {
        void vscode.window.showErrorMessage(
            `Could not update symbol files: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

class SymbolFileViewItem extends vscode.TreeItem {
    override readonly contextValue: string;

    constructor(
        readonly file: SymbolFileConfig,
        readonly index: number,
        readonly session: vscode.DebugSession,
    ) {
        super(path.basename(file.path));
        this.contextValue = file.context ? "symbolFile scoped" : "symbolFile";
        const scope =
            [file.context && `context ${file.context}`, file.contextQuery && `query ${file.contextQuery}`]
                .filter(Boolean)
                .join(", ") || "all contexts";
        this.description = `${scope}${loadAddressSuffix(file)}`;
        this.tooltip = `${file.path}\n${this.description}`;
        this.iconPath = new vscode.ThemeIcon("file-code");
    }
}

class ForeignSymbolFileViewItem extends vscode.TreeItem {
    override readonly contextValue = "foreignSymbolFile";

    constructor(file: ForeignSymbolFile) {
        super(path.basename(file.path));
        const { description, tooltip } = describeForeignSymbolFile(file);
        this.description = description;
        this.tooltip = tooltip;
        this.iconPath = new vscode.ThemeIcon("file-binary");
    }
}

async function foreignSymbolFileItems(session: vscode.DebugSession): Promise<vscode.TreeItem[]> {
    try {
        const { files } = (await session.customRequest("getForeignSymbolFiles")) as { files: ForeignSymbolFile[] };
        return files.map((file) => new ForeignSymbolFileViewItem(file));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return [new vscode.TreeItem(`Could not read the memory maps: ${message}`)];
    }
}

/** Read-only files from memory maps that the session did not add. */
class ForeignSymbolFilesItem extends vscode.TreeItem {
    constructor(readonly children: vscode.TreeItem[]) {
        super("Added Elsewhere", vscode.TreeItemCollapsibleState.Expanded);
        this.id = "foreignSymbolFiles";
        this.contextValue = "foreignSymbolFiles";
        this.tooltip =
            "Files in the agent's memory maps that this session did not add, for example with " +
            "add-symbol-file in Simics, by OS awareness, or by another client";
        this.iconPath = new vscode.ThemeIcon("references");
    }
}

class SymbolFilesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly changes = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changes.event;

    refresh(): void {
        this.changes.fire();
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof ForeignSymbolFilesItem) {
            return element.children;
        }
        const session = vscode.debug.activeDebugSession;
        if (session?.type !== DEBUG_TYPE) {
            return [];
        }
        try {
            const [result, foreignFiles] = await Promise.all([
                session.customRequest("getSymbolFiles") as Thenable<{
                    supported: boolean;
                    files: SymbolFileConfig[];
                }>,
                foreignSymbolFileItems(session),
            ]);
            if (vscode.debug.activeDebugSession !== session) {
                return [];
            }
            if (!result.supported) {
                return [new vscode.TreeItem("MemoryMap service unavailable")];
            }
            const items: vscode.TreeItem[] =
                result.files.length === 0
                    ? [new vscode.TreeItem("No symbol files loaded")]
                    : result.files.map((file, index) => new SymbolFileViewItem(file, index, session));
            if (foreignFiles.length > 0) {
                items.push(new ForeignSymbolFilesItem(foreignFiles));
            }
            return items;
        } catch (err) {
            return [
                new vscode.TreeItem(`Could not load symbol files: ${err instanceof Error ? err.message : String(err)}`),
            ];
        }
    }

    dispose(): void {
        this.changes.dispose();
    }
}

class TcfConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): vscode.DebugConfiguration {
        // Allow starting without a launch.json.
        if (!config.type && !config.request && !config.name) {
            return {
                type: DEBUG_TYPE,
                request: "attach",
                name: "Attach to TCF agent",
                host: "localhost",
                port: 1534,
            };
        }
        return config;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration | undefined> {
        const problems = pathMapProblems(config.pathMap, (p) => fs.existsSync(p), folder?.uri.fsPath);
        if (problems.length > 0) {
            const answer = await vscode.window.showWarningMessage(
                `The Path Map of "${String(config.name)}" has problems.`,
                { modal: true, detail: problems.join("\n") },
                "Start Anyway",
                "Open Launch Settings",
            );
            if (answer === "Open Launch Settings") {
                const launchJson = folder && vscode.Uri.joinPath(folder.uri, ".vscode", "launch.json");
                await vscode.commands.executeCommand(
                    "simics-target-debug.openLaunchSettings",
                    launchJson && fs.existsSync(launchJson.fsPath) ? launchJson : undefined,
                );
            }
            if (answer !== "Start Anyway") {
                return undefined;
            }
        }
        // Symbol files are opened by the agent, so relative paths are made
        // absolute relative to the workspace folder.
        if (folder && Array.isArray(config.symbolFiles)) {
            config.symbolFiles = config.symbolFiles.map((f: unknown) => {
                const entry = f as { path?: unknown } | null;
                if (entry && typeof entry.path === "string" && entry.path.length > 0 && !path.isAbsolute(entry.path)) {
                    return { ...entry, path: path.join(folder.uri.fsPath, entry.path) };
                }
                return f;
            });
        }
        // The Simics CLI opens in the same panel, so the Debug Console would only flash by.
        if (simicsCliOptions(config).open) {
            config.internalConsoleOptions = "neverOpen";
        }
        return config;
    }
}
