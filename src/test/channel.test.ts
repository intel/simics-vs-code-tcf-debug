import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "net";
import { MessageReader, TcfChannel, TraceMessage, encodeMessage, formatTcfError, stringifyJson } from "../tcf/channel";
import { parseJson, toBigInt } from "../tcf/json";

const ESC = 3;

function reader() {
    const messages: string[][] = [];
    const errors: string[] = [];
    let endOfStream = 0;
    const r = new MessageReader({
        message: (fields) => messages.push(fields),
        endOfStream: () => endOfStream++,
        error: (err) => errors.push(err.message),
    });
    return {
        push: (data: Buffer) => r.push(data),
        messages,
        errors,
        eos: () => endOfStream,
    };
}

function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

// Resolves when the server and all its connections are closed.
function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

// Each field is followed by a 0 byte, the message ends with ESC 1 (EOM).
test("encodeMessage ends fields with 0 and messages with ESC 1", () => {
    assert.deepEqual(
        encodeMessage(["C", "1", "Locator", "sync"]),
        Buffer.concat([Buffer.from("C\x001\x00Locator\x00sync\x00"), Buffer.from([ESC, 1])]),
    );
});

// A literal ESC byte (3) in a field must be sent as ESC 0.
test("encodeMessage escapes ESC bytes", () => {
    assert.deepEqual(encodeMessage(["a\x03b"]), Buffer.from([0x61, ESC, 0, 0x62, 0, ESC, 1]));
});

// Round trip with UTF-8 text, an ESC byte and an empty field.
test("MessageReader decodes what encodeMessage encodes", () => {
    const fields = ["R", "7", "null", '{"Name":"r\u00e4ksm\u00f6rg\u00e5s"}', "with\x03esc", ""];
    const r = reader();
    r.push(encodeMessage(fields));
    assert.deepEqual(r.messages, [fields]);
    assert.deepEqual(r.errors, []);
});

// TCP may split data anywhere, also between ESC and its code byte.
test("MessageReader handles a message split at any byte", () => {
    const fields = ["E", "RunControl", "contextSuspended", '"a\x03b"', "4096"];
    const data = encodeMessage(fields);
    for (let i = 0; i <= data.length; i++) {
        const r = reader();
        r.push(data.subarray(0, i));
        r.push(data.subarray(i));
        assert.deepEqual(r.messages, [fields], `split at byte ${i}`);
    }
});

// Worst case for the reader state: every byte arrives in its own chunk.
test("MessageReader handles a message sent one byte at a time", () => {
    const fields = ["R", "1", "\x03\x03", "x"];
    const r = reader();
    for (const b of encodeMessage(fields)) {
        r.push(Buffer.from([b]));
    }
    assert.deepEqual(r.messages, [fields]);
});

test("MessageReader fuzzes encoded fields across random TCP chunk boundaries", () => {
    const random = seededRandom(0x544346);
    const nextInt = (max: number) => Math.floor(random() * max);
    const boundaryCodePoints = [
        1, 2, 3, 9, 10, 13, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x1f642, 0x10ffff,
    ];
    const messages: string[][] = [];
    const encoded: Buffer[] = [];

    for (let i = 0; i < 500; i++) {
        const fields: string[] = [];
        for (let field = 0, fieldCount = 1 + nextInt(6); field < fieldCount; field++) {
            let value = "";
            for (let character = 0, characterCount = nextInt(32); character < characterCount; character++) {
                let codePoint: number;
                if (random() < 0.5) {
                    codePoint = boundaryCodePoints[nextInt(boundaryCodePoints.length)];
                } else {
                    codePoint = nextInt(0x110000);
                    if (codePoint === 0) {
                        codePoint = 1;
                    } else if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
                        codePoint += 0x800;
                    }
                }
                value += String.fromCodePoint(codePoint);
            }
            fields.push(value);
        }
        messages.push(fields);
        encoded.push(encodeMessage(fields));
    }

    const data = Buffer.concat(encoded);
    const r = reader();
    for (let offset = 0; offset < data.length;) {
        const end = Math.min(data.length, offset + 1 + nextInt(96));
        r.push(data.subarray(offset, end));
        offset = end;
    }

    assert.deepEqual(r.messages, messages);
    assert.deepEqual(r.errors, []);
});

