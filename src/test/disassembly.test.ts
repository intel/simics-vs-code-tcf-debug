import { test } from "node:test";
import assert from "node:assert/strict";
import { DebugProtocol } from "@vscode/debugprotocol";
import {
    disassembleInstructions,
    instructionReference,
    DisassemblyCache,
    KnownInstructionStarts,
    parseInstructionReference,
} from "../disassembly";
import { TcfError } from "../tcf/channel";
import { DisassemblyLine } from "../tcf/services/disassembly";

const NOP = Buffer.from([0x90, 0x90, 0x90, 0x90]).toString("base64");

/**
 * Fake Disassembly service with 4 byte instructions. Memory below
 * `mappedFrom` cannot be read, memory from `mappedTo` on reads as nothing.
 */
function fakeDisassembler(mappedFrom = 0n, mappedTo?: bigint) {
    const calls: [bigint, number][] = [];
    const service = {
        async disassemble(_contextId: string, address: bigint, size: number): Promise<DisassemblyLine[]> {
            calls.push([address, size]);
            if (address < mappedFrom) {
                const hex = address.toString(16);
                throw new TcfError("Disassembly.disassemble: " + `No translation for address 0x${hex}`);
            }
            let end = address + BigInt(size);
            if (mappedTo !== undefined && mappedTo < end) {
                end = mappedTo;
            }
            const lines: DisassemblyLine[] = [];
            for (let a = address; a < end; a += 4n) {
                lines.push({
                    Address: a,
                    Size: 4,
                    Instruction: [{ Type: "String", Text: `insn_${a.toString(16)}` }],
                    OpcodeValue: NOP,
                });
            }
            return lines;
        },
    };
    return { service, calls };
}

function args(
    instructionCount: number,
    more: Partial<DebugProtocol.DisassembleArguments> = {},
): DebugProtocol.DisassembleArguments {
    return { memoryReference: "unused", instructionCount, ...more };
}

function insn(address: number): DebugProtocol.DisassembledInstruction {
    return {
        address: `0x${address.toString(16)}`,
        instruction: `insn_${address.toString(16)}`,
        instructionBytes: "90 90 90 90",
        presentationHint: "normal",
    };
}

const skipped: DebugProtocol.DisassembledInstruction = {
    address: "-1",
    instruction: "??",
    presentationHint: "invalid",
};

function invalid(address: number): DebugProtocol.DisassembledInstruction {
    return {
        address: `0x${address.toString(16)}`,
        instruction: "??",
        presentationHint: "invalid",
    };
}

// The reference given to VS Code must give back the same context and
// address.
test("instruction references round trip", () => {
    const ref = instructionReference("cpu0", 0xffff0000n);
    assert.equal(ref, '["cpu0","0xffff0000"]');
    assert.deepEqual(parseInstructionReference(ref), {
        contextId: "cpu0",
        address: 0xffff0000n,
    });
});

// References without a context: hex or decimal addresses.
test("parseInstructionReference accepts plain addresses", () => {
    assert.deepEqual(parseInstructionReference("0x1000"), { address: 0x1000n });
    assert.deepEqual(parseInstructionReference("4096"), { address: 4096n });
});

// Bad addresses and wrong JSON arrays throw. Broken JSON throws a
// SyntaxError.
test("parseInstructionReference rejects bad references", () => {
    for (const ref of ["", "pc", "-1", "0x", '["cpu0"]', '["cpu0","pc"]', '[1,"0x10"]', '["a","0x1","x"]']) {
        assert.throws(() => parseInstructionReference(ref), /Invalid instruction/, ref);
    }
    assert.throws(() => parseInstructionReference("[not json"), SyntaxError);
});

// Without offsets there is one request from the address, with room for
// 16 bytes per instruction.
test("disassembleInstructions starts at the address", async () => {
    const fake = fakeDisassembler();
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(3));
    assert.deepEqual(result, [insn(0x1000), insn(0x1004), insn(0x1008)]);
    assert.deepEqual(fake.calls, [[0x1000n, 48]]);
});

