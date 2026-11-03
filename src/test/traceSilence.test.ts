import { test } from "node:test";
import assert from "node:assert/strict";
import type { TraceMessage } from "../tcf/channel";
import { DEFAULT_TRACE_SILENCE, TraceSilenceRule, isSilenced, parseTraceSilence } from "../tcf/traceSilence";

// The default keeps the trace to the debugger's own traffic: no heartbeats or
// other peer events, and nothing from the Simics console.
test("the default silences Locator peer events and the CommandLine service", () => {
    const silenced = (message: TraceMessage) => isSilenced(DEFAULT_TRACE_SILENCE, message);
    for (const name of ["peerHeartBeat", "peerAdded", "peerRemoved", "peerChanged"]) {
        assert.equal(silenced({ type: "event", service: "Locator", name }), true, name);
    }
    assert.equal(silenced({ type: "event", service: "Locator", name: "Hello" }), false);
    assert.equal(silenced({ type: "command", service: "CommandLine", name: "keyPressed" }), true);
    assert.equal(silenced({ type: "command", service: "CommandLine", name: "connect" }), true);
    assert.equal(silenced({ type: "event", service: "CommandLine", name: "write" }), true);
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

// Not set means the default, an empty list logs everything, and entries that
// are not rules are returned so the session can report them.
test("parseTraceSilence uses the default only when not set", () => {
    assert.deepEqual(parseTraceSilence(undefined), { rules: DEFAULT_TRACE_SILENCE, invalid: [] });
    assert.deepEqual(parseTraceSilence([]), { rules: [], invalid: [] });
    const rule = { service: "Memory", type: ["command"], name: "get" };
    const invalid = [
        { name: "get" },
        "Memory",
        { service: "Memory", name: 1 },
        { service: "Memory", type: "event" },
        { service: "Memory", type: [] },
        { service: "Memory", type: ["result"] },
    ];
    assert.deepEqual(parseTraceSilence([rule, ...invalid]), { rules: [rule], invalid });
    assert.deepEqual(parseTraceSilence(rule), { rules: [rule], invalid: [] });
});
