import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCallStackContext } from "@/callStackFrame";

test("parseCallStackContext reads the thread and frame index", () => {
    assert.deepEqual(
        parseCallStackContext({
            sessionId: "abc-123",
            threadId: "thread:abc-123:7",
            frameId: "stackframe:thread:abc-123:7:2:main.c",
            frameName: "main",
        }),
        { sessionId: "abc-123", threadId: 7, frameIndex: 2 },
    );
});

test("parseCallStackContext allows colons in the source name", () => {
    assert.deepEqual(
        parseCallStackContext({
            sessionId: "s",
            frameId: "stackframe:thread:s:1:0:C:\\src\\a.c",
        }),
        { sessionId: "s", threadId: 1, frameIndex: 0 },
    );
});

test("parseCallStackContext rejects other items", () => {
    assert.equal(parseCallStackContext(undefined), undefined);
    assert.equal(parseCallStackContext("file:///a.c"), undefined);
    assert.equal(parseCallStackContext({ sessionId: "s", threadId: "thread:s:1" }), undefined);
    assert.equal(
        parseCallStackContext({
            sessionId: "s",
            frameId: "stackframe:thread:other:1:0:a.c",
        }),
        undefined,
    );
});
