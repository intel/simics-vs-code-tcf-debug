import * as vscode from "vscode";
import * as req from "@/tcfRequests";
import { MemoryAccessMode, type ByteRange } from "@/tcf/services/memory";

export interface ReadResult {
    bytes: Uint8Array;
    unreadable: ByteRange[];
}

/**
 * Accesses the memory of a "simics-target-debug" debug session for the Target Memory
 * view, through custom DAP requests (see tcfRequests.ts).
 */
export class TargetMemoryClient {
    // DAP thread IDs are never reused within a session.
    private readonly threadContexts = new Map<number, string>();
    private readonly contextInfos = new Map<string, Promise<req.MemoryContextInfoResult>>();

    constructor(readonly session: vscode.DebugSession) {}

    async contextForThread(threadId: number): Promise<string> {
        let ctx = this.threadContexts.get(threadId);
        if (ctx === undefined) {
            const args: req.ThreadContextArgs = { threadId };
            ({ contextId: ctx } = await this.request<req.ThreadContextResult>(req.TcfRequest.ThreadContext, args));
            this.threadContexts.set(threadId, ctx);
        }
        return ctx;
    }

    async isSuspended(contextId: string): Promise<boolean> {
        const args: req.ContextSuspendedArgs = { contextId };
        const result = await this.request<req.ContextSuspendedResult>(req.TcfRequest.ContextSuspended, args);
        return result.suspended;
    }

    async threadName(threadId: number): Promise<string | undefined> {
        const result = (await this.session.customRequest("threads")) as
            { threads?: { id: number; name: string }[] } | undefined;
        return result?.threads?.find((t) => t.id === threadId)?.name;
    }

    /** Physical memory contexts with their full names. */
    async physicalMemoryContexts(): Promise<{ id: string; name: string }[]> {
        const result = await this.request<req.PhysicalMemoryContextsResult>(req.TcfRequest.PhysicalMemoryContexts);
        return result.contexts.map((id, i) => ({
            id,
            name: result.names?.[i] ?? id,
        }));
    }

    /** Memory context properties, cached. Empty if they cannot be read. */
    contextInfo(contextId: string): Promise<req.MemoryContextInfoResult> {
        let info = this.contextInfos.get(contextId);
        if (!info) {
            const args: req.MemoryContextInfoArgs = { contextId };
            info = this.request<req.MemoryContextInfoResult>(req.TcfRequest.MemoryContextInfo, args).catch(() => ({}));
            this.contextInfos.set(contextId, info);
        }
        return info;
    }

    async read(contextId: string, address: bigint, size: number): Promise<ReadResult> {
        const args: req.ReadMemoryArgs = {
            contextId,
            address: `0x${address.toString(16)}`,
            wordSize: 1,
            size,
            mode: MemoryAccessMode.ContinueOnError,
        };
        const result = await this.request<req.ReadMemoryResult>(req.TcfRequest.ReadMemory, args);
        return {
            bytes: new Uint8Array(Buffer.from(result.data, "base64")),
            unreadable: result.unreadable,
        };
    }

    async write(contextId: string, address: bigint, bytes: Uint8Array): Promise<void> {
        const args: req.WriteMemoryArgs = {
            contextId,
            address: `0x${address.toString(16)}`,
            wordSize: 1,
            data: Buffer.from(bytes).toString("base64"),
            mode: 0,
        };
        await this.request(req.TcfRequest.WriteMemory, args);
    }

    find(args: req.FindMemoryArgs): Promise<req.FindMemoryResult> {
        return this.request<req.FindMemoryResult>(req.TcfRequest.FindMemory, args);
    }

    async cancelFind(findId: number): Promise<void> {
        const args: req.CancelFindMemoryArgs = { findId };
        await this.request(req.TcfRequest.CancelFindMemory, args);
    }

    /** Evaluates an expression in a frame, returns the value as text. */
    async evaluate(expression: string, frameId?: number): Promise<string> {
        const args: { expression: string; context: string; frameId?: number } = { expression, context: "watch" };
        if (frameId !== undefined) {
            args.frameId = frameId;
        }
        const result = (await this.session.customRequest("evaluate", args)) as {
            result: string;
        };
        return result.result;
    }

    private async request<T>(command: req.TcfRequest, args?: object): Promise<T> {
        return (await this.session.customRequest(command, args)) as T;
    }
}
