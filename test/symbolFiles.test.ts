import { DebugProtocol } from "@vscode/debugprotocol";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SymbolFile, applySymbolFiles } from "../src/symbolFiles";
import { TcfChannel } from "../src/tcf/channel";
import { MemoryMapService, MemoryRegionProperties } from "../src/tcf/services/memoryMap";
import { TcfDebugSession } from "../src/tcfDebugSession";

test("removing the last symbol file clears its context map", async () => {
    const calls: { context: string; regions: MemoryRegionProperties[] }[] = [];
    const service = {
        set: async (context: string, regions: MemoryRegionProperties[]) => {
            calls.push({ context, regions });
        },
    } as MemoryMapService;
    const previousFiles: SymbolFile[] = [
        { path: "/first.elf", context: "cpu0" },
        { path: "/second.elf", context: "cpu1" },
    ];

    await applySymbolFiles(service, [previousFiles[1]], () => {}, previousFiles);
    assert.deepEqual(calls, [
        {
            context: "cpu1",
            regions: [{ ID: "vscode-symbol-file-1", FileName: "/second.elf" }],
        },
        { context: "cpu0", regions: [] },
    ]);
});

test("startup reports only symbol files missing on the local host", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tcf-symbol-missing-"));
    try {
        const present = path.join(directory, "present.elf");
        const missing = path.join(directory, "missing.elf");
        await fs.writeFile(present, "");
        const session = new TcfDebugSession();
        const state = session as unknown as {
            symbolFiles: SymbolFile[];
            reportMissingSymbolFiles(): void;
        };
        state.symbolFiles = [
            { path: present, context: "" },
            { path: missing, context: "cpu0" },
        ];
        const events: DebugProtocol.Event[] = [];
        session.onDidSendMessage((message) => {
            const event = message as DebugProtocol.Event;
            if (event.type === "event" && event.event === "symbolFilesMissing") {
                events.push(event);
            }
        });

        state.reportMissingSymbolFiles();
        assert.deepEqual(
            events.map((event) => event.body),
            [{ files: [{ index: 1, path: missing }] }],
        );
        state.symbolFiles = [{ path: present, context: "" }];
        state.reportMissingSymbolFiles();
        assert.equal(events.length, 1);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("a rejected startup map still leaves its missing file available to update", async () => {
    const session = new TcfDebugSession();
    const missing = path.join(os.tmpdir(), `missing-tcf-${process.pid}-${Date.now()}.elf`);
    const state = session as unknown as {
        symbolFiles: SymbolFile[];
        loadSymbolFiles(channel: TcfChannel, config: unknown): Promise<void>;
        reportMissingSymbolFiles(): void;
    };
    const channel = {
        hasService: (name: string) => name === MemoryMapService.NAME,
        onEvent: () => {},
        command: async () => {
            throw new Error("agent rejected missing path");
        },
    } as unknown as TcfChannel;
    const events: DebugProtocol.Event[] = [];
    session.onDidSendMessage((message) => {
        const event = message as DebugProtocol.Event;
        if (event.type === "event" && event.event === "symbolFilesMissing") {
            events.push(event);
        }
    });

    await state.loadSymbolFiles(channel, [{ path: missing }]);
    assert.equal(state.symbolFiles[0].path, missing);
    state.reportMissingSymbolFiles();
    assert.deepEqual(
        events.map((event) => event.body),
        [{ files: [{ index: 0, path: missing }] }],
    );
});

test("adding, reloading and removing symbol files preserves the session map", async () => {
    const session = new TcfDebugSession();
    const calls: { context: string; regions: MemoryRegionProperties[] }[] = [];
    const state = session as unknown as {
        channel: TcfChannel;
        memoryMap: MemoryMapService;
        symbolFiles: SymbolFile[];
    };
    state.channel = {} as TcfChannel;
    state.memoryMap = {
        set: async (context: string, regions: MemoryRegionProperties[]) => {
            calls.push({ context, regions });
        },
    } as MemoryMapService;
    state.symbolFiles = [{ path: "/configured.elf", context: "" }];

    let sequence = 0;
    async function request(command: string, args?: unknown): Promise<DebugProtocol.Response> {
        return new Promise((resolve) => {
            const listener = session.onDidSendMessage((message) => {
                const response = message as DebugProtocol.Response;
                if (response.type === "response" && response.request_seq === sequence) {
                    listener.dispose();
                    resolve(response);
                }
            });
            session.handleMessage({
                seq: ++sequence,
                type: "request",
                command,
                arguments: args,
            } as DebugProtocol.Request);
        });
    }

    assert.deepEqual((await request("getSymbolFiles")).body, {
        supported: true,
        files: [{ path: "/configured.elf", context: "" }],
    });
    assert.equal((await request("addSymbolFile", { path: "/new.elf", address: "0x1000" })).success, true);
    assert.deepEqual((await request("getSymbolFiles")).body, {
        supported: true,
        files: [
            { path: "/configured.elf", context: "" },
            { path: "/new.elf", context: "", address: "4096" },
        ],
    });
    assert.deepEqual(calls.slice(), [
        {
            context: "",
            regions: [
                { ID: "vscode-symbol-file-1", FileName: "/configured.elf" },
                { ID: "vscode-symbol-file-2", FileName: "/new.elf", BaseAddress: 0x1000n },
            ],
        },
    ]);
    assert.equal(state.symbolFiles.length, 2);

    assert.equal(
        (
            await request("addSymbolFile", {
                path: "/bad.elf",
                address: "not-an-address",
            })
        ).success,
        false,
    );
    assert.equal(calls.length, 1);
    assert.equal(state.symbolFiles.length, 2);

    state.memoryMap = {
        set: async () => {
            throw new Error("agent rejected map");
        },
    } as unknown as MemoryMapService;
    assert.equal((await request("addSymbolFile", { path: "/rejected.elf" })).success, false);
    assert.equal(state.symbolFiles.length, 2);
    const configured = { index: 0, path: "/configured.elf", context: "" };
    const added = { index: 1, path: "/new.elf", context: "", address: "4096" };
    assert.equal(
        (
            await request("replaceSymbolFile", {
                ...added,
                file: { path: "/fixed.elf", context: "", address: "4096" },
            })
        ).success,
        false,
    );
    assert.equal(state.symbolFiles[1].path, "/new.elf");
    assert.equal((await request("removeSymbolFile", added)).success, false);
    assert.equal(state.symbolFiles.length, 2);

    state.memoryMap = {
        set: async (context: string, regions: MemoryRegionProperties[]) => {
            calls.push({ context, regions });
        },
    } as MemoryMapService;
    assert.equal(
        (
            await request("replaceSymbolFile", {
                ...added,
                file: { path: "/fixed.elf", context: "", address: "4096" },
            })
        ).success,
        true,
    );
    assert.deepEqual(calls.at(-1), {
        context: "",
        regions: [
            { ID: "vscode-symbol-file-1", FileName: "/configured.elf" },
            { ID: "vscode-symbol-file-2", FileName: "/fixed.elf", BaseAddress: 0x1000n },
        ],
    });
    assert.equal(
        (
            await request("replaceSymbolFile", {
                ...added,
                file: { path: "/wrong.elf", context: "cpu1", address: "4096" },
            })
        ).success,
        false,
    );
    assert.equal(state.symbolFiles[1].path, "/fixed.elf");
    assert.equal(
        (
            await request("replaceSymbolFile", {
                ...added,
                path: "/fixed.elf",
                file: { path: "/wrong.elf", context: "cpu1", address: "4096" },
            })
        ).success,
        true,
    );
    assert.deepEqual(calls.slice(-2), [
        { context: "", regions: [{ ID: "vscode-symbol-file-1", FileName: "/configured.elf" }] },
        { context: "cpu1", regions: [{ ID: "vscode-symbol-file-2", FileName: "/wrong.elf", BaseAddress: 0x1000n }] },
    ]);
    assert.equal(state.symbolFiles[1].context, "cpu1");
    assert.equal(
        (
            await request("replaceSymbolFile", {
                ...added,
                path: "/wrong.elf",
                context: "cpu1",
                file: { path: "/wrong.elf", context: "cpu1", contextQuery: "HasState=true", address: "0x2000" },
            })
        ).success,
        true,
    );
    assert.deepEqual(calls.at(-1), {
        context: "cpu1",
        regions: [
            { ID: "vscode-symbol-file-2", FileName: "/wrong.elf", ContextQuery: "HasState=true", BaseAddress: 0x2000n },
        ],
    });
    assert.equal(
        (
            await request("replaceSymbolFile", {
                index: 1,
                path: "/wrong.elf",
                context: "cpu1",
                contextQuery: "HasState=true",
                address: "8192",
                file: { path: "/wrong.elf", context: "cpu1" },
            })
        ).success,
        true,
    );
    assert.deepEqual(calls.at(-1), {
        context: "cpu1",
        regions: [{ ID: "vscode-symbol-file-2", FileName: "/wrong.elf" }],
    });
    assert.equal(
        (
            await request("replaceSymbolFile", {
                index: 1,
                path: "/wrong.elf",
                context: "cpu1",
                file: { path: "/wrong.elf", context: "cpu1", address: "not-an-address" },
            })
        ).success,
        false,
    );
    assert.equal(state.symbolFiles[1].address, undefined);
    assert.equal(
        (
            await request("replaceSymbolFile", {
                index: 1,
                path: "/wrong.elf",
                context: "cpu1",
                file: { path: "/new.elf", context: "", address: "4096" },
            })
        ).success,
        true,
    );
    assert.deepEqual(calls.slice(-2), [
        {
            context: "",
            regions: [
                { ID: "vscode-symbol-file-1", FileName: "/configured.elf" },
                { ID: "vscode-symbol-file-2", FileName: "/new.elf", BaseAddress: 0x1000n },
            ],
        },
        { context: "cpu1", regions: [] },
    ]);
    assert.equal((await request("reloadSymbolFile", added)).success, true);
    assert.deepEqual(calls.slice(-2), [
        { context: "", regions: [] },
        {
            context: "",
            regions: [
                { ID: "vscode-symbol-file-1", FileName: "/configured.elf" },
                { ID: "vscode-symbol-file-2", FileName: "/new.elf", BaseAddress: 0x1000n },
            ],
        },
    ]);
    assert.equal((await request("reloadSymbolFiles")).success, true);
    assert.deepEqual(calls.slice(-2), [
        { context: "", regions: [] },
        {
            context: "",
            regions: [
                { ID: "vscode-symbol-file-1", FileName: "/configured.elf" },
                { ID: "vscode-symbol-file-2", FileName: "/new.elf", BaseAddress: 0x1000n },
            ],
        },
    ]);

    state.symbolFiles[1] = { path: "/new.elf", context: "cpu1", address: 0x1000n };
    assert.equal((await request("removeSymbolFile", added)).success, false);
    state.symbolFiles[1] = { path: "/new.elf", context: "", address: 0x1000n };
    assert.equal((await request("removeSymbolFile", added)).success, true);
    assert.equal(state.symbolFiles.length, 1);
    assert.equal((await request("removeSymbolFile", added)).success, false);
    assert.equal(state.symbolFiles.length, 1);
    assert.equal((await request("removeSymbolFile", configured)).success, true);
    assert.deepEqual(calls.at(-1), { context: "", regions: [] });
    assert.deepEqual((await request("getSymbolFiles")).body, { supported: true, files: [] });
});
