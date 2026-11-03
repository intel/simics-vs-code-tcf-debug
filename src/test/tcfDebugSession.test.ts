import { test } from "node:test";
import assert from "node:assert/strict";
import { TcfDebugSession, formatRegisterValue, selectStepMode } from "../tcfDebugSession";
import { ResumeMode } from "../tcf/services/runControl";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { LineNumbersService } from "../tcf/services/lineNumbers";
import { PathMapper } from "../pathMapper";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

test(
    "stack frames, missing sources, and live path map edits retain context scope",
    {
        timeout: 5000,
    },
    async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcf-path-scope-"));
        try {
            for (const cpu of ["cpu0", "cpu1"]) {
                fs.mkdirSync(path.join(dir, cpu));
                fs.writeFileSync(path.join(dir, cpu, "main.c"), "");
            }
            const session = new TcfDebugSession();
            const compiled = "/nonexistent-tcf-scope-build/main.c";
            const lineNumbers: Pick<LineNumbersService, "mapToSource"> = {
                mapToSource: async () => [
                    {
                        File: compiled,
                        SLine: 7,
                        SAddr: 0x1000,
                        EAddr: 0x1001,
                    },
                ],
            };
            Object.assign(session, {
                pathMapper: new PathMapper([], undefined),
                lineNumbers,
                ctxByThreadId: new Map([
                    [1, "cpu0"],
                    [2, "cpu1"],
                ]),
                threadStates: new Map([
                    ["cpu0", { suspended: true, pc: 0x1000n }],
                    ["cpu1", { suspended: true, pc: 0x1000n }],
                ]),
                configured: true,
            });
            const events: DebugProtocol.Event[] = [];
            let receive: ((response: DebugProtocol.Response) => void) | undefined;
            let seq = 0;
            session.onDidSendMessage((value) => {
                const message = value as DebugProtocol.ProtocolMessage;
                if (message.type === "response") {
                    receive?.(message as DebugProtocol.Response);
                } else if (message.type === "event") {
                    events.push(message as DebugProtocol.Event);
                }
            });
            const request = (command: string, args: object = {}) =>
                new Promise<DebugProtocol.Response>((resolve) => {
                    receive = resolve;
                    const message: DebugProtocol.Request = {
                        seq: ++seq,
                        type: "request",
                        command,
                        arguments: args,
                    };
                    session.handleMessage(message);
                });
            const frame = async (threadId: number) => {
                const response = await request("stackTrace", { threadId });
                assert.equal(response.success, true);
                const frames: DebugProtocol.StackFrame[] = response.body.stackFrames;
                assert.equal(frames.length, 1);
                return frames[0];
            };
            const first = await frame(1);
            const second = await frame(2);
            assert.notEqual(first.source?.sourceReference, second.source?.sourceReference);
            await request("source", {
                sourceReference: second.source?.sourceReference,
            });
            assert.equal(events.find((event) => event.event === "sourceNotFound")?.body.contextId, "cpu1");
            const missing = await request("getMissingSources");
            assert.deepEqual(
                missing.body.sources.map((source: { contextId: string }) => source.contextId),
                ["cpu0", "cpu1"],
            );
            const rules = [
                {
                    source: path.dirname(compiled),
                    destination: path.join(dir, "cpu0"),
                    context: "cpu0",
                },
                {
                    source: path.dirname(compiled),
                    destination: path.join(dir, "cpu1"),
                    contextQuery: "ID=cpu1",
                },
            ];
            const updated = await request("setPathMapRules", {
                rules,
                expectedRules: [],
            });
            assert.equal(updated.success, true);
            for (const [threadId, cpu] of [
                [1, "cpu0"],
                [2, "cpu1"],
            ] as const) {
                const mapped = await frame(threadId);
                assert.equal(mapped.source?.path, path.join(dir, cpu, "main.c"));
                assert.deepEqual(mapped.source?.adapterData, {
                    contextId: cpu,
                });
            }
            assert.deepEqual((await request("getPathMapRules")).body.rules, rules);
            assert.ok(events.some((event) => event.event === "pathMapChanged"));
            const rejected = await request("addPathMapRule", {
                source: "/a",
                destination: "/b",
                contextQuery: 12,
            });
            assert.equal(rejected.success, false);
            assert.deepEqual((await request("getPathMapRules")).body.rules, rules);
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    },
);

function canResume(...modes: ResumeMode[]): number {
    return modes.reduce((bits, m) => bits | (1 << m), 0);
}

// Contexts without CanResume get line stepping. Step out has no line mode.
test("selectStepMode prefers line stepping if the agent does not say", () => {
    assert.equal(selectStepMode(undefined, "over", undefined), ResumeMode.StepOverLine);
    assert.equal(selectStepMode(undefined, "into", "statement"), ResumeMode.StepIntoLine);
    assert.equal(selectStepMode(undefined, "out", undefined), ResumeMode.StepOut);
});

