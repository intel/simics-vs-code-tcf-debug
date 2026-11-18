import { test } from "node:test";
import assert from "node:assert/strict";
import type { TraceMessage } from "@/tcf/channel";
import { TraceSilenceRule, isSilenced, parseTraceSilence } from "@/tcf/traceSilence";

// The default keeps the trace to the debugger's own traffic: no heartbeats or
// other peer events, nothing from the Simics console and no Simics log events.
test("the default silences Locator peer events, CommandLine and SimicsLogs events", () => {
    const { rules } = parseTraceSilence(undefined);
    const silenced = (message: TraceMessage) => isSilenced(rules, message);
    for (const name of ["peerHeartBeat", "peerAdded", "peerRemoved", "peerChanged"]) {
        assert.equal(silenced({ type: "event", service: "Locator", name }), true, name);
    }
    assert.equal(silenced({ type: "event", service: "Locator", name: "Hello" }), false);
    assert.equal(silenced({ type: "command", service: "CommandLine", name: "keyPressed" }), true);
    assert.equal(silenced({ type: "command", service: "CommandLine", name: "connect" }), true);
    assert.equal(silenced({ type: "event", service: "CommandLine", name: "write" }), true);
    assert.equal(silenced({ type: "event", service: "SimicsLogs", name: "message" }), true);
    assert.equal(silenced({ type: "command", service: "SimicsLogs", name: "subscribe" }), false);
    assert.equal(silenced({ type: "command", service: "Breakpoints", name: "add" }), false);
    assert.equal(silenced({ type: "event", service: "RunControl", name: "contextSuspended" }), false);
    assert.equal(silenced({ type: "flowControl" }), false);
});

// Missing type and name mean "*".
test("isSilenced matches service, type and name", () => {
    const rules: TraceSilenceRule[] = [
        { service: "Memory", type: ["command"], name: "get" },
        { service: "RunControl", type: ["event"], name: "*" },
        { service: "Registers" },
    ];
    const silenced = (message: TraceMessage) => isSilenced(rules, message);
    assert.equal(silenced({ type: "command", service: "Memory", name: "get" }), true);
    assert.equal(silenced({ type: "command", service: "Memory", name: "set" }), false);
    assert.equal(silenced({ type: "event", service: "Memory", name: "memoryChanged" }), false);
    assert.equal(silenced({ type: "event", service: "RunControl", name: "contextSuspended" }), true);
    assert.equal(silenced({ type: "command", service: "RunControl", name: "resume" }), false);
    assert.equal(silenced({ type: "command", service: "Registers", name: "getm" }), true);
    assert.equal(isSilenced([], { type: "event", service: "Locator", name: "peerHeartBeat" }), false);
});

// Flow control messages have no service or name: only "*" matches them.
test("flow control is only silenced with * for service and name", () => {
    const flowControl: TraceMessage = { type: "flowControl" };
    assert.equal(isSilenced([{ service: "*", type: ["flowControl"], name: "*" }], flowControl), true);
    assert.equal(isSilenced([{ service: "*", type: ["flowControl"] }], flowControl), true);
    assert.equal(isSilenced([{ service: "Locator", type: ["flowControl"], name: "*" }], flowControl), false);
    assert.equal(isSilenced([{ service: "*", type: ["flowControl"], name: "x" }], flowControl), false);
    assert.equal(isSilenced([{ service: "*", type: ["event"] }], flowControl), false);
});

// Not set means the default, an empty list logs everything, and items that
// are not rules are returned so the session can report them.
test("parseTraceSilence reads service/type/name rules", () => {
    assert.deepEqual(parseTraceSilence(undefined), {
        rules: [
            { service: "Locator", type: ["event"], name: "peerHeartBeat" },
            { service: "Locator", type: ["event"], name: "peerAdded" },
            { service: "Locator", type: ["event"], name: "peerRemoved" },
            { service: "Locator", type: ["event"], name: "peerChanged" },
            { service: "CommandLine" },
            { service: "SimicsLogs", type: ["event"] },
        ],
        invalid: [],
    });
    assert.deepEqual(parseTraceSilence([]), { rules: [], invalid: [] });
    assert.deepEqual(parseTraceSilence(["Memory/command,event/get", "*/flowControl", "RunControl/*"]), {
        rules: [
            { service: "Memory", type: ["command", "event"], name: "get" },
            { service: "*", type: ["flowControl"] },
            { service: "RunControl", type: ["*"] },
        ],
        invalid: [],
    });
    const invalid = ["", "/event", "Memory/", "Memory/result", "Memory/event/", "a/event/b/c", "Memory/*,event", 1];
    assert.deepEqual(parseTraceSilence(invalid), { rules: [], invalid });
    assert.deepEqual(parseTraceSilence("Memory"), { rules: [{ service: "Memory" }], invalid: [] });
});