// Byte offset, and positive and negative instruction offsets. A negative
// offset reads 16 bytes per instruction before the address, up to it.
test("disassembleInstructions applies offsets", async () => {
    const fake = fakeDisassembler();
    assert.deepEqual(await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(1, { offset: 8 })), [
        insn(0x1008),
    ]);
    assert.deepEqual(await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(1, { instructionOffset: 2 })), [
        insn(0x1008),
    ]);
    assert.deepEqual(await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(2, { instructionOffset: -2 })), [
        insn(0xff8),
        insn(0xffc),
    ]);
    assert.deepEqual(fake.calls[2], [0xfe0n, 32]);
});

// Memory before the address cannot be read: the start moves halfway to the
// address until it is reached. The gap is filled with address -1, which
// VS Code skips, so it keeps the instructions it already shows there.
test("disassembleInstructions pads unreadable memory before", async () => {
    const fake = fakeDisassembler(0x1000n);
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(4, { instructionOffset: -2 }));
    assert.deepEqual(result, [skipped, skipped, insn(0x1000), insn(0x1004)]);
    assert.deepEqual(
        fake.calls.map(([, size]) => size),
        [32, 16, 8, 4, 2, 1, 32],
    );
    assert.deepEqual(fake.calls.at(-1), [0x1000n, 32]);
});

// The agent returns fewer instructions than asked for: the rest are "??".
test("disassembleInstructions pads missing instructions after", async () => {
    const fake = fakeDisassembler(0n, 0x1008n);
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(4));
    assert.deepEqual(result, [insn(0x1000), insn(0x1004), invalid(0x1008), invalid(0x1009)]);
});

// If the address itself cannot be read, the error goes to the caller.
test("disassembleInstructions fails on an unreadable address", async () => {
    const fake = fakeDisassembler(0x2000n);
    await assert.rejects(
        disassembleInstructions(fake.service, "cpu0", 0x1000n, args(1)),
        /No translation for address 0x1000/,
    );
});

// Only "no translation" errors are retried, other errors are not.
test("disassembleInstructions passes on other errors at once", async () => {
    let calls = 0;
    const service = {
        async disassemble(): Promise<DisassemblyLine[]> {
            calls++;
            throw new TcfError("Disassembly.disassemble: Invalid context");
        },
    };
    await assert.rejects(
        disassembleInstructions(service, "cpu0", 0x1000n, args(2, { instructionOffset: -1 })),
        /Invalid context/,
    );
    assert.equal(calls, 1);
});

// Text and address fields are joined. No fields gives an invalid "??".
test("disassembleInstructions formats instruction fields", async () => {
    const service = {
        async disassemble(): Promise<DisassemblyLine[]> {
            return [
                {
                    Address: 0x1000,
                    Size: 2,
                    Instruction: [
                        { Type: "String", Text: "jmp " },
                        { Type: "Address", Value: 0x2000 },
                    ],
                },
                { Address: 0x1002, Size: 2, Instruction: [] },
            ];
        },
    };
    assert.deepEqual(await disassembleInstructions(service, "cpu0", 0x1000n, args(2)), [
        {
            address: "0x1000",
            instruction: "jmp 0x2000",
            instructionBytes: undefined,
            presentationHint: "normal",
        },
        {
            address: "0x1002",
            instruction: "??",
            instructionBytes: undefined,
            presentationHint: "invalid",
        },
    ]);
});

