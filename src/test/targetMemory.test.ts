import { test } from "node:test";
import assert from "node:assert/strict";
import {
    addressFromValue,
    autoBytesPerRow,
    formatGroup,
    groupByteOffset,
    inspectBytes,
    parseAddress,
    setNibble,
} from "../shared/targetMemory/format";
import { encodeNeedle } from "../shared/targetMemory/needle";
import {
    findInChunk,
    planChunks,
    scanMemory,
    type ScanRead,
    type SearchDirection,
} from "../shared/targetMemory/search";
import { ByteState, MemoryCache } from "../webview/targetMemory/memoryCache";
import type { FromWebview } from "../shared/targetMemory/protocol";

const bytes = (...b: number[]) => Uint8Array.from(b);

// ---- Formatting ------------------------------------------------------------

test("parseAddress takes 0x hex and decimal, like C", () => {
    assert.equal(parseAddress("0x1000"), 0x1000n);
    assert.equal(parseAddress(" 4096 "), 4096n);
    assert.equal(parseAddress("0xffff_ffff"), 0xffffffffn);
    assert.equal(parseAddress("0xffffffffffffffff"), (1n << 64n) - 1n);
    assert.equal(parseAddress("0x10000000000000000"), undefined);
    assert.equal(parseAddress("&x"), undefined);
    assert.equal(parseAddress("1000h"), undefined);
});

test("groups are shown as numbers in the byte order", () => {
    assert.equal(formatGroup([0x78, 0x56, 0x34, 0x12], "little"), "12345678");
    assert.equal(formatGroup([0x78, 0x56, 0x34, 0x12], "big"), "78563412");
    assert.equal(formatGroup([0x01, undefined], "little"), "??01");
    assert.equal(groupByteOffset(0, 4, "little"), 3);
    assert.equal(groupByteOffset(0, 4, "big"), 0);
});

test("setNibble replaces the high or low hex digit", () => {
    assert.equal(setNibble(0x12, 0, 0xa), 0xa2);
    assert.equal(setNibble(0x12, 1, 0xa), 0x1a);
});

test("the data inspector decodes in the byte order", () => {
    const le = new Map(
        inspectBytes([0xfe, 0xff, 0xff, 0xff, 0, 0, 0x80, 0x3f], "little").map((e) => [e.label, e.value]),
    );
    assert.equal(le.get("int8"), "-2");
    assert.equal(le.get("uint16"), "65534");
    assert.equal(le.get("int32"), "-2");
    assert.equal(le.get("binary"), "11111110");
    const be = new Map(inspectBytes([0x3f, 0x80, 0, 0], "big").map((e) => [e.label, e.value]));
    assert.equal(be.get("float32"), "1");
    assert.equal(be.get("int64"), "-");
});

test("addressFromValue finds the address in a debugger value", () => {
    assert.equal(addressFromValue("0x1000"), 0x1000n);
    assert.equal(addressFromValue('(char *) 0x2000 "abc"'), 0x2000n);
    assert.equal(addressFromValue("4096"), 4096n);
    assert.equal(addressFromValue("{...}"), undefined);
    assert.equal(addressFromValue("-1"), undefined);
});

test("autoBytesPerRow picks the widest power of two that fits", () => {
    // 1 + 16 + 2 + 32 + 15 + 2 + 16 + 1 = 85 characters for 16 bytes.
    assert.equal(autoBytesPerRow(85, 8, 1), 16);
    assert.equal(autoBytesPerRow(84, 8, 1), 8);
    assert.equal(autoBytesPerRow(10, 8, 4), 4);
    assert.equal(autoBytesPerRow(1000, 8, 1), 64);
});

// ---- Needles ---------------------------------------------------------------

const le = { endianness: "little", intSize: 4 } as const;
const be = { endianness: "big", intSize: 4 } as const;

test("hex groups are numbers in the byte order", () => {
    assert.deepEqual(encodeNeedle("12345678", "hex", le), {
        ok: true,
        bytes: bytes(0x78, 0x56, 0x34, 0x12),
    });
    assert.deepEqual(encodeNeedle("0x12345678", "hex", be), {
        ok: true,
        bytes: bytes(0x12, 0x34, 0x56, 0x78),
    });
    // Single bytes are a byte sequence in either byte order.
    assert.deepEqual(encodeNeedle("de ad be ef", "hex", le), {
        ok: true,
        bytes: bytes(0xde, 0xad, 0xbe, 0xef),
    });
    assert.equal(encodeNeedle("abc", "hex", le).ok, false);
    assert.equal(encodeNeedle("xy", "hex", le).ok, false);
    assert.equal(encodeNeedle("  ", "hex", le).ok, false);
});