test("MessageReader tolerates fuzzed arbitrary transport bytes", () => {
    const random = seededRandom(0x54434602);
    const nextInt = (max: number) => Math.floor(random() * max);
    const data = Buffer.alloc(20_000);
    for (let i = 0; i < data.length; i++) {
        data[i] = nextInt(256);
    }

    const r = reader();
    assert.doesNotThrow(() => {
        for (let offset = 0; offset < data.length;) {
            const end = Math.min(data.length, offset + 1 + nextInt(96));
            r.push(data.subarray(offset, end));
            offset = end;
        }
    });
});

// One TCP read can hold several messages, each must be reported.
test("MessageReader handles several messages in one chunk", () => {
    const r = reader();
    r.push(Buffer.concat([encodeMessage(["R", "1", "null"]), encodeMessage(["R", "2", "[]"])]));
    assert.deepEqual(r.messages, [
        ["R", "1", "null"],
        ["R", "2", "[]"],
    ]);
});

// An EOM with no fields before it is not a message and is dropped.
test("MessageReader ignores empty messages", () => {
    const r = reader();
    r.push(Buffer.from([ESC, 1, ESC, 1]));
    assert.deepEqual(r.messages, []);
});

// Parts of a field kept between chunks must be copied, because the caller
// may reuse the chunk buffers.
test("MessageReader copies data kept from earlier chunks", () => {
    const r = reader();
    const chunk1 = Buffer.from([0x61, 0x62, ESC]);
    const chunk2 = Buffer.from([0, 0x63]);
    r.push(chunk1);
    r.push(chunk2);
    chunk1.fill(0x7a);
    chunk2.fill(0x7a);
    r.push(Buffer.from([0, ESC, 1]));
    assert.deepEqual(r.messages, [["ab\x03c"]]);
});

// ESC 2 (end of stream) is reported and the rest of the data is ignored.
test("MessageReader stops at end of stream", () => {
    const r = reader();
    r.push(Buffer.concat([encodeMessage(["R", "1"]), Buffer.from([ESC, 2]), encodeMessage(["R", "2"])]));
    assert.deepEqual(r.messages, [["R", "1"]]);
    assert.equal(r.eos(), 1);
});

// A bad escape code is reported, then reading goes on with the next byte.
test("MessageReader reports unknown escape codes and goes on", () => {
    const r = reader();
    r.push(Buffer.concat([Buffer.from([ESC, 9]), encodeMessage(["R", "1"])]));
    assert.deepEqual(r.errors, ["Unsupported TCF escape sequence ESC 9"]);
    assert.deepEqual(r.messages, [["R", "1"]]);
});

// Normal numbers, also floats and large non-integers, stay JS numbers.
test("parseJson keeps safe numbers as numbers", () => {
    assert.deepEqual(parseJson('{"a":1,"b":-2,"c":1.5,"d":1e300}'), {
        a: 1,
        b: -2,
        c: 1.5,
        d: 1e300,
    });
});

// Integers beyond 2^53 (64-bit addresses) must not lose precision.
test("parseJson returns large integers as bigint", () => {
    assert.deepEqual(parseJson("[9007199254740993,18446744073709551615,-9223372036854775808]"), [
        9007199254740993n,
        18446744073709551615n,
        -9223372036854775808n,
    ]);
});

// bigint values are sent as JSON numbers, not strings, and parse back the
// same. undefined becomes null.
test("stringifyJson writes bigint as plain JSON numbers", () => {
    const text = stringifyJson({
        Addr: 0xffffffffffffffffn,
        Size: 4,
        Name: "x",
    });
    assert.equal(text, '{"Addr":18446744073709551615,"Size":4,"Name":"x"}');
    assert.deepEqual(parseJson(text), {
        Addr: 0xffffffffffffffffn,
        Size: 4,
        Name: "x",
    });
    assert.equal(stringifyJson([-1n, null]), "[-1,null]");
    assert.equal(stringifyJson(undefined), "null");
});

// Only bigint and integer numbers convert, floats and strings do not.
test("toBigInt accepts integers only", () => {
    assert.equal(toBigInt(5n), 5n);
    assert.equal(toBigInt(4096), 4096n);
    assert.equal(toBigInt(1.5), undefined);
    assert.equal(toBigInt("5"), undefined);
    assert.equal(toBigInt(undefined), undefined);
});