// A zero count returns nothing and bad arguments throw, both without
// asking the agent.
test("disassembleInstructions checks its arguments", async () => {
    const fake = fakeDisassembler();
    assert.deepEqual(await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(0)), []);
    assert.deepEqual(fake.calls, []);
    await assert.rejects(disassembleInstructions(fake.service, "cpu0", 0x1000n, args(-1)), /Invalid disassembly/);
    await assert.rejects(
        disassembleInstructions(fake.service, "cpu0", 0x1000n, args(1, { offset: 1.5 })),
        /Invalid disassembly/,
    );
    await assert.rejects(
        disassembleInstructions(fake.service, "cpu0", 0x10n, args(1, { offset: -0x20 })),
        /must not be negative/,
    );
    await assert.rejects(disassembleInstructions(fake.service, "cpu0", 0x1000n, args(70000)), /too large/);
    assert.deepEqual(fake.calls, []);
});

/**
 * Fake Disassembly service for variable length instructions: an
 * instruction is as long as its first byte, given by `lengths` (2 if not
 * listed). Decoding from different addresses can get out of step.
 */
function variableDisassembler(lengths: Record<number, number> = {}) {
    const calls: [bigint, number][] = [];
    const service = {
        async disassemble(_contextId: string, address: bigint, size: number): Promise<DisassemblyLine[]> {
            calls.push([address, size]);
            const lines: DisassemblyLine[] = [];
            for (let a = address; a < address + BigInt(size);) {
                const length = lengths[Number(a)] ?? 2;
                lines.push({
                    Address: a,
                    Size: length,
                    Instruction: [{ Text: `insn_${a.toString(16)}` }],
                });
                a += BigInt(length);
            }
            return lines;
        },
    };
    return { service, calls };
}

function addresses(result: DebugProtocol.DisassembledInstruction[]) {
    return result.map((instruction) => instruction.address);
}

// Decoding from 0xfe0 runs over the address (0xfe0 is 3 bytes, then odd
// addresses). Starts 1 and 2 bytes later are tried, 0xfe2 lands on it.
test("disassembleInstructions moves a guessed start to land on the address", async () => {
    const fake = variableDisassembler({ 0xfe0: 3 });
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(3, { instructionOffset: -2 }));
    assert.deepEqual(addresses(result), ["0xffc", "0xffe", "0x1000"]);
    assert.deepEqual(fake.calls, [
        [0xfe0n, 32],
        [0xfe1n, 31],
        [0xfe2n, 30],
        [0x1000n, 16],
    ]);
});

// Known starts (such as earlier PCs) at odd 0xfe1 and 0xff5. The guessed
// start 0xfa0 is moved to 0xfa1 to land on 0xfe1. From there 0xff4 runs over
// 0xff5, so decoding restarts at 0xff5 and 0xff4 stays.
test("disassembleInstructions restarts at known instruction starts", async () => {
    const fake = variableDisassembler({ 0xfe1: 3, 0xff5: 3 });
    const lookups: [bigint, bigint][] = [];
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(7, { instructionOffset: -6 }), {
        knownStarts: async (start, end) => {
            lookups.push([start, end]);
            return [0xff5n, 0xfe1n, 0x10n, 0x2000n];
        },
    });
    assert.deepEqual(addresses(result), ["0xff4", "0xff5", "0xff8", "0xffa", "0xffc", "0xffe", "0x1000"]);
    assert.deepEqual(lookups, [[0xea0n, 0x1010n]]);
    assert.deepEqual(fake.calls, [
        [0xfa0n, 96],
        [0xfa1n, 95],
        [0xff5n, 11],
        [0x1000n, 16],
    ]);
});

// A known start shortly below the range is used as the start, so no
// guessing is needed.
test("disassembleInstructions starts at a known start below the range", async () => {
    const fake = variableDisassembler({ 0xf91: 3 });
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(2, { instructionOffset: -2 }), {
        knownStarts: async () => [0xf91n],
    });
    assert.deepEqual(addresses(result), ["0xffc", "0xffe"]);
    assert.deepEqual(fake.calls, [[0xf91n, 111]]);
});

