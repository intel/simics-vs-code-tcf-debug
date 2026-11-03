import assert from "node:assert/strict";
import { test } from "node:test";
import { disassembleInstructions, instructionReference, parseInstructionReference } from "../src/disassembly";
import { TcfChannel, TcfError } from "../src/tcf/channel";
import { DisassemblyService } from "../src/tcf/services/disassembly";
import { DisassemblyLine } from "../src/tcf/services/disassembly";

test("TCF disassembly requests opcode bytes in the requested context", async () => {
    const lines: DisassemblyLine[] = [{ Address: 0x123456789abcdef0n, Size: 1, Instruction: [{ Text: "ret" }] }];
    const channel = {
        command: async (...args: unknown[]) => {
            assert.deepEqual(args, [
                "Disassembly",
                "disassemble",
                "cpu/0",
                0x123456789abcdef0n,
                16,
                { OpcodeValue: true },
            ]);
            return [lines];
        },
    } as unknown as TcfChannel;
    assert.deepEqual(await new DisassemblyService(channel).disassemble("cpu/0", 0x123456789abcdef0n, 16), lines);
});

test("frame references retain context and full-width addresses", () => {
    const reference = instructionReference("cpu/0", 0x123456789abcdef0n);
    assert.deepEqual(parseInstructionReference(reference), {
        contextId: "cpu/0",
        address: 0x123456789abcdef0n,
    });
    assert.deepEqual(parseInstructionReference("0x123456789abcdef0"), {
        address: 0x123456789abcdef0n,
    });
    assert.throws(() => parseInstructionReference("0x123garbage"), /Invalid instruction address/);
});

test("byte and forward instruction offsets decode text and opcode bytes", async () => {
    const calls: { contextId: string; address: bigint; size: number }[] = [];
    const lines: DisassemblyLine[] = [
        { Address: 0x1004n, Size: 2, Instruction: [{ Text: "nop" }] },
        {
            Address: 0x1006n,
            Size: 3,
            Instruction: [
                { Text: "mov " },
                { Type: "Register", Text: "eax" },
                { Text: ", " },
                { Type: "Immediate", Value: 42 },
            ],
            OpcodeValue: Buffer.from([0x90, 0x01, 0x2a]).toString("base64"),
        },
        { Address: 0x1009n, Size: 1, Instruction: [{ Text: "ret" }] },
    ];
    const service = {
        disassemble: async (contextId: string, address: bigint, size: number) => {
            calls.push({ contextId, address, size });
            return lines;
        },
    };
    const instructions = await disassembleInstructions(service, "cpu/0", 0x1000n, {
        memoryReference: "0x1000",
        offset: 4,
        instructionOffset: 1,
        instructionCount: 2,
    });
    assert.deepEqual(calls, [{ contextId: "cpu/0", address: 0x1004n, size: 48 }]);
    assert.deepEqual(
        instructions.map((i) => i.address),
        ["0x1006", "0x1009"],
    );
    assert.equal(instructions[0].instruction, "mov eax, 0x2a");
    assert.equal(instructions[0].instructionBytes, "90 01 2a");
});

test("backward instruction offset counts decoded instructions of different sizes", async () => {
    const lines: DisassemblyLine[] = [
        { Address: 0x1000n, Size: 4, Instruction: [{ Text: "a" }] },
        { Address: 0x1004n, Size: 2, Instruction: [{ Text: "b" }] },
        { Address: 0x1006n, Size: 10, Instruction: [{ Text: "c" }] },
        { Address: 0x1010n, Size: 1, Instruction: [{ Text: "d" }] },
    ];
    const service = {
        disassemble: async (_: string, address: bigint, size: number) => {
            assert.equal(address, 0xff0n);
            assert.equal(size, 80);
            return lines;
        },
    };
    const instructions = await disassembleInstructions(service, "cpu/0", 0x1010n, {
        memoryReference: "0x1010",
        instructionOffset: -2,
        instructionCount: 3,
    });
    assert.deepEqual(
        instructions.map((i) => i.address),
        ["0x1004", "0x1006", "0x1010"],
    );
});