// Error reports: {N} is filled in from Params and kept if Params has no
// such entry. Without Format, Code is used, and last the raw JSON.
test("formatTcfError formats error reports", () => {
    assert.equal(formatTcfError(null), "unknown error");
    assert.equal(formatTcfError("plain text"), "plain text");
    assert.equal(
        formatTcfError({
            Code: 1,
            Format: "Cannot read {0} at {1}",
            Params: ["memory", "0x10"],
        }),
        "Cannot read memory at 0x10",
    );
    assert.equal(formatTcfError({ Format: "{0} and {1}", Params: ["one"] }), "one and {1}");
    assert.equal(formatTcfError({ Format: "No params {0}" }), "No params {0}");
    assert.equal(formatTcfError({ Code: 22 }), "error code 22");
    assert.equal(formatTcfError({ Code: 22, Format: "" }), "error code 22");
    assert.equal(formatTcfError({ Other: 1 }), '{"Other":1}');
});

// Replies only have the token of their command, so the trace looks up which
// command they answer. A fake agent answers "bogus" with N, other commands
// with P, a heartbeat event, flow control and R.
test("TcfChannel trace gives the type, service and name of each message", async () => {
    const server = net.createServer((socket) => {
        const r = new MessageReader({
            message: (fields) => {
                if (fields[0] !== "C") {
                    return;
                }
                if (fields[3] === "bogus") {
                    socket.write(encodeMessage(["N", fields[1]]));
                    return;
                }
                socket.write(encodeMessage(["P", fields[1], "1"]));
                socket.write(encodeMessage(["E", "Locator", "peerHeartBeat", '"peer"']));
                socket.write(encodeMessage(["F", "0"]));
                socket.write(encodeMessage(["R", fields[1], "null"]));
            },
            endOfStream: () => socket.end(),
            error: () => undefined,
        });
        socket.on("data", (data) => r.push(data as Buffer));
        socket.write(encodeMessage(["E", "Locator", "Hello", '["CommandLine"]']));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const traced: [string, string, TraceMessage][] = [];
    const channel = new TcfChannel((dir, text, message) => traced.push([dir, text.split(" ")[0], message]));
    try {
        await channel.connect("127.0.0.1", (server.address() as net.AddressInfo).port, 5000);
        await channel.command("CommandLine", "keyPressed", 0, 65);
        await assert.rejects(channel.command("CommandLine", "bogus"), /not supported/);
    } finally {
        channel.close();
        await closeServer(server);
    }
    const keyPressed = { service: "CommandLine", name: "keyPressed" };
    const bogus = { service: "CommandLine", name: "bogus" };
    assert.deepEqual(traced, [
        ["->", "E", { type: "event", service: "Locator", name: "Hello" }],
        ["<-", "E", { type: "event", service: "Locator", name: "Hello" }],
        ["->", "C", { type: "command", ...keyPressed }],
        ["<-", "P", { type: "command", ...keyPressed }],
        ["<-", "E", { type: "event", service: "Locator", name: "peerHeartBeat" }],
        ["<-", "F", { type: "flowControl" }],
        ["<-", "R", { type: "command", ...keyPressed }],
        ["->", "C", { type: "command", ...bogus }],
        ["<-", "N", { type: "command", ...bogus }],
    ]);
});

test("TcfChannel onAnyEvent gets every event after its own listeners", async () => {
    const server = net.createServer((socket) => {
        const r = new MessageReader({
            message: (fields) => {
                if (fields[0] !== "C") {
                    return;
                }
                socket.write(encodeMessage(["E", "RunControl", "containerResumed", '["a","b"]']));
                socket.write(encodeMessage(["E", "Memory", "memoryChanged", '"m"', "[]"]));
                socket.write(encodeMessage(["R", fields[1], ""]));
            },
            endOfStream: () => socket.end(),
            error: () => undefined,
        });
        socket.on("data", (data) => r.push(data as Buffer));
        socket.write(encodeMessage(["E", "Locator", "Hello", '["RunControl"]']));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const channel = new TcfChannel();
    const seen: unknown[][] = [];
    channel.onEvent("RunControl", "containerResumed", (args) => seen.push(["own", ...args]));
    const remove = channel.onAnyEvent((service, event, args) => seen.push([service, event, ...args]));
    try {
        await channel.connect("127.0.0.1", (server.address() as net.AddressInfo).port, 5000);
        await channel.command("RunControl", "suspend", "a");
        remove();
        await channel.command("RunControl", "suspend", "a");
    } finally {
        channel.close();
        await closeServer(server);
    }
    assert.deepEqual(seen, [
        ["Locator", "Hello", ["RunControl"]],
        ["own", ["a", "b"]],
        ["RunControl", "containerResumed", ["a", "b"]],
        ["Memory", "memoryChanged", "m", []],
        ["own", ["a", "b"]],
    ]);
});
