import * as vscode from "vscode";
import type { DebugProtocol } from "@vscode/debugprotocol";
import * as req from "../tcfRequests";
import { BYTES_PER_ROW_OPTIONS, GROUP_SIZES, addressFromValue, parseAddress } from "../shared/targetMemory/format";
import { INT_SIZES } from "../shared/targetMemory/needle";
import {
    DEFAULT_SETTINGS,
    type ContextMenuCommand,
    type PanelSettings,
    type PhysicalContext,
} from "../shared/targetMemory/protocol";
import { TargetMemoryClient } from "./memoryClient";
import { TargetMemoryPanel, errorText } from "./targetMemoryPanel";

const SETTINGS_KEY = "simics-target-debug.targetMemory.settings";
const ADDRESS_KEY = "simics-target-debug.targetMemory.address";
/** Longest variable selected when a variable is opened. */
const MAX_VARIABLE_SELECTION = 0x1000;

/** A "simics-target-debug" debug session as seen by the Target Memory panels. */
export interface SessionInfo {
    session: vscode.DebugSession;
    client: TargetMemoryClient;
    /** DAP ID of the thread whose memory is shown. */
    focusedThread?: number;
    /** Whether the target was running at the last continued/stopped event. */
    running: boolean;
    physical?: Promise<PhysicalContext[]>;
}

/** Variable passed by the "debug/variables/context" menu. */
interface VariableArg {
    variable?: {
        value?: string;
        type?: string;
        evaluateName?: string;
        memoryReference?: string;
    };
}

/**
 * Owns the Target Memory panels: follows the "simics-target-debug" debug sessions
 * and the focused thread, and implements the commands.
 */