// VS Code asks for "instruction" granularity, for example in the
// disassembly view.
test("selectStepMode steps by instruction if asked to", () => {
    assert.equal(selectStepMode(undefined, "over", "instruction"), ResumeMode.StepOver);
    assert.equal(selectStepMode(undefined, "into", "instruction"), ResumeMode.StepInto);
    assert.equal(selectStepMode(undefined, "out", "instruction"), ResumeMode.StepOut);
});

// A context that can only step by instruction does that, also when VS
// Code asks for line stepping.
test("selectStepMode falls back to instruction stepping", () => {
    const bits = canResume(ResumeMode.Resume, ResumeMode.StepOver, ResumeMode.StepInto);
    assert.equal(selectStepMode(bits, "over", undefined), ResumeMode.StepOver);
    assert.equal(selectStepMode(bits, "into", "line"), ResumeMode.StepInto);
});

// CanResume has line stepping: it is picked over instruction stepping.
test("selectStepMode uses line stepping if the context can do it", () => {
    const bits = canResume(ResumeMode.StepOver, ResumeMode.StepOverLine, ResumeMode.StepIntoLine);
    assert.equal(selectStepMode(bits, "over", undefined), ResumeMode.StepOverLine);
    assert.equal(selectStepMode(bits, "into", undefined), ResumeMode.StepIntoLine);
});

// No resume mode in CanResume fits the request.
test("selectStepMode returns undefined if the context cannot step", () => {
    assert.equal(selectStepMode(0, "over", undefined), undefined);
    assert.equal(selectStepMode(canResume(ResumeMode.StepOverLine), "over", "instruction"), undefined);
    assert.equal(selectStepMode(canResume(ResumeMode.StepOver), "out", undefined), undefined);
});

// Bytes come in target byte order, little endian unless BigEndian is set.
// Leading zeros are kept, they show the register size.
test("formatRegisterValue shows bytes in target byte order as hex", () => {
    assert.equal(formatRegisterValue({ ID: "r" }, Buffer.from([0x78, 0x56, 0x34, 0x12])), "0x12345678");
    assert.equal(formatRegisterValue({ ID: "r", BigEndian: false }, Buffer.from([0x01, 0x00])), "0x0001");
    assert.equal(formatRegisterValue({ ID: "r", BigEndian: true }, Buffer.from([0x12, 0x34])), "0x1234");
    assert.equal(formatRegisterValue({ ID: "r" }, Buffer.alloc(0)), "");
});

// 4 and 8 byte float registers show the number and the raw hex. Other
// sizes show only hex.
test("formatRegisterValue shows floating point registers as numbers", () => {
    const f32 = Buffer.alloc(4);
    f32.writeFloatLE(1.5);
    assert.equal(formatRegisterValue({ ID: "f", Float: true }, f32), "1.5 (0x3fc00000)");
    const f64 = Buffer.alloc(8);
    f64.writeDoubleBE(-2);
    assert.equal(formatRegisterValue({ ID: "d", Float: true, BigEndian: true }, f64), "-2 (0xc000000000000000)");
    const f80 = Buffer.alloc(10, 0x11);
    assert.equal(formatRegisterValue({ ID: "x", Float: true }, f80), "0x11111111111111111111");
});

// A value listed in Values adds its name. Entries without a name add
// nothing.
test("formatRegisterValue adds the name of a known value", () => {
    const ctx = {
        ID: "mode",
        Values: [
            { Name: "User", Value: Buffer.from([0x10]).toString("base64") },
            { Name: "Kernel", Value: Buffer.from([0x13]).toString("base64") },
            {
                Description: "no name",
                Value: Buffer.from([0x1f]).toString("base64"),
            },
        ],
    };
    assert.equal(formatRegisterValue(ctx, Buffer.from([0x13])), "0x13 (Kernel)");
    assert.equal(formatRegisterValue(ctx, Buffer.from([0x1f])), "0x1f");
    assert.equal(formatRegisterValue(ctx, Buffer.from([0x00])), "0x00");
});

/**
 * A session with fake Disassembly, Symbols and LineNumbers services: 4 byte
 * instructions, function foo at 0x1000 in /src/foo.c line 7.
 */