// After the address, decoding restarts at a known start that an
// instruction runs over, such as data in the code.
test("disassembleInstructions stays in step after the address", async () => {
    const fake = variableDisassembler({ 0x1007: 1 });
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(6), {
        knownStarts: async () => [0x1007n],
    });
    assert.deepEqual(addresses(result), ["0x1000", "0x1002", "0x1004", "0x1006", "0x1007", "0x1008"]);
    assert.deepEqual(fake.calls, [
        [0x1000n, 96],
        [0x1007n, 89],
    ]);
});

// Failed lookups are ignored, and a single instruction needs no lookup.
test("disassembleInstructions works without known starts", async () => {
    const fake = variableDisassembler();
    let lookups = 0;
    const lookup = async (): Promise<bigint[]> => {
        lookups++;
        throw new Error("no line numbers");
    };
    assert.deepEqual(
        addresses(await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(1), { knownStarts: lookup })),
        ["0x1000"],
    );
    assert.equal(lookups, 0);
    assert.deepEqual(
        addresses(
            await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(2, { instructionOffset: -1 }), {
                knownStarts: lookup,
            }),
        ),
        ["0xffe", "0x1000"],
    );
    assert.equal(lookups, 1);
});

// Known starts are per context, limited, and the oldest go first.
test("KnownInstructionStarts keeps the most recent addresses", () => {
    const starts = new KnownInstructionStarts(2);
    starts.add("cpu0", 0x10n);
    starts.add("cpu0", 0x20n);
    starts.add("cpu0", 0x10n);
    starts.add("cpu0", 0x30n);
    starts.add("cpu1", 0x40n);
    assert.deepEqual(starts.inRange("cpu0", 0n, 0x100n), [0x10n, 0x30n]);
    assert.deepEqual(starts.inRange("cpu0", 0x11n, 0x30n), []);
    starts.delete("cpu0");
    assert.deepEqual(starts.inRange("cpu0", 0n, 0x100n), []);
    assert.deepEqual(starts.inRange("cpu1", 0n, 0x100n), [0x40n]);
    starts.clear();
    assert.deepEqual(starts.inRange("cpu1", 0n, 0x100n), []);
});

/**
 * Fake Disassembly service that behaves like the TCF agent with symbols:
 * for an address in one of `functions` it decodes from the function start
 * and stops at the function end. 4 byte instructions.
 */
function functionDisassembler(functions: [number, number][]) {
    const calls: [bigint, number][] = [];
    const service = {
        async disassemble(_contextId: string, address: bigint, size: number): Promise<DisassemblyLine[]> {
            calls.push([address, size]);
            let start = address;
            let end = address + BigInt(size);
            const f = functions.find(([s, e]) => BigInt(s) <= address && address < BigInt(e));
            if (f) {
                start = BigInt(f[0]);
                end = end < BigInt(f[1]) ? end : BigInt(f[1]);
            }
            const lines: DisassemblyLine[] = [];
            for (let a = start; a < end; a += 4n) {
                lines.push({
                    Address: a,
                    Size: 4,
                    Instruction: [{ Text: `insn_${a.toString(16)}` }],
                });
            }
            return lines;
        },
    };
    return { service, calls };
}

// The range before the address starts in another function. The agent stops
// at that function's end, so reading continues from there up to the
// address instead of giving up.
test("disassembleInstructions continues before the address after a function end", async () => {
    const fake = functionDisassembler([
        [0xf00, 0xff0],
        [0xff0, 0x1100],
    ]);
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(6, { instructionOffset: -5 }));
    assert.deepEqual(addresses(result), ["0xfec", "0xff0", "0xff4", "0xff8", "0xffc", "0x1000"]);
    assert.deepEqual(fake.calls, [
        [0xfb0n, 80],
        [0xff0n, 16],
        [0x1000n, 16],
    ]);
});

// After the end of the function with the address, reading continues so the
// view is not padded with "??".
test("disassembleInstructions continues after the end of a function", async () => {
    const fake = functionDisassembler([[0xff0, 0x1008]]);
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(4));
    assert.deepEqual(addresses(result), ["0x1000", "0x1004", "0x1008", "0x100c"]);
    assert.deepEqual(fake.calls, [
        [0x1000n, 64],
        [0x1008n, 56],
    ]);
});