test("text is ASCII only", () => {
    assert.deepEqual(encodeNeedle("Hi ", "text", le), {
        ok: true,
        bytes: bytes(0x48, 0x69, 0x20),
    });
    assert.equal(encodeNeedle("é", "text", le).ok, false);
});

test("integers are encoded in their size and byte order", () => {
    assert.deepEqual(encodeNeedle("0x1234", "int", { ...le, intSize: 2 }), {
        ok: true,
        bytes: bytes(0x34, 0x12),
    });
    assert.deepEqual(encodeNeedle("-2", "int", be), {
        ok: true,
        bytes: bytes(0xff, 0xff, 0xff, 0xfe),
    });
    assert.deepEqual(encodeNeedle("1", "int", { ...le, intSize: 8 }), {
        ok: true,
        bytes: bytes(1, 0, 0, 0, 0, 0, 0, 0),
    });
    assert.equal(encodeNeedle("256", "int", { ...le, intSize: 1 }).ok, false);
    assert.equal(encodeNeedle("-129", "int", { ...le, intSize: 1 }).ok, false);
    assert.equal(encodeNeedle("255", "int", { ...le, intSize: 1 }).ok, true);
    assert.equal(encodeNeedle("1.5", "int", le).ok, false);
});

// ---- Search ----------------------------------------------------------------

/** All candidate addresses the planned chunks cover, in search order. */
function candidates(
    start: bigint,
    end: bigint,
    n: number,
    alignment: number,
    chunkSize: number,
    direction: SearchDirection,
): bigint[] {
    const result: bigint[] = [];
    for (const c of planChunks(start, end, n, alignment, chunkSize, direction)) {
        assert.ok(c.length <= chunkSize, "chunk too long");
        assert.equal(BigInt(c.length), c.last - c.address + BigInt(n));
        const a = BigInt(alignment);
        const forward: bigint[] = [];
        for (let x = c.address; x <= c.last; x += a) {
            forward.push(x);
        }
        result.push(...(direction === "forward" ? forward : forward.reverse()));
    }
    return result;
}

test("planChunks covers each aligned candidate once, in order", () => {
    for (const direction of ["forward", "backward"] as const) {
        for (const alignment of [1, 2, 8]) {
            for (const n of [1, 3, 8]) {
                const got = candidates(5n, 100n, n, alignment, 16, direction);
                const want: bigint[] = [];
                for (let x = 0n; x <= 100n; x++) {
                    if (x >= 5n && x + BigInt(n) - 1n <= 100n && x % BigInt(alignment) === 0n) {
                        want.push(x);
                    }
                }
                if (direction === "backward") {
                    want.reverse();
                }
                assert.deepEqual(got, want, `${direction} align ${alignment} n ${n}`);
            }
        }
    }
});

test("planChunks handles empty ranges and the top of memory", () => {
    assert.deepEqual(candidates(10n, 12n, 4, 1, 16, "forward"), []);
    assert.deepEqual(candidates(9n, 15n, 4, 8, 16, "forward"), []);
    const top = (1n << 64n) - 1n;
    assert.deepEqual(candidates(top - 15n, top, 8, 8, 64, "forward"), [top - 15n, top - 7n]);
});

test("findInChunk skips unaligned and unreadable matches", () => {
    // Matches at 1, 3 and 8.
    const data = bytes(0, 1, 2, 1, 2, 0, 0, 0, 1, 2);
    const chunk = { address: 0n, length: data.length, last: 8n };
    assert.equal(findInChunk(data, undefined, bytes(1, 2), chunk, 1, "forward"), 1);
    assert.equal(findInChunk(data, undefined, bytes(1, 2), chunk, 1, "backward"), 8);
    assert.equal(findInChunk(data, undefined, bytes(1, 2), chunk, 4, "forward"), 8);
    const valid = Uint8Array.from(data, () => 1);
    valid[1] = 0;
    assert.equal(findInChunk(data, valid, bytes(1, 2), chunk, 1, "forward"), 3);
});

/** Memory with `data` at `base`, reads elsewhere fail. */
function fakeMemory(base: bigint, data: Uint8Array, unreadable = new Set<bigint>()) {
    const reads: [bigint, number][] = [];
    return {
        reads,
        read: async (address: bigint, length: number): Promise<ScanRead> => {
            reads.push([address, length]);
            await new Promise((r) => setTimeout(r, 1));
            if (address < base || address + BigInt(length) > base + BigInt(data.length)) {
                throw new Error(`no memory at 0x${address.toString(16)}`);
            }
            const off = Number(address - base);
            const valid = new Uint8Array(length).fill(1);
            for (const u of unreadable) {
                if (u >= address && u < address + BigInt(length)) {
                    valid[Number(u - address)] = 0;
                }
            }
            return { bytes: data.slice(off, off + length), valid };
        },
    };
}