test("unavailable instructions are padded to the requested count", async () => {
    const service = {
        disassemble: async () => [{ Address: 0x1000n, Size: 4, Instruction: [{ Text: "nop" }] }],
    };
    const instructions = await disassembleInstructions(service, "cpu/0", 0x1000n, {
        memoryReference: "0x1000",
        instructionCount: 3,
    });
    assert.deepEqual(
        instructions.map((i) => i.address),
        ["0x1000", "0x1004", "0x1005"],
    );
    assert.deepEqual(
        instructions.map((i) => i.presentationHint),
        ["normal", "invalid", "invalid"],
    );
});

test("shrinks a disassembly range that crosses unmapped memory", async () => {
    const sizes: number[] = [];
    const service = {
        disassemble: async (_: string, address: bigint, size: number): Promise<DisassemblyLine[]> => {
            assert.equal(address, 0x1000n);
            sizes.push(size);
            if (address + BigInt(size) > 0x1010n) {
                throw new TcfError("Disassembly.disassemble: No translation for address");
            }
            return [
                { Address: 0x1000n, Size: 4, Instruction: [{ Text: "nop" }] },
                { Address: 0x1004n, Size: 4, Instruction: [{ Text: "ret" }] },
            ];
        },
    };
    const instructions = await disassembleInstructions(service, "cpu/0", 0x1000n, {
        memoryReference: "0x1000",
        instructionCount: 2,
    });
    assert.deepEqual(sizes, [32, 16]);
    assert.deepEqual(
        instructions.map((i) => i.instruction),
        ["nop", "ret"],
    );
});

test("falls back to the requested address when backward look-back is unmapped", async () => {
    const starts: bigint[] = [];
    const service = {
        disassemble: async (_: string, address: bigint): Promise<DisassemblyLine[]> => {
            starts.push(address);
            if (address < 0x1000n) {
                throw new TcfError("Disassembly.disassemble: No translation for address");
            }
            return [{ Address: 0x1000n, Size: 4, Instruction: [{ Text: "nop" }] }];
        },
    };
    const instructions = await disassembleInstructions(service, "cpu/0", 0x1000n, {
        memoryReference: "0x1000",
        instructionOffset: -1,
        instructionCount: 2,
    });
    assert.equal(starts.at(-1), 0x1000n);
    assert.equal(instructions.length, 2);
    assert.equal(instructions[0].presentationHint, "invalid");
    assert.equal(instructions[1].instruction, "nop");
});

test("does not hide unrelated disassembly failures", async () => {
    const service = {
        disassemble: async (): Promise<DisassemblyLine[]> => {
            throw new TcfError("Disassembly.disassemble: unsupported ISA");
        },
    };
    await assert.rejects(
        disassembleInstructions(service, "cpu/0", 0x1000n, { memoryReference: "0x1000", instructionCount: 1 }),
        /unsupported ISA/,
    );
});

test("reports an unmapped requested address after narrowing the range", async () => {
    const sizes: number[] = [];
    const service = {
        disassemble: async (_: string, __: bigint, size: number): Promise<DisassemblyLine[]> => {
            sizes.push(size);
            throw new TcfError("Disassembly.disassemble: No translation for address");
        },
    };
    await assert.rejects(
        disassembleInstructions(service, "cpu/0", 0x1000n, { memoryReference: "0x1000", instructionCount: 1 }),
        /No translation for address/,
    );
    assert.deepEqual(sizes, [16, 8, 4, 2, 1]);
});

test("invalid offsets and oversized requests are rejected", async () => {
    const service = { disassemble: async () => [] };
    await assert.rejects(
        disassembleInstructions(service, "cpu/0", 0n, {
            memoryReference: "0x0",
            offset: -1,
            instructionCount: 1,
        }),
        /must not be negative/,
    );
    await assert.rejects(
        disassembleInstructions(service, "cpu/0", 0n, {
            memoryReference: "0x0",
            instructionCount: 100000,
        }),
        /too large/,
    );
});