/** Memory that reads as `fill` bytes, counting the reads. */
function fakeMemory(fill = 0x90) {
    const reads: [bigint, number][] = [];
    const read = async (_contextId: string, address: bigint, size: number) => {
        reads.push([address, size]);
        return new Uint8Array(size).fill(fill);
    };
    return { read, reads };
}

// Asking again uses the cached replies, also for the overlapping requests
// VS Code sends for one stop.
test("disassembleInstructions reuses cached replies", async () => {
    const fake = fakeDisassembler();
    const memory = fakeMemory();
    const cache = new DisassemblyCache(memory.read);
    const first = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(4, { instructionOffset: -2 }), {
        cache,
    });
    const calls = fake.calls.length;
    assert.deepEqual(
        await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(4, { instructionOffset: -2 }), { cache }),
        first,
    );
    assert.deepEqual(
        await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(2), {
            cache,
        }),
        [insn(0x1000), insn(0x1004)],
    );
    assert.equal(fake.calls.length, calls);
    assert.deepEqual(memory.reads, []);
});

// After a resume the cached replies are checked with one memory read and
// used if the bytes are the same.
test("disassembleInstructions checks cached replies after a resume", async () => {
    const fake = functionDisassembler([
        [0xf00, 0xff0],
        [0xff0, 0x1100],
    ]);
    const lines = fake.service.disassemble.bind(fake.service);
    const service = {
        async disassemble(contextId: string, address: bigint, size: number) {
            const result = await lines(contextId, address, size);
            return result.map((l) => ({ ...l, OpcodeValue: NOP }));
        },
    };
    const memory = fakeMemory();
    const cache = new DisassemblyCache(memory.read);
    const request = args(6, { instructionOffset: -5 });
    const first = await disassembleInstructions(service, "cpu0", 0x1000n, request, { cache });
    const calls = fake.calls.length;
    cache.invalidate();
    assert.deepEqual(
        await disassembleInstructions(service, "cpu0", 0x1000n, request, {
            cache,
        }),
        first,
    );
    assert.equal(fake.calls.length, calls);
    // Before the address [0xfb0, 0xff0) and [0xff0, 0x1000) in one read,
    // then the 16 bytes read from the address.
    assert.deepEqual(memory.reads, [
        [0xfb0n, 0x50],
        [0x1000n, 16],
    ]);
});

// Changed bytes, or memory that cannot be read, make it ask the agent again.
test("disassembleInstructions drops cached replies that changed", async () => {
    const fake = fakeDisassembler();
    let fill = 0x90;
    const cache = new DisassemblyCache(async (_contextId, _address, size) =>
        fill === 0 ? undefined : new Uint8Array(size).fill(fill),
    );
    await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(2), {
        cache,
    });
    fill = 0xcc;
    cache.invalidate();
    await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(2), {
        cache,
    });
    fill = 0;
    cache.invalidate();
    await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(2), {
        cache,
    });
    assert.deepEqual(fake.calls, [
        [0x1000n, 32],
        [0x1000n, 32],
        [0x1000n, 32],
    ]);
});

// A reply to a request sent before a resume is not trusted after it.
test("DisassemblyCache keeps the generation of the request", () => {
    const cache = new DisassemblyCache();
    const line: DisassemblyLine = { Address: 0x1000n, Size: 4 };
    const generation = cache.current;
    cache.invalidate();
    cache.set("cpu0", 0x1000n, [line], generation);
    assert.equal(cache.get("cpu0", 0x1000n, 0x2000n), undefined);
    cache.set("cpu0", 0x1000n, [line], cache.current);
    assert.deepEqual(cache.get("cpu0", 0x1000n, 0x2000n), [line]);
    cache.delete("cpu0");
    assert.equal(cache.get("cpu0", 0x1000n, 0x2000n), undefined);
});