test("scanMemory finds aligned 8-byte values across chunks", async () => {
    const data = new Uint8Array(0x1000);
    const value = bytes(0xef, 0xbe, 0xad, 0xde, 0, 0, 0, 0);
    data.set(value, 0x7fc); // unaligned, straddles a chunk boundary
    data.set(value, 0xa00);
    const mem = fakeMemory(0x4000n, data);
    const options = {
        needle: value,
        start: 0x4000n,
        end: 0x4fffn,
        read: mem.read,
        chunkSize: 0x100,
    };
    assert.deepEqual(await scanMemory({ ...options, alignment: 1, direction: "forward" }), {
        outcome: "found",
        address: 0x47fcn,
    });
    assert.deepEqual(await scanMemory({ ...options, alignment: 8, direction: "forward" }), {
        outcome: "found",
        address: 0x4a00n,
    });
    assert.deepEqual(await scanMemory({ ...options, alignment: 1, direction: "backward" }), {
        outcome: "found",
        address: 0x4a00n,
    });
});

test("scanMemory reports failed reads and unreadable bytes", async () => {
    const data = new Uint8Array(0x200);
    data.set(bytes(7, 7), 0x10);
    const mem = fakeMemory(0x1000n, data, new Set([0x1010n]));
    const result = await scanMemory({
        needle: bytes(7, 7),
        alignment: 1,
        start: 0x800n,
        end: 0x11ffn,
        direction: "forward",
        read: mem.read,
        chunkSize: 0x100,
    });
    assert.equal(result.outcome, "notFound");
    assert.ok(result.outcome === "notFound" && result.failedReads > 0);
    assert.match(result.outcome === "notFound" ? (result.firstError ?? "") : "", /no memory/);
});

test("scanMemory keeps reads in flight and can be cancelled", async () => {
    const data = new Uint8Array(0x10000);
    const mem = fakeMemory(0n, data);
    let progress = 0;
    let cancel = false;
    const result = await scanMemory({
        needle: bytes(1),
        alignment: 1,
        start: 0n,
        end: 0xffffn,
        direction: "forward",
        read: mem.read,
        chunkSize: 0x100,
        maxInFlight: 4,
        isCancelled: () => cancel,
        onProgress: () => {
            if (++progress === 3) {
                cancel = true;
            }
        },
    });
    assert.deepEqual(result, { outcome: "cancelled" });
    // Three chunks were searched and the next ones were already requested.
    assert.ok(mem.reads.length >= 6 && mem.reads.length < 0x100);
});

// ---- Webview memory cache --------------------------------------------------

test("the memory cache requests blocks once and marks changed bytes", () => {
    const sent: FromWebview[] = [];
    const cache = new MemoryCache((m) => sent.push(m));
    const max = (1n << 64n) - 1n;
    cache.reset(1);
    cache.request(0x1000n, 0x1010n, true, max);
    cache.request(0x1000n, 0x1010n, true, max);
    assert.equal(sent.length, 1);
    const req = sent[0];
    assert.ok(req.type === "read");
    assert.equal(req.address, "0x1000");

    const data = Array.from({ length: req.length }, (_, i) => i & 0xff);
    cache.handle({
        type: "data",
        epoch: 1,
        seq: req.seq,
        address: req.address,
        bytes: data,
        unreadable: [{ offset: 2, size: 1 }],
    });
    let view = cache.read(0x1000n, 3);
    assert.deepEqual(view.values, [0, 1, undefined]);
    assert.deepEqual(view.states, [ByteState.Ok, ByteState.Ok, ByteState.Unreadable]);
    assert.deepEqual(view.changed, [false, false, false]);

    // Read again after the target ran: byte 1 changed.
    cache.invalidate();
    cache.request(0x1000n, 0x1010n, true, max);
    const again = sent[1];
    assert.ok(again.type === "read");
    data[1] = 0x55;
    cache.handle({
        type: "data",
        epoch: 1,
        seq: again.seq,
        address: again.address,
        bytes: data,
        unreadable: [],
    });
    view = cache.read(0x1000n, 2);
    assert.deepEqual(view.values, [0, 0x55]);
    assert.deepEqual(view.changed, [false, true]);

    // Replies for another context are ignored.
    cache.reset(2);
    cache.handle({
        type: "data",
        epoch: 1,
        seq: again.seq,
        address: again.address,
        bytes: data,
        unreadable: [],
    });
    assert.deepEqual(cache.read(0x1000n, 1).states, [ByteState.Loading]);
});

test("the memory cache does not read when reading is not possible", () => {
    const sent: FromWebview[] = [];
    const cache = new MemoryCache((m) => sent.push(m));
    cache.request(0n, 0x1000n, false, (1n << 64n) - 1n);
    assert.equal(sent.length, 0);
});