export class TargetMemoryManager implements vscode.Disposable {
    readonly log: vscode.LogOutputChannel;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly sessions = new Map<string, SessionInfo>();
    private current: SessionInfo | undefined;
    private readonly panels = new Set<TargetMemoryPanel>();
    private activePanel: TargetMemoryPanel | undefined;
    private panelCount = 0;
    private nextFindId = 1;
    private readonly finds = new Map<number, TargetMemoryPanel>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly debugType: string,
    ) {
        this.log = vscode.window.createOutputChannel("TCF Target Memory", {
            log: true,
        });
        const command = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, fn);
        // Webview menu commands get the menu context of the clicked element.
        const menuCommand = (name: string, c: ContextMenuCommand) =>
            command(`simics-target-debug.targetMemory.${name}`, (arg?: { address?: unknown; pane?: unknown }) =>
                this.activePanel?.runCommand(
                    c,
                    typeof arg?.address === "string"
                        ? {
                              address: arg.address,
                              pane: arg.pane === "text" ? "text" : "hex",
                          }
                        : undefined,
                ),
            );
        this.disposables.push(
            this.log,
            vscode.debug.onDidStartDebugSession((s) => this.addSession(s)),
            vscode.debug.onDidTerminateDebugSession((s) => this.removeSession(s)),
            vscode.debug.onDidChangeActiveDebugSession((s) => {
                const info = s && this.sessions.get(s.id);
                if (info && info !== this.current) {
                    this.current = info;
                    this.updatePanels();
                }
            }),
            vscode.debug.onDidChangeActiveStackItem((item) => this.onActiveStackItem(item)),
            vscode.debug.registerDebugAdapterTrackerFactory(debugType, {
                createDebugAdapterTracker: (session) => ({
                    onDidSendMessage: (m: DebugProtocol.ProtocolMessage) => this.onAdapterMessage(session, m),
                }),
            }),
            command("simics-target-debug.openTargetMemory", () => this.open()),
            command("simics-target-debug.newTargetMemory", () => this.open(true)),
            command("simics-target-debug.openVariableInTargetMemory", (arg?: VariableArg) => this.openVariable(arg)),
            menuCommand("copy", "copy"),
            menuCommand("copyText", "copyText"),
            menuCommand("copyAddress", "copyAddress"),
            menuCommand("goto", "goto"),
            menuCommand("find", "find"),
            menuCommand("refresh", "refresh"),
        );
        const active = vscode.debug.activeDebugSession;
        if (active) {
            this.addSession(active);
            this.onActiveStackItem(vscode.debug.activeStackItem);
        }
    }

    /** The session whose memory is shown. */
    get session(): SessionInfo | undefined {
        return this.current;
    }

    get settings(): PanelSettings {
        return validSettings(this.context.globalState.get(SETTINGS_KEY));
    }

    saveSettings(settings: PanelSettings): void {
        void this.context.globalState.update(SETTINGS_KEY, validSettings(settings));
    }

    get lastAddress(): string | undefined {
        return this.context.workspaceState.get<string>(ADDRESS_KEY);
    }

    saveAddress(address: string): void {
        void this.context.workspaceState.update(ADDRESS_KEY, address);
    }

    open(newPanel = false): TargetMemoryPanel {
        const existing = this.activePanel ?? [...this.panels].pop();
        if (existing && !newPanel) {
            existing.panel.reveal(undefined, false);
            return existing;
        }
        this.panelCount++;
        const title = this.panels.size === 0 ? "Target Memory" : `Target Memory ${this.panelCount}`;
        const panel = new TargetMemoryPanel(this, this.context.extensionUri, title);
        this.panels.add(panel);
        this.activePanel = panel;
        return panel;
    }

    panelActivated(panel: TargetMemoryPanel): void {
        this.activePanel = panel;
    }

    panelDisposed(panel: TargetMemoryPanel): void {
        this.panels.delete(panel);
        if (this.activePanel === panel) {
            this.activePanel = [...this.panels].pop();
        }
        if (this.panels.size === 0) {
            this.panelCount = 0;
        }
    }

    physicalContexts(info: SessionInfo): Promise<PhysicalContext[]> {
        info.physical ??= this.loadPhysicalContexts(info);
        return info.physical;
    }

    refreshPhysicalContexts(): void {
        if (this.current) {
            this.current.physical = undefined;
            this.updatePanels();
        }
    }

    startFind(panel: TargetMemoryPanel): number {
        const id = this.nextFindId++;
        this.finds.set(id, panel);
        return id;
    }

    endFind(id: number): void {
        this.finds.delete(id);
    }

    /** An address, or an expression evaluated in the selected frame. */
    async resolveAddress(expression: string): Promise<bigint> {
        const direct = parseAddress(expression);
        if (direct !== undefined) {
            return direct;
        }
        const info = this.current;
        if (!info) {
            throw new Error("There is no debug session to evaluate in");
        }
        const value = await info.client.evaluate(expression, this.frameId(info));
        const address = addressFromValue(value);
        if (address === undefined) {
            throw new Error(`${expression} is ${value}, not an address`);
        }
        return address;
    }

    /**
     * Shows a variable from the Variables view: what a pointer points to,
     * else where the variable is stored. The variable's bytes are selected
     * if its size is known.
     */
    async openVariable(arg: VariableArg | undefined): Promise<void> {
        const v = arg?.variable;
        const info = this.current;
        const frameId = info && this.frameId(info);
        const evaluate = async (expr: string) => {
            try {
                return info ? addressFromValue(await info.client.evaluate(expr, frameId)) : undefined;
            } catch (err) {
                this.log.warn(`Target Memory: ${expr}: ${errorText(err)}`);
                return undefined;
            }
        };
        const isPointer = v?.type !== undefined && /\*\s*$/.test(v.type);
        let address: bigint | undefined;
        let sizeExpr: string | undefined;
        if (v?.memoryReference) {
            address = addressFromValue(v.memoryReference);
        } else if (v?.evaluateName && !isPointer) {
            address = await evaluate(`&(${v.evaluateName})`);
            sizeExpr = `sizeof(${v.evaluateName})`;
        }
        // Pointers, registers and values that are addresses.
        if (address === undefined && v?.value !== undefined) {
            address = addressFromValue(v.value);
            sizeExpr = isPointer && v.evaluateName ? `sizeof(*(${v.evaluateName}))` : undefined;
        }
        if (address === undefined) {
            void vscode.window.showWarningMessage("The address of the selected variable is not known.");
            return;
        }
        let length: number | undefined;
        if (sizeExpr) {
            const size = await evaluate(sizeExpr);
            if (size !== undefined && size > 0n) {
                length = Number(size < MAX_VARIABLE_SELECTION ? size : MAX_VARIABLE_SELECTION);
            }
        }
        this.open().reveal(address, length);
    }

    dispose(): void {
        for (const panel of [...this.panels]) {
            panel.dispose();
        }
        this.disposables.forEach((d) => d.dispose());
    }

    private frameId(info: SessionInfo): number | undefined {
        const item = vscode.debug.activeStackItem;
        return item instanceof vscode.DebugStackFrame && item.session.id === info.session.id ? item.frameId : undefined;
    }

    private async loadPhysicalContexts(info: SessionInfo): Promise<PhysicalContext[]> {
        try {
            const contexts = await info.client.physicalMemoryContexts();
            return contexts.map((c) => ({ id: c.id, label: c.name }));
        } catch (err) {
            this.log.error(`Target Memory: cannot get the physical memory contexts: ${errorText(err)}`);
            return [];
        }
    }

    private addSession(session: vscode.DebugSession): void {
        if (session.type !== this.debugType || this.sessions.has(session.id)) {
            return;
        }
        const info: SessionInfo = {
            session,
            client: new TargetMemoryClient(session),
            running: false,
        };
        this.sessions.set(session.id, info);
        if (!this.current || vscode.debug.activeDebugSession === session) {
            this.current = info;
            this.updatePanels();
        }
    }

    private removeSession(session: vscode.DebugSession): void {
        const info = this.sessions.get(session.id);
        if (!info) {
            return;
        }
        this.sessions.delete(session.id);
        if (this.current === info) {
            const active = vscode.debug.activeDebugSession;
            this.current = (active && this.sessions.get(active.id)) ?? [...this.sessions.values()].pop();
            this.updatePanels();
        }
    }

    private onActiveStackItem(item: vscode.DebugThread | vscode.DebugStackFrame | undefined): void {
        const info = item && this.sessions.get(item.session.id);
        if (!info || info.focusedThread === item.threadId) {
            return;
        }
        info.focusedThread = item.threadId;
        if (info === this.current) {
            this.updatePanels();
        }
    }

    private onAdapterMessage(session: vscode.DebugSession, m: DebugProtocol.ProtocolMessage): void {
        const info = this.sessions.get(session.id);
        if (m.type !== "event" || !info) {
            return;
        }
        const e = m as DebugProtocol.Event;
        const isCurrent = info === this.current;
        switch (e.event) {
            case "initialized":
                // Attached: the agent's memory contexts can be listed now.
                info.physical = undefined;
                if (isCurrent) {
                    this.updatePanels();
                }
                break;
            case "continued":
                info.running = true;
                if (isCurrent) {
                    this.panels.forEach((p) => p.onContinued());
                }
                break;
            case "stopped": {
                const body = (e as DebugProtocol.StoppedEvent).body;
                info.running = false;
                // Other threads stopping at the same time have preserveFocusHint.
                if (!body.preserveFocusHint && body.threadId !== undefined) {
                    info.focusedThread = body.threadId;
                }
                if (isCurrent) {
                    this.updatePanels();
                }
                break;
            }
            case req.MEMORY_CHANGED_EVENT:
                if (isCurrent) {
                    this.panels.forEach((p) => p.onMemoryChanged());
                }
                break;
            case req.FIND_MEMORY_PROGRESS_EVENT: {
                const body = e.body as req.FindMemoryProgressEventBody;
                this.finds.get(body.findId)?.onFindProgress(body.findId, body.address);
                break;
            }
        }
    }

    private updatePanels(): void {
        this.panels.forEach((p) => p.update());
    }
}

