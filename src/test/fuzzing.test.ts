import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { MessageReader, encodeMessage, stringifyJson } from "../tcf/channel";
import { parseJson, toBigInt } from "../tcf/json";
import { MAX_ADDRESS } from "../shared/targetMemory/format";
import { encodeNeedle, MAX_NEEDLE_LENGTH } from "../shared/targetMemory/needle";
import { scanMemory } from "../shared/targetMemory/search";

const options = { numRuns: 1000 };
const endianness = fc.constantFrom("little", "big");
// NUL separates fields, and unpaired surrogates cannot round-trip through UTF-8.
const field = fc
    .array(fc.oneof(fc.integer({ min: 1, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0x10ffff })), { maxLength: 32 })
    .map((points) => String.fromCodePoint(...points));

test("fuzz: TCF messages round-trip across arbitrary TCP chunk boundaries", () => {
    fc.assert(
        fc.property(
            fc.array(fc.array(field, { minLength: 1, maxLength: 6 }), { maxLength: 8 }),
            fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 32 }),
            (messages, sizes) => {
                const received: string[][] = [];
                const reader = new MessageReader({
                    message: (fields) => received.push(fields),
                    endOfStream: () => assert.fail("Unexpected end of stream"),
                    error: (error) => {
                        throw error;
                    },
                });
                const data = Buffer.concat(messages.map(encodeMessage));
                let offset = 0;
                let chunk = 0;
                while (offset < data.length) {
                    const end = Math.min(data.length, offset + sizes[chunk++ % sizes.length]);
                    reader.push(data.subarray(offset, end));
                    offset = end;
                }
                assert.deepEqual(received, messages);
            },
        ),
        options,
    );
});

test("fuzz: malformed TCF transport bytes report errors without throwing", () => {
    fc.assert(
        fc.property(fc.uint8Array({ maxLength: 4096 }), fc.integer({ min: 1, max: 64 }), (bytes, chunkSize) => {
            let ended = false;
            const reader = new MessageReader({
                message: (fields) => {
                    assert.ok(fields.length > 0);
                    assert.ok(fields.every((value) => typeof value === "string"));
                },
                endOfStream: () => {
                    ended = true;
                },
                error: (error) => {
                    assert.ok(error instanceof Error);
                    assert.match(error.message, /Unsupported TCF escape sequence ESC \d+/);
                },
            });
            for (let offset = 0; offset < bytes.length && !ended; offset += chunkSize) {
                reader.push(Buffer.from(bytes.subarray(offset, offset + chunkSize)));
            }
        }),
        options,
    );
});

test("fuzz: TCF JSON preserves signed and unsigned 64-bit integers", () => {
    fc.assert(
        fc.property(fc.bigInt({ min: -(1n << 63n), max: MAX_ADDRESS }), (value) => {
            assert.equal(stringifyJson(value), value.toString());
            assert.equal(toBigInt(parseJson(stringifyJson(value))), value);
            const parsed = parseJson(`{"address":${value}}`);
            assert.ok(typeof parsed === "object" && parsed !== null && "address" in parsed);
            assert.equal(toBigInt(parsed.address), value);
        }),
        options,
    );
});

test("fuzz: search query encoding respects its output limit and byte order", () => {
    fc.assert(
        fc.property(fc.string({ maxLength: 8192 }), endianness, (query, order) => {
            for (const format of ["hex", "text", "int"] as const) {
                const result = encodeNeedle(query, format, { endianness: order, intSize: 8 });
                if (result.ok) {
                    assert.ok(result.bytes.length > 0 && result.bytes.length <= MAX_NEEDLE_LENGTH);
                    if (format === "int") {
                        assert.equal(result.bytes.length, 8);
                    }
                    const reversed = encodeNeedle(query, format, {
                        endianness: order === "little" ? "big" : "little",
                        intSize: 8,
                    });
                    assert.ok(reversed.ok);
                    if (format === "int") {
                        assert.deepEqual(reversed.bytes, result.bytes.slice().reverse());
                    } else if (format === "text") {
                        assert.deepEqual(reversed.bytes, result.bytes);
                    }
                } else {
                    assert.ok(result.error.length > 0);
                }
            }
        }),
        options,
    );
});

test("fuzz: hex and text needles enforce the exact byte-length limit", () => {
    fc.assert(
        fc.property(
            fc.integer({ min: MAX_NEEDLE_LENGTH - 4, max: MAX_NEEDLE_LENGTH + 4 }),
            endianness,
            (length, order) => {
                for (const format of ["hex", "text"] as const) {
                    const query = (format === "hex" ? "ab" : "a").repeat(length);
                    const result = encodeNeedle(query, format, { endianness: order, intSize: 8 });
                    assert.equal(result.ok, length <= MAX_NEEDLE_LENGTH);
                    if (result.ok) {
                        assert.deepEqual(result.bytes, new Uint8Array(length).fill(format === "hex" ? 0xab : 0x61));
                    } else {
                        assert.equal(result.error, `At most ${MAX_NEEDLE_LENGTH} bytes can be searched for`);
                    }
                }
            },
        ),
        options,
    );
});

test("fuzz: chunked memory search agrees with a reference search", async () => {
    await fc.assert(
        fc.asyncProperty(
            fc.uint8Array({ maxLength: 128 }),
            fc.uint8Array({ minLength: 1, maxLength: 16 }),
            fc.array(fc.boolean(), { minLength: 128, maxLength: 128 }),
            fc.bigInt({ min: 0n, max: MAX_ADDRESS - 128n }),
            fc.integer({ min: 1, max: 16 }),
            fc.integer({ min: 16, max: 64 }),
            fc.integer({ min: 1, max: 8 }),
            fc.constantFrom("forward", "backward"),
            fc.boolean(),
            fc.nat({ max: 127 }),
            async (
                bytes,
                randomNeedle,
                readable,
                start,
                alignment,
                chunkSize,
                maxInFlight,
                direction,
                useSlice,
                pick,
            ) => {
                const needle =
                    useSlice && bytes.length > 0
                        ? bytes.slice(
                              pick % bytes.length,
                              Math.min(bytes.length, (pick % bytes.length) + randomNeedle.length),
                          )
                        : randomNeedle;
                const valid = Uint8Array.from(readable, (value) => Number(value));
                const matches: bigint[] = [];
                for (let offset = 0; offset + needle.length <= bytes.length; offset++) {
                    const address = start + BigInt(offset);
                    if (
                        address % BigInt(alignment) === 0n &&
                        needle.every((value, index) => valid[offset + index] && bytes[offset + index] === value)
                    ) {
                        matches.push(address);
                    }
                }
                const expected = direction === "forward" ? matches[0] : matches.at(-1);
                const result = await scanMemory({
                    needle,
                    alignment,
                    start,
                    end: start + BigInt(bytes.length) - 1n,
                    direction,
                    chunkSize,
                    maxInFlight,
                    read: async (address, length) => {
                        const offset = Number(address - start);
                        assert.ok(offset >= 0 && offset + length <= bytes.length);
                        assert.ok(length > 0 && length <= chunkSize);
                        return {
                            bytes: bytes.slice(offset, offset + length),
                            valid: valid.slice(offset, offset + length),
                        };
                    },
                });
                assert.deepEqual(
                    result,
                    expected === undefined
                        ? { outcome: "notFound", failedReads: 0, firstError: undefined }
                        : { outcome: "found", address: expected },
                );
            },
        ),
        options,
    );
});
