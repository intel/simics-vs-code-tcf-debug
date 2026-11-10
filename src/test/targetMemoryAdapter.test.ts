import { test } from "node:test";
import assert from "node:assert/strict";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { TcfDebugSession } from "@/tcfDebugSession";
import type { MemoryReadResult } from "@/tcf/services/memory";
import * as req from "@/tcfRequests";

/** A debug session with a fake Memory service holding `data` at `base`. */
function sessionWithMemory(
    base: bigint,
    data: Uint8Array,
    delayMs = 0,
): {
    session: TcfDebugSession;
    reads: bigint[];
    events: DebugProtocol.Event[];
    request(command: string, args: object): Promise<DebugProtocol.Response>;
} {
    const session = new TcfDebugSession();
    const reads: bigint[] = [];
    const events: DebugProtocol.Event[] = [];
    (session as unknown as { memory: unknown }).memory = {
        get: async (_id: string, address: bigint, _wordSize: number, size: number): Promise<MemoryReadResult> => {
            reads.push(address);
            await new Promise((r) => setTimeout(r, delayMs));
            const bytes = Buffer.alloc(size);
            const unreadable = [];
            for (let i = 0; i < size; i++) {
                const offset = address + BigInt(i) - base;
                if (offset >= 0n && offset < BigInt(data.length)) {
                    bytes[i] = data[Number(offset)];
                } else {
                    unreadable.push({ offset: i, size: 1 });
                }
            }
            return { bytes, unreadable };
        },
        getContext: async (id: string) => {
            if (id !== "mem") {
                throw new Error("No such context");
            }
            return { ID: id, Name: "phys_mem", AddressSize: 4 };
        },
    };
    let seq = 0;
    // The session has room for one message listener only.
    const pending = new Map<number, (r: DebugProtocol.Response) => void>();
    session.onDidSendMessage((m) => {
        const message = m as DebugProtocol.ProtocolMessage;
        if (message.type === "event") {
            events.push(m as DebugProtocol.Event);
        } else if (message.type === "response") {
            const r = m as DebugProtocol.Response;
            pending.get(r.request_seq)?.(r);
            pending.delete(r.request_seq);
        }
    });
    const request = (command: string, args: object) =>
        new Promise<DebugProtocol.Response>((resolve) => {
            const next = ++seq;
            pending.set(next, resolve);
            session.handleMessage({
                seq: next,
                type: "request",
                command,
                arguments: args,
            } as DebugProtocol.Request);
        });
    return { session, reads, events, request };
}

const findArgs = (needle: number[], change: Partial<req.FindMemoryArgs> = {}): req.FindMemoryArgs => ({
    findId: 1,
    contextId: "mem",
    needle: Buffer.from(needle).toString("base64"),
    alignment: 1,
    start: "0x0",
    end: "0xfffff",
    direction: "forward",
    ...change,
});

test("tcfFindMemory finds an aligned value in the range", async () => {
    const data = new Uint8Array(0x30000);
    data.set([0x11, 0x22, 0x33, 0x44], 0x12345);
    data.set([0x11, 0x22, 0x33, 0x44], 0x23450);
    const { request } = sessionWithMemory(0x10000n, data);

    let r = await request(req.TcfRequest.FindMemory, findArgs([0x11, 0x22, 0x33, 0x44]));
    assert.equal(r.success, true);
    assert.deepEqual(r.body, { outcome: "found", address: "0x22345" });

    r = await request(req.TcfRequest.FindMemory, findArgs([0x11, 0x22, 0x33, 0x44], { alignment: 16 }));
    assert.deepEqual(r.body, { outcome: "found", address: "0x33450" });

    r = await request(
        req.TcfRequest.FindMemory,
        findArgs([0x11, 0x22, 0x33, 0x44], {
            direction: "backward",
            end: "0x33000",
        }),
    );
    assert.deepEqual(r.body, { outcome: "found", address: "0x22345" });

    r = await request(req.TcfRequest.FindMemory, findArgs([0x55, 0x66], { end: "0x3ffff" }));
    assert.deepEqual(r.body, { outcome: "notFound", failedReads: 0 });
});

test("tcfCancelFindMemory stops a running search", async () => {
    const { request, reads, events } = sessionWithMemory(0n, new Uint8Array(0x100000), 5);
    const find = request(req.TcfRequest.FindMemory, findArgs([1, 2, 3], { findId: 7, end: "0xffffffff" }));
    await new Promise((r) => setTimeout(r, 400));
    const cancel = await request(req.TcfRequest.CancelFindMemory, {
        findId: 7,
    });
    assert.equal(cancel.success, true);
    const r = await find;
    assert.deepEqual(r.body, { outcome: "cancelled" });
    assert.ok(reads.length > 4 && reads.length < 0x10000);
    const progress = events.filter((e) => e.event === req.FIND_MEMORY_PROGRESS_EVENT);
    assert.ok(progress.length > 0);
    assert.equal((progress[0].body as req.FindMemoryProgressEventBody).findId, 7);
});

test("tcfMemoryContextInfo returns the context properties", async () => {
    const { request } = sessionWithMemory(0n, new Uint8Array(1));
    let r = await request(req.TcfRequest.MemoryContextInfo, {
        contextId: "mem",
    });
    assert.deepEqual(r.body, { name: "phys_mem", addressSize: 4 });
    r = await request(req.TcfRequest.MemoryContextInfo, {
        contextId: "cpu0",
    });
    assert.equal(r.success, true);
    assert.deepEqual(r.body, {});
});

test("physical memory contexts have full names like threads", async () => {
    const { session, request } = sessionWithMemory(0n, new Uint8Array(1));
    // Run control: board > mb > cpu0, and cpu_mem below mb.
    const contexts = (session as unknown as { contexts: Map<string, object> }).contexts;
    contexts.set("b", { ID: "b", Name: "board" });
    contexts.set("mb", { ID: "mb", ParentID: "b", Name: "mb" });
    contexts.set("cm", { ID: "cm", ParentID: "mb", Name: "cpu_mem" });
    // Memory: board and mb are containers without a Memory context, pm is
    // only a Memory context.
    const children: Record<string, string[]> = {
        root: ["b"],
        b: ["mb"],
        mb: ["pm", "cm", "v"],
    };
    const memoryContexts: Record<string, object> = {
        pm: { ID: "pm", Name: "phys_mem", AccessTypes: ["data", "physical"] },
        cm: { ID: "cm", Name: "cm", AccessTypes: ["physical"] },
        v: { ID: "v", Name: "virt", AccessTypes: ["virtual"] },
    };
    const memory = (session as unknown as { memory: Record<string, unknown> }).memory;
    memory.getChildren = async (id: string | null) => children[id ?? "root"] ?? [];
    memory.getContext = async (id: string) => {
        const ctx = memoryContexts[id];
        if (!ctx) {
            throw new Error("No such context");
        }
        return ctx;
    };
    const r = await request(req.TcfRequest.PhysicalMemoryContexts, {});
    assert.deepEqual(r.body, {
        contexts: ["pm", "cm"],
        names: ["board.mb.phys_mem", "board.mb.cpu_mem"],
    });
});