/** Settings from storage or the webview, with defaults for invalid values. */
function validSettings(value: unknown): PanelSettings {
    const s = (value ?? {}) as Partial<PanelSettings>;
    const f = (s.find ?? {}) as Partial<PanelSettings["find"]>;
    const d = DEFAULT_SETTINGS;
    const oneOf = <T>(v: unknown, options: readonly T[], fallback: T): T =>
        options.includes(v as T) ? (v as T) : fallback;
    const endianness = ["little", "big"] as const;
    return {
        groupSize: oneOf(s.groupSize, GROUP_SIZES, d.groupSize),
        endianness: oneOf(s.endianness, endianness, d.endianness),
        bytesPerRow: oneOf(s.bytesPerRow, BYTES_PER_ROW_OPTIONS, d.bytesPerRow),
        inspector: typeof s.inspector === "boolean" ? s.inspector : d.inspector,
        find: {
            format: oneOf(f.format, ["hex", "text", "int"] as const, d.find.format),
            intSize: oneOf(f.intSize, INT_SIZES, d.find.intSize),
            endianness: oneOf(f.endianness, endianness, d.find.endianness),
            alignment: oneOf(f.alignment, [1, 2, 4, 8, 16], d.find.alignment),
            rangeStart: typeof f.rangeStart === "string" ? f.rangeStart : d.find.rangeStart,
            rangeEnd: typeof f.rangeEnd === "string" ? f.rangeEnd : d.find.rangeEnd,
        },
    };
}