function disassemblySession(functionHeaders?: boolean) {
    const session = new TcfDebugSession();
    const lookups: bigint[] = [];
    Object.assign(session, {
        disassembly: {
            disassemble: async (_ctx: string, address: bigint, size: number) =>
                Array.from({ length: size / 4 }, (_, i) => ({
                    Address: address + BigInt(i * 4),
                    Size: 4,
                    Instruction: [{ Text: "nop" }],
                })),
        },
        symbols: {
            findByAddr: async (_ctx: string, address: bigint) => {
                lookups.push(address);
                return address >= 0x1000n && address < 0x1010n ? ["foo"] : [];
            },
            getContext: async (id: string) =>
                id === "foo"
                    ? {
                          ID: "foo",
                          Name: "foo",
                          Class: 3,
                          Address: 0x1000,
                          Size: 16,
                          ContainerID: "cu",
                      }
                    : { ID: id, Class: 5 },
        },
        lineNumbers: {
            mapToSource: async () => [{ File: "/src/foo.c", SLine: 7, SAddr: 0x1000, EAddr: 0x1004 }],
        },
        ...(functionHeaders === undefined ? {} : { disassemblyFunctionHeaders: functionHeaders }),
    });
    const disassemble = () =>
        new Promise<DebugProtocol.DisassembleResponse>((resolve) => {
            session.onDidSendMessage((value) => {
                const message = value as DebugProtocol.ProtocolMessage;
                if (message.type === "response") {
                    resolve(value as DebugProtocol.DisassembleResponse);
                }
            });
            session.handleMessage({
                seq: 1,
                type: "request",
                command: "disassemble",
                arguments: {
                    memoryReference: '["cpu0","0x1000"]',
                    instructionCount: 2,
                },
            } as DebugProtocol.Request);
        });
    return { disassemble, lookups };
}

// By default the function entry gets a header with file name and line.
test("disassemble shows function headers by default", async () => {
    const { disassemble } = disassemblySession();
    const response = await disassemble();
    assert.equal(response.success, true);
    const [entry, next] = response.body!.instructions;
    assert.deepEqual(entry.location, {
        name: "foo",
        path: "simics-target-debug-function:/0x1000/7/foo.c/foo",
    });
    assert.equal(entry.line, 7);
    assert.equal(next.location, undefined);
    assert.equal(next.symbol, "foo");
});

// "disassemblyFunctionHeaders": false turns them off, without lookups.
test("disassemble without function headers looks up no symbols", async () => {
    const { disassemble, lookups } = disassemblySession(false);
    const response = await disassemble();
    assert.equal(response.success, true);
    assert.equal(response.body!.instructions[0].location, undefined);
    assert.equal(response.body!.instructions[0].symbol, undefined);
    assert.deepEqual(lookups, []);
});

// Foreign symbol files are read once per memory context (ProcessID) of the
// stateful contexts, without the regions this session added.
test("getForeignSymbolFiles lists files that the session did not add", async () => {
    const session = new TcfDebugSession();
    const prefix = (session as unknown as { symbolFileIdPrefix: string }).symbolFileIdPrefix;
    assert.match(prefix, /^vscode-symbol-file-[0-9a-f]{8}-$/);
    const queried: string[] = [];
    Object.assign(session, {
        memoryMap: {
            get: async (id: string) => {
                queried.push(id);
                if (id === "gone") {
                    throw new Error("Invalid context");
                }
                return [
                    { ID: `${prefix}1`, FileName: "/own.elf" },
                    {
                        ID: "vscode-symbol-file-1",
                        FileName: "/other-window.elf",
                    },
                    { FileName: "/simics.elf", BaseAddress: 0x1000 },
                ];
            },
        },
        contexts: new Map([
            ["board", { ID: "board", Name: "board" }],
            [
                "cpu0",
                {
                    ID: "cpu0",
                    Name: "cpu0",
                    ParentID: "board",
                    HasState: true,
                    ProcessID: "board",
                },
            ],
            [
                "cpu1",
                {
                    ID: "cpu1",
                    Name: "cpu1",
                    ParentID: "board",
                    HasState: true,
                    ProcessID: "board",
                },
            ],
            ["cpu2", { ID: "cpu2", HasState: true, ProcessID: "gone" }],
        ]),
        contextOrder: ["board", "cpu0", "cpu1", "cpu2"],
    });
    const response = await new Promise<DebugProtocol.Response>((resolve) => {
        session.onDidSendMessage((value) => {
            if ((value as DebugProtocol.ProtocolMessage).type === "response") {
                resolve(value as DebugProtocol.Response);
            }
        });
        session.handleMessage({
            seq: 1,
            type: "request",
            command: "getForeignSymbolFiles",
            arguments: {},
        } as DebugProtocol.Request);
    });
    assert.equal(response.success, true);
    assert.deepEqual(queried, ["board", "gone"]);
    assert.deepEqual(response.body, {
        supported: true,
        files: [
            {
                path: "/other-window.elf",
                contexts: ["board"],
                ids: ["vscode-symbol-file-1"],
                regions: [{}],
            },
            {
                path: "/simics.elf",
                contexts: ["board"],
                ids: [],
                regions: [{ offset: "+0x1000" }],
            },
        ],
    });
});
