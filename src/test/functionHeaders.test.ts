import { test } from "node:test";
import assert from "node:assert/strict";
import {
    FUNCTION_HEADER_SCHEME,
    FunctionInfo,
    FunctionRanges,
    functionHeaderLine,
    functionHeaderSource,
    functionHeaderText,
} from "@/functionHeaders";

/** Lookup over fixed functions, counting the addresses asked for. */
function fakeLookup(functions: FunctionInfo[]) {
    const asked: bigint[] = [];
    const lookup = async (_contextId: string, address: bigint) => {
        asked.push(address);
        return functions.find((f) => f.address <= address && address < f.address + BigInt(f.size ?? 1));
    };
    return { lookup, asked };
}

const foo: FunctionInfo = { name: "foo", address: 0x1000n, size: 0x10 };
const bar: FunctionInfo = { name: "bar", address: 0x1010n, size: 0x10 };

// One lookup per function, the function covers its other instructions.
test("FunctionRanges looks up each function once", async () => {
    const fake = fakeLookup([foo, bar]);
    const ranges = new FunctionRanges(fake.lookup);
    const found = await ranges.find("cpu0", [0x1018n, 0x1000n, 0x1004n, 0x1010n]);
    assert.deepEqual(
        [...found].sort(([a], [b]) => (a < b ? -1 : 1)),
        [
            [0x1000n, foo],
            [0x1004n, foo],
            [0x1010n, bar],
            [0x1018n, bar],
        ],
    );
    // Looked up in the given order.
    assert.deepEqual(fake.asked, [0x1018n, 0x1000n]);
    await ranges.find("cpu0", [0x100cn, 0x101cn]);
    assert.deepEqual(fake.asked, [0x1018n, 0x1000n]);
});

// Addresses without a function are remembered, failed lookups count as no
// function, and the lookups per call are limited.
test("FunctionRanges remembers addresses without a function", async () => {
    let asked = 0;
    const ranges = new FunctionRanges(async (_contextId, address) => {
        asked++;
        if (address === 0x2000n) {
            throw new Error("Symbol not found");
        }
        return undefined;
    }, 2);
    const addresses = [0x2000n, 0x2004n, 0x2008n];
    assert.equal((await ranges.find("cpu0", addresses)).size, 0);
    assert.equal(asked, 2);
    await ranges.find("cpu0", addresses);
    assert.equal(asked, 3);
    await ranges.find("cpu0", addresses);
    assert.equal(asked, 3);
});

// Without a size only the entry is known, a reply that does not contain the
// address is ignored. Results are per context and can be cleared.
test("FunctionRanges handles functions without a size", async () => {
    const split: FunctionInfo = { name: "split", address: 0x3000n };
    const fake = fakeLookup([split]);
    const ranges = new FunctionRanges(async (contextId, address) =>
        address === 0x3004n ? split : fake.lookup(contextId, address),
    );
    const found = await ranges.find("cpu0", [0x3000n, 0x3004n]);
    assert.deepEqual([...found], [[0x3000n, split]]);
    assert.equal((await ranges.find("cpu1", [0x3000n])).size, 1);
    assert.deepEqual(fake.asked, [0x3000n, 0x3000n]);
    ranges.delete("cpu1");
    await ranges.find("cpu1", [0x3000n]);
    ranges.clear();
    await ranges.find("cpu0", [0x3000n]);
    assert.deepEqual(fake.asked, [0x3000n, 0x3000n, 0x3000n, 0x3000n]);
});

// VS Code decodes the path of the source URI, the document gets the name
// back, also with characters that need escaping.
test("function header sources round trip the name", () => {
    const f: FunctionInfo = {
        name: "ns::operator/(a, b)<int>",
        address: 0xffff0000n,
        size: 4,
    };
    const source = functionHeaderSource(f);
    assert.equal(source.name, f.name);
    const prefix = `${FUNCTION_HEADER_SCHEME}:`;
    assert.ok(source.path!.startsWith(`${prefix}/0xffff0000/1//`));
    const path = decodeURIComponent(source.path!.slice(prefix.length));
    assert.equal(functionHeaderText(path), "<ns::operator/(a, b)<int>>");
    assert.notEqual(functionHeaderSource({ ...f, address: 0x10n }).path, source.path);
});

// With a source location the header is on the entry's line, with the file
// name. VS Code shows it as "22: dummy-prog1.c: <start>".
test("function headers are on the source line of the entry", () => {
    const f: FunctionInfo = {
        name: "start",
        address: 0x100007an,
        size: 0x29,
        file: "dummy prog#1.c",
        line: 22,
    };
    assert.equal(functionHeaderLine(f), 22);
    assert.equal(functionHeaderLine({ ...f, line: 0 }), 1);
    const source = functionHeaderSource(f);
    const prefix = `${FUNCTION_HEADER_SCHEME}:`;
    const path = decodeURIComponent(source.path!.slice(prefix.length));
    assert.equal(path, "/0x100007a/22/dummy prog#1.c/start");
    const text = functionHeaderText(path)!;
    assert.equal(text.split("\n").length, 22);
    assert.equal(text.split("\n")[21], "dummy prog#1.c: <start>");
});

// Paths above the header files are directories.
test("function header directories have no text", () => {
    for (const path of ["/", "/0x10", "/0x10/3", "/0x10/3/f.c", "/0x10/x/f/n"]) {
        assert.equal(functionHeaderText(path), undefined, path);
    }
});