// A step: after the resume the request starts at a new address, but the
// continuations at line ends are the same, so they come from the cache once
// one memory read shows the bytes are unchanged.
test("disassembleInstructions uses checked replies after a step", async () => {
    const fake = functionDisassembler([
        [0xf00, 0xf40],
        [0xf40, 0xf80],
        [0xf80, 0x1100],
    ]);
    const lines = fake.service.disassemble.bind(fake.service);
    const service = {
        async disassemble(contextId: string, address: bigint, size: number) {
            const result = await lines(contextId, address, size);
            return result.map((l) => ({ ...l, OpcodeValue: NOP }));
        },
    };
    const memory = fakeMemory();
    const cache = new DisassemblyCache(memory.read);
    await disassembleInstructions(service, "cpu0", 0xf90n, args(10, { instructionOffset: -8 }), { cache });
    assert.deepEqual(fake.calls, [
        [0xf10n, 0x80],
        [0xf40n, 0x50],
        [0xf80n, 0x10],
        [0xf90n, 0x20],
    ]);
    cache.invalidate();
    const result = await disassembleInstructions(service, "cpu0", 0xf94n, args(10, { instructionOffset: -8 }), {
        cache,
    });
    assert.deepEqual(addresses(result), [
        "0xf74",
        "0xf78",
        "0xf7c",
        "0xf80",
        "0xf84",
        "0xf88",
        "0xf8c",
        "0xf90",
        "0xf94",
        "0xf98",
    ]);
    // Only the new start and the range after the new address are requested.
    assert.deepEqual(fake.calls.slice(4), [
        [0xf14n, 0x80],
        [0xf94n, 0x20],
    ]);
    // One read checks the replies from 0xf40, 0xf80 and 0xf90.
    assert.deepEqual(memory.reads, [[0xf40n, 0x70]]);
});

// Instructions in a function get its name as symbol, its entry also a
// header source with line 1. Rows without decoded instructions are not
// looked up.
test("disassembleInstructions adds function headers at entries", async () => {
    const fake = fakeDisassembler(0x1000n);
    const foo = { name: "foo", address: 0x1004n, size: 8 };
    let asked: bigint[] = [];
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(5, { instructionOffset: -1 }), {
        functions: async (addresses) => {
            asked = addresses;
            return new Map(addresses.filter((a) => a >= 0x1004n && a < 0x100cn).map((a) => [a, foo]));
        },
    });
    assert.deepEqual(asked, [0x1000n, 0x1004n, 0x1008n, 0x100cn]);
    assert.deepEqual(result, [
        skipped,
        insn(0x1000),
        {
            ...insn(0x1004),
            symbol: "foo",
            location: {
                name: "foo",
                path: "simics-target-debug-function:/0x1004/1//foo",
            },
            line: 1,
        },
        { ...insn(0x1008), symbol: "foo" },
        insn(0x100c),
    ]);
});

// A failing lookup leaves the instructions as they are.
test("disassembleInstructions ignores failed function lookups", async () => {
    const fake = fakeDisassembler();
    const result = await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(1), {
        functions: async () => {
            throw new Error("no symbols");
        },
    });
    assert.deepEqual(result, [insn(0x1000)]);
});

// Functions are looked up nearest the requested address first, so a limit
// on lookups is not used up by far away code without symbols.
test("disassembleInstructions looks up functions near the address first", async () => {
    const fake = fakeDisassembler();
    let asked: bigint[] = [];
    await disassembleInstructions(fake.service, "cpu0", 0x1000n, args(5, { instructionOffset: -2 }), {
        functions: async (addresses) => {
            asked = addresses;
            return new Map();
        },
    });
    assert.deepEqual(asked, [0x1000n, 0xffcn, 0x1004n, 0xff8n, 0x1008n]);
});
