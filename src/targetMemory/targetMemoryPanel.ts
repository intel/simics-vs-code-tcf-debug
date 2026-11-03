import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { formatHex, hexString as hex, parseAddress } from "../shared/targetMemory/format";
import {
    TARGET_MEMORY_VIEW_TYPE,
    type ContextMenuCommand,
    type FromWebview,
    type MemoryTarget,
    type MenuTarget,
    type TargetState,
    type ToWebview,
} from "../shared/targetMemory/protocol";
import type { TargetMemoryClient } from "./memoryClient";
import type { TargetMemoryManager } from "./targetMemoryManager";

/** Largest read the webview may ask for. */
const MAX_READ = 0x10000;

/**
 * One Target Memory panel: a hex view of the memory of the focused thread or
 * of a physical memory context. Memory is read when the webview asks for it,
 * and read again when the target stops or memory changes.
 */
export class TargetMemoryPanel implements vscode.Disposable {
    readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private ready = false;
    private target: MemoryTarget = { kind: "thread" };
    private state: TargetState = {
        target: this.target,
        physicalContexts: [],
        addressSize: 8,
        running: false,
        canRead: false,
        canWrite: false,
        epoch: 0,
    };
    /** Session and context shown, a change makes cached memory stale. */
    private contextKey: string | undefined;
    // Whether the target ran since memory was last read, so it may have changed.
    private ranSinceRefresh = false;
    private updates = Promise.resolve();
    private find: { id: number; webviewId: number; client: TargetMemoryClient } | undefined;
    private pendingReveal: { address: bigint; length?: number } | undefined;
    private memoryChangedTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly manager: TargetMemoryManager,
        extensionUri: vscode.Uri,
        title: string,
    ) {
        this.panel = vscode.window.createWebviewPanel(TARGET_MEMORY_VIEW_TYPE, title, vscode.ViewColumn.Active, {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
            retainContextWhenHidden: true,
        });
        this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri);
        this.disposables.push(
            this.panel.onDidDispose(() => this.onDisposed()),
            this.panel.onDidChangeViewState((e) => {
                if (e.webviewPanel.active) {
                    manager.panelActivated(this);
                }
            }),
            this.panel.webview.onDidReceiveMessage((m: FromWebview) => {
                this.onMessage(m).catch((err: unknown) =>
                    manager.log.error(`Target Memory: ${m.type} failed: ${errorText(err)}`),
                );
            }),
        );
        this.update();
    }

    reveal(address: bigint, length?: number): void {
        this.panel.reveal(undefined, false);
        if (this.ready) {
            this.post({
                type: "reveal",
                address: hex(address),
                ...(length !== undefined && { length }),
            });
        } else {
            this.pendingReveal = { address, length };
        }
    }

    runCommand(command: ContextMenuCommand, target?: MenuTarget): void {
        if (command === "goto" || command === "find") {
            // Keybindings also work while another view has the focus.
            this.panel.reveal(undefined, false);
        }
        this.post({
            type: "command",
            command,
            ...(target !== undefined && { target }),
        });
    }

    onFindProgress(findId: number, address: string): void {
        if (this.find?.id === findId) {
            this.post({
                type: "findProgress",
                id: this.find.webviewId,
                address,
            });
        }
    }

    /** The current session, focused thread or physical contexts changed. */
    update(): void {
        this.enqueue(() => this.updateState());
    }

    onContinued(): void {
        this.ranSinceRefresh = true;
        this.update();
    }

    onMemoryChanged(): void {
        // Agents send one event per write, refresh once.
        clearTimeout(this.memoryChangedTimer);
        this.memoryChangedTimer = setTimeout(() => {
            if (this.state.canRead) {
                this.post({ type: "refresh", epoch: this.state.epoch });
            }
        }, 100);
    }

    dispose(): void {
        this.panel.dispose();
    }

    private onDisposed(): void {
        this.cancelFind();
        clearTimeout(this.memoryChangedTimer);
        this.disposables.forEach((d) => d.dispose());
        this.manager.panelDisposed(this);
    }

    private enqueue(fn: () => Promise<void>): void {
        this.updates = this.updates
            .then(fn)
            .catch((err: unknown) => this.manager.log.error(`Target Memory update failed: ${errorText(err)}`));
    }

    private async updateState(): Promise<void> {
        const info = this.manager.session;
        const physicalContexts = info ? await this.manager.physicalContexts(info) : [];
        const target = this.target;
        if (target.kind === "physical" && info && !physicalContexts.some((c) => c.id === target.contextId)) {
            this.target = { kind: "thread" };
        }

        let contextId: string | undefined;
        let contextLabel: string | undefined;
        let notice: string | undefined;
        let running = false;
        let addressSize = 8;
        if (!info) {
            notice = "Start a Simics Target Debug session to see target memory.";
        } else if (this.target.kind === "physical") {
            const id = this.target.contextId;
            contextId = id;
            contextLabel = physicalContexts.find((c) => c.id === id)?.label;
            running = info.running;
        } else if (info.focusedThread === undefined) {
            notice = "Select a thread in the Call Stack view.";
        } else {
            const threadId = info.focusedThread;
            try {
                contextId = await info.client.contextForThread(threadId);
                running = !(await info.client.isSuspended(contextId));
                contextLabel =
                    (await info.client.threadName(threadId).catch(() => {
                        return undefined;
                    })) ?? contextId;
            } catch (err) {
                contextId = undefined;
                notice = `The memory of the thread cannot be shown: ${errorText(err)}`;
            }
        }
        if (info && contextId !== undefined) {
            const size = (await info.client.contextInfo(contextId)).addressSize;
            if (size !== undefined && size >= 1 && size <= 8) {
                addressSize = size;
            }
        }

        const key = info && contextId !== undefined ? `${info.session.id}\n${contextId}` : undefined;
        let epoch = this.state.epoch;
        if (key !== this.contextKey) {
            this.contextKey = key;
            epoch++;
            this.cancelFind();
            this.ranSinceRefresh = false;
        }
        // Physical memory can be read while the target runs, thread memory not.
        const canRead = contextId !== undefined && (this.target.kind === "physical" || !running);
        this.state = {
            ...(info && { session: info.session.name }),
            target: this.target,
            ...(contextId !== undefined && { contextId }),
            ...(contextLabel !== undefined && { contextLabel }),
            physicalContexts,
            addressSize,
            running,
            canRead,
            canWrite: canRead,
            ...(notice !== undefined && { notice }),
            epoch,
        };
        this.post({ type: "state", state: this.state });
        if (canRead && !running && this.ranSinceRefresh) {
            this.ranSinceRefresh = false;
            this.post({ type: "refresh", epoch });
        }
    }

    private async onMessage(m: FromWebview): Promise<void> {
        switch (m.type) {
            case "ready":
                this.ready = true;
                this.post({
                    type: "init",
                    settings: this.manager.settings,
                    ...(this.manager.lastAddress !== undefined && {
                        address: this.manager.lastAddress,
                    }),
                });
                this.post({ type: "state", state: this.state });
                if (this.pendingReveal) {
                    const { address, length } = this.pendingReveal;
                    this.pendingReveal = undefined;
                    this.reveal(address, length);
                }
                break;
            case "read":
                await this.read(m.epoch, m.seq, m.address, m.length);
                break;
            case "write":
                await this.write(m.epoch, m.writes);
                break;
            case "setTarget":
                this.target = m.target;
                this.update();
                break;
            case "goto":
                try {
                    const address = await this.manager.resolveAddress(m.expression);
                    this.post({ type: "reveal", address: hex(address) });
                } catch (err) {
                    this.post({ type: "gotoError", message: errorText(err) });
                }
                break;
            case "refresh":
                this.manager.refreshPhysicalContexts();
                if (this.state.canRead) {
                    this.post({ type: "refresh", epoch: this.state.epoch });
                }
                break;
            case "find":
                await this.runFind(m);
                break;
            case "cancelFind":
                this.cancelFind();
                break;
            case "settings":
                this.manager.saveSettings(m.settings);
                break;
            case "position":
                this.manager.saveAddress(m.address);
                break;
            case "copy":
                await vscode.env.clipboard.writeText(m.text);
                break;
        }
    }

    private async read(epoch: number, seq: number, addressText: string, length: number): Promise<void> {
        const info = this.manager.session;
        const contextId = this.state.contextId;
        const address = parseAddress(addressText);
        const fail = (error: string) =>
            this.post({
                type: "readError",
                epoch,
                seq,
                address: addressText,
                error,
            });
        if (epoch !== this.state.epoch || !this.state.canRead || !info || contextId === undefined) {
            fail("Memory cannot be read now");
            return;
        }
        if (address === undefined || !(length > 0 && length <= MAX_READ)) {
            fail("Invalid read request");
            return;
        }
        try {
            const r = await info.client.read(contextId, address, length);
            this.post({
                type: "data",
                epoch,
                seq,
                address: addressText,
                bytes: Array.from(r.bytes),
                unreadable: r.unreadable,
            });
        } catch (err) {
            fail(errorText(err));
        }
    }

    private async write(epoch: number, writes: { address: string; bytes: number[] }[]): Promise<void> {
        const info = this.manager.session;
        const contextId = this.state.contextId;
        if (epoch !== this.state.epoch || !this.state.canWrite || !info || contextId === undefined) {
            this.post({
                type: "writeResult",
                ok: false,
                message: this.state.running
                    ? "Memory cannot be written while the target is running"
                    : "Memory cannot be written now",
            });
            return;
        }
        const errors: string[] = [];
        for (const w of writes) {
            const address = parseAddress(w.address);
            if (address === undefined) {
                errors.push(`Invalid address ${w.address}`);
                continue;
            }
            try {
                await info.client.write(contextId, address, Uint8Array.from(w.bytes));
            } catch (err) {
                errors.push(`0x${formatHex(address, 1)}: ${errorText(err)}`);
            }
        }
        if (errors.length > 0) {
            this.manager.log.error(`Target Memory: writing failed: ${errors.join("; ")}`);
        }
        this.post({
            type: "writeResult",
            ok: errors.length === 0,
            ...(errors.length > 0 && { message: errors.join("; ") }),
        });
        // Show what is in memory now, also where a write failed.
        this.post({ type: "refresh", epoch: this.state.epoch });
    }

    private async runFind(m: Extract<FromWebview, { type: "find" }>): Promise<void> {
        const info = this.manager.session;
        const contextId = this.state.contextId;
        if (m.epoch !== this.state.epoch || !this.state.canRead || !info || contextId === undefined) {
            this.post({
                type: "findResult",
                id: m.id,
                outcome: "error",
                message: this.state.running
                    ? "Memory cannot be searched while the target is running"
                    : "Memory cannot be searched now",
            });
            return;
        }
        this.cancelFind();
        const findId = this.manager.startFind(this);
        const find = { id: findId, webviewId: m.id, client: info.client };
        this.find = find;
        try {
            const r = await info.client.find({
                findId,
                contextId,
                needle: Buffer.from(Uint8Array.from(m.needle)).toString("base64"),
                alignment: m.alignment,
                start: m.start,
                end: m.end,
                direction: m.direction,
            });
            if (r.outcome === "found" && r.address !== undefined) {
                this.post({
                    type: "findResult",
                    id: m.id,
                    outcome: "found",
                    address: r.address,
                    length: m.needle.length,
                });
            } else if (r.outcome === "notFound") {
                const failed = r.failedReads ?? 0;
                this.post({
                    type: "findResult",
                    id: m.id,
                    outcome: "notFound",
                    ...(failed > 0 && {
                        message: `${failed} reads failed, for example: ${r.firstError ?? "unknown error"}`,
                    }),
                });
            } else {
                this.post({
                    type: "findResult",
                    id: m.id,
                    outcome: "cancelled",
                });
            }
        } catch (err) {
            this.post({
                type: "findResult",
                id: m.id,
                outcome: "error",
                message: errorText(err),
            });
        } finally {
            this.manager.endFind(findId);
            if (this.find === find) {
                this.find = undefined;
            }
        }
    }

    private cancelFind(): void {
        const find = this.find;
        if (find) {
            this.find = undefined;
            find.client
                .cancelFind(find.id)
                .catch((err: unknown) =>
                    this.manager.log.warn(`Target Memory: cancelling the search failed: ${errorText(err)}`),
                );
        }
    }

    private post(message: ToWebview): void {
        if (this.ready) {
            void this.panel.webview.postMessage(message);
        }
    }
}

export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const out = vscode.Uri.joinPath(extensionUri, "out");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(out, "target-memory.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(out, "target-memory.css"));
    const nonce = randomBytes(16).toString("hex");
    const csp = [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource} data:`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Target Memory</title>
    <link rel="stylesheet" href="${style.toString()}">
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
}
