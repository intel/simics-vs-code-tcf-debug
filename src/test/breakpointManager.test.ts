import { test } from "node:test";
import assert from "node:assert/strict";
import { BreakpointHost, BreakpointManager, parseHitCondition } from "../breakpointManager";
import { instructionReference } from "../disassembly";
import { formatFunctionBreakpointName, parseFunctionBreakpointName } from "../functionBreakpoint";
import { PathMapper } from "../pathMapper";
import {
    BreakpointCapabilities,
    BreakpointProperties,
    BreakpointStatus,
    BreakpointsService,
} from "../tcf/services/breakpoints";

// TCF ignores the first IgnoreCount hits, so "N" means ignore N-1 hits.
// Zero and extra spaces are allowed.
test('parseHitCondition turns "N" and ">= N" into an ignore count', () => {
    assert.equal(parseHitCondition("5"), 4);
    assert.equal(parseHitCondition(">= 3"), 2);
    assert.equal(parseHitCondition(">=3"), 2);
    assert.equal(parseHitCondition("  1  "), 0);
    assert.equal(parseHitCondition("0"), 0);
    assert.equal(parseHitCondition(">= 0"), 0);
});

// Other DAP hit conditions cannot be done with an ignore count.
test("parseHitCondition rejects other conditions", () => {
    for (const condition of ["", "> 3", "== 3", "%2", "-1", "1.5", "x", ">="]) {
        assert.equal(parseHitCondition(condition), undefined, condition);
    }
});

interface FakeAgent {
    service: BreakpointsService;
    commands: [string, unknown][];
    caps: BreakpointCapabilities;
}

function fakeAgent(): FakeAgent {
    const agent: FakeAgent = {
        commands: [],
        caps: { Location: true, ContextIds: true },
        service: undefined as unknown as BreakpointsService,
    };
    agent.service = {
        add: async (bp: BreakpointProperties) => {
            agent.commands.push(["add", bp]);
        },
        change: async (bp: BreakpointProperties) => {
            agent.commands.push(["change", bp]);
        },
        remove: async (ids: string[]) => {
            agent.commands.push(["remove", ids]);
        },
        getStatus: async (): Promise<BreakpointStatus> => ({
            Instances: [{ LocationContext: "thread1", Address: 0x1010 }],
        }),
        getCapabilities: async () => agent.caps,
        addListener: () => undefined,
    } as unknown as BreakpointsService;
    return agent;
}

function fakeHost(threads: string[]): BreakpointHost & { events: unknown[] } {
    const events: unknown[] = [];
    return {
        events,
        sendEvent: (e) => events.push(e),
        sourceLineAt: async () => undefined,
        toTargetPath: async (p) => p,
        capabilityContext: () => undefined,
        processContexts: (ctxId) => (ctxId === "thread1" || ctxId === "proc" ? ["proc", ...threads] : [ctxId]),
        defaultContext: () => "thread1",
    };
}

test("function breakpoint names preserve explicit context scopes", async () => {
    assert.deepEqual(parseFunctionBreakpointName(formatFunctionBreakpointName("start_kernel", "cpu0")), {
        location: "start_kernel",
        contextId: "cpu0",
        hasContextDelimiter: true,
    });
    assert.deepEqual(parseFunctionBreakpointName(formatFunctionBreakpointName("start_kernel")), {
        location: "start_kernel",
        contextId: undefined,
        hasContextDelimiter: false,
    });
    const agent = fakeAgent();
    const manager = new BreakpointManager(agent.service, fakeHost(["thread1"]));
    await manager.setFunctionBreakpoints([
        { name: "start_kernel @ armv8.cluster[0].core[0]", condition: "ready", hitCondition: "3" },
        { name: "start_kernel" },
        { name: "start_kernel @ armv8.cluster[1].core[0]" },
    ]);
    const properties = agent.commands.map(([, props]) => props as BreakpointProperties);
    assert.equal(properties[0].Location, "start_kernel");
    assert.deepEqual(properties[0].ContextIds, ["armv8.cluster[0].core[0]"]);
    assert.equal(properties[0].Condition, "ready");
    assert.equal(properties[0].IgnoreCount, 2);
    assert.equal(properties[1].Location, "start_kernel");
    assert.equal(properties[1].ContextIds, undefined);
    assert.deepEqual(properties[2].ContextIds, ["armv8.cluster[1].core[0]"]);
    await manager.setFunctionBreakpoints([{ name: "start_kernel @ armv8.cluster[0].core[0]", condition: "updated" }]);
    const changed = agent.commands.find(([command]) => command === "change")?.[1] as BreakpointProperties;
    assert.equal(changed.ID, properties[0].ID);
    assert.deepEqual(changed.ContextIds, properties[0].ContextIds);
});

test("scoped function breakpoints never fall back to global planting", async () => {
    const agent = fakeAgent();
    agent.caps.ContextIds = false;
    const manager = new BreakpointManager(agent.service, fakeHost(["thread1"]));
    const [unsupported, missingContext, missingSymbol] = await manager.setFunctionBreakpoints([
        { name: "start_kernel @ cpu0" },
        { name: "start_kernel @ " },
        { name: " @ cpu0" },
    ]);
    assert.equal(unsupported.verified, false);
    assert.match(unsupported.message ?? "", /ContextIds support/);
    assert.match(missingContext.message ?? "", /symbol @ context ID/);
    assert.match(missingSymbol.message ?? "", /symbol @ context ID/);
    assert.equal(agent.commands.length, 0);
});

test("path map edits remap planted source breakpoints without changing IDs", async () => {
    const agent = fakeAgent();
    const host = fakeHost(["thread1"]);
    let prefix = "/old";
    host.toTargetPath = async () => `${prefix}/main.c`;
    const manager = new BreakpointManager(agent.service, host);
    const [before] = await manager.setSourceBreakpoints({ path: "/host/main.c" }, [
        { line: 12, condition: "ready", hitCondition: "3" },
    ]);
    const initial = agent.commands[0][1] as BreakpointProperties;
    prefix = "/new";
    await manager.updateSourcePaths();
    const [command, updated] = agent.commands[1] as [string, BreakpointProperties];
    assert.equal(command, "change");
    assert.equal(updated.ID, initial.ID);
    assert.equal(updated.File, "/new/main.c");
    assert.equal(updated.Line, 12);
    assert.equal(updated.Condition, initial.Condition);
    assert.equal(updated.IgnoreCount, initial.IgnoreCount);
    assert.deepEqual(manager.hits([updated.ID]).dapIds, [before.id]);
    await manager.updateSourcePaths();
    assert.equal(agent.commands.length, 2);
});

test("source context reaches reverse mapping and constrains the mapped breakpoint", async () => {
    const agent = fakeAgent();
    const host = fakeHost(["cpu0", "cpu1"]);
    const calls: (string | undefined)[] = [];
    let mapped = true;
    host.toTargetPath = async (file, contextId) => {
        calls.push(contextId);
        return mapped ? { path: "/build/main.c", contextId } : file;
    };
    const manager = new BreakpointManager(agent.service, host);
    await manager.setSourceBreakpoints({ path: "/host/main.c", adapterData: { contextId: "cpu1" } }, [{ line: 12 }]);
    const planted = agent.commands[0][1] as BreakpointProperties;
    assert.equal(planted.File, "/build/main.c");
    assert.deepEqual(planted.ContextIds, ["cpu1"]);
    mapped = false;
    await manager.updateSourcePaths();
    const changed = agent.commands[1][1] as BreakpointProperties;
    assert.equal(changed.File, "/host/main.c");
    assert.equal(changed.ContextIds, undefined);
    assert.deepEqual(calls, ["cpu1", "cpu1"]);
});

test("scoped reverse mapping is not planted globally without ContextIds support", async () => {
    const agent = fakeAgent();
    agent.caps.ContextIds = false;
    const host = fakeHost(["cpu0"]);
    host.toTargetPath = async () => ({
        path: "/build/main.c",
        contextId: "cpu0",
    });
    const manager = new BreakpointManager(agent.service, host);
    const [breakpoint] = await manager.setSourceBreakpoints(
        { path: "/host/main.c", adapterData: { contextId: "cpu0" } },
        [{ line: 12 }],
    );
    assert.equal(breakpoint.verified, false);
    assert.match(breakpoint.message ?? "", /ContextIds support/);
    assert.deepEqual(agent.commands, []);
});

test("unscoped rules keep source breakpoints global even with source context metadata", async () => {
    const agent = fakeAgent();
    agent.caps.ContextIds = false;
    const mapper = new PathMapper([{ source: "/build", destination: "/host" }], undefined);
    const host = fakeHost(["cpu0", "cpu1"]);
    host.toTargetPath = (file, id) => mapper.toTargetLocation(file, id);
    const manager = new BreakpointManager(agent.service, host);
    const [breakpoint] = await manager.setSourceBreakpoints(
        { path: "/host/main.c", adapterData: { contextId: "cpu0" } },
        [{ line: 12 }],
    );
    assert.equal(breakpoint.verified, true);
    const planted = agent.commands[0][1] as BreakpointProperties;
    assert.equal(planted.File, "/build/main.c");
    assert.equal(planted.ContextIds, undefined);
});

test("changing only a rule scope updates existing breakpoint ContextIds", async () => {
    const agent = fakeAgent();
    const original = { source: "/build", destination: "/host" };
    const mapper = new PathMapper([original], undefined);
    const host = fakeHost(["cpu0", "cpu1"]);
    host.toTargetPath = (file, id) => mapper.toTargetLocation(file, id);
    const manager = new BreakpointManager(agent.service, host);
    await manager.setSourceBreakpoints({ path: "/host/main.c", adapterData: { contextId: "cpu0" } }, [{ line: 12 }]);
    const initial = agent.commands[0][1] as BreakpointProperties;
    assert.equal(initial.ContextIds, undefined);
    await mapper.replaceRules([{ ...original, context: "cpu0" }]);
    await manager.updateSourcePaths();
    const scoped = agent.commands[1][1] as BreakpointProperties;
    assert.equal(scoped.ID, initial.ID);
    assert.equal(scoped.File, initial.File);
    assert.deepEqual(scoped.ContextIds, ["cpu0"]);
    await mapper.replaceRules([original]);
    await manager.updateSourcePaths();
    const unscoped = agent.commands[2][1] as BreakpointProperties;
    assert.equal(unscoped.File, initial.File);
    assert.equal(unscoped.ContextIds, undefined);
});

test("an unsafe live scope edit removes the old global breakpoint and can recover", async () => {
    const agent = fakeAgent();
    agent.caps.ContextIds = false;
    const original = { source: "/build", destination: "/host" };
    const mapper = new PathMapper([original], undefined);
    const host = fakeHost(["cpu0"]);
    host.toTargetPath = (file, id) => mapper.toTargetLocation(file, id);
    const manager = new BreakpointManager(agent.service, host);
    const [before] = await manager.setSourceBreakpoints({ path: "/host/main.c", adapterData: { contextId: "cpu0" } }, [
        { line: 12 },
    ]);
    const initial = agent.commands[0][1] as BreakpointProperties;
    await mapper.replaceRules([{ ...original, context: "cpu0" }]);
    await manager.updateSourcePaths();
    assert.deepEqual(agent.commands[1], ["remove", [initial.ID]]);
    assert.ok(
        host.events.some((value) => {
            const event = value as {
                body?: { breakpoint?: { id?: number; message?: string } };
            };
            return (
                event.body?.breakpoint?.id === before.id &&
                event.body?.breakpoint?.message?.includes("ContextIds support")
            );
        }),
    );
    await mapper.replaceRules([original]);
    await manager.updateSourcePaths();
    assert.equal(agent.commands[2][0], "add");
});

// The breakpoint is planted at the reference address plus the offset, in the
// process of the context in the reference.
test("setInstructionBreakpoints plants an address breakpoint in the process", async () => {
    const agent = fakeAgent();
    const manager = new BreakpointManager(agent.service, fakeHost(["thread1", "thread2"]));
    const [bp] = await manager.setInstructionBreakpoints([
        {
            instructionReference: instructionReference("thread1", 0x1000n),
            offset: 0x10,
        },
    ]);
    assert.equal(agent.commands.length, 1);
    const [command, props] = agent.commands[0] as [string, BreakpointProperties];
    assert.equal(command, "add");
    assert.equal(props.Location, "0x1010");
    assert.deepEqual(props.ContextIds, ["proc", "thread1", "thread2"]);
    assert.equal(bp.verified, true);
    assert.equal(bp.instructionReference, instructionReference("thread1", 0x1010n));

    const hits = manager.hits([props.ID]);
    assert.deepEqual(hits.dapIds, [bp.id]);
    assert.equal(hits.reason, "instruction breakpoint");
});

// An unchanged list is not sent again, a removed breakpoint is removed.
test("setInstructionBreakpoints keeps unchanged breakpoints and removes others", async () => {
    const agent = fakeAgent();
    const manager = new BreakpointManager(agent.service, fakeHost(["thread1"]));
    const request = {
        instructionReference: instructionReference("thread1", 0x2000n),
    };
    const [first] = await manager.setInstructionBreakpoints([request]);
    const [again] = await manager.setInstructionBreakpoints([request]);
    assert.equal(again.id, first.id);
    assert.equal(agent.commands.length, 1);
    await manager.setInstructionBreakpoints([]);
    assert.equal(agent.commands[1][0], "remove");
});

// A reference without a context uses the default context. Agents without
// ContextIds get a breakpoint on all contexts.
test("setInstructionBreakpoints handles plain addresses and agents without ContextIds", async () => {
    const agent = fakeAgent();
    const manager = new BreakpointManager(agent.service, fakeHost(["thread1"]));
    await manager.setInstructionBreakpoints([{ instructionReference: "0x3000", offset: -4 }]);
    let props = agent.commands[0][1] as BreakpointProperties;
    assert.equal(props.Location, "0x2ffc");
    assert.deepEqual(props.ContextIds, ["proc", "thread1"]);

    const noIds = fakeAgent();
    noIds.caps = { Location: true, ContextIds: false };
    const other = new BreakpointManager(noIds.service, fakeHost(["thread1"]));
    await other.setInstructionBreakpoints([{ instructionReference: "0x3000" }]);
    props = noIds.commands[0][1] as BreakpointProperties;
    assert.equal(props.ContextIds, undefined);
});

test("setInstructionBreakpoints reports invalid references", async () => {
    const agent = fakeAgent();
    const manager = new BreakpointManager(agent.service, fakeHost([]));
    const [bp] = await manager.setInstructionBreakpoints([{ instructionReference: "main" }]);
    assert.equal(bp.verified, false);
    assert.match(bp.message ?? "", /Invalid instruction reference/);
    assert.equal(agent.commands.length, 0);
});

// New threads of the process are added to ContextIds with Breakpoints.change.
test("updateInstructionScopes follows the threads of the process", async () => {
    const agent = fakeAgent();
    const threads = ["thread1"];
    const manager = new BreakpointManager(agent.service, fakeHost(threads));
    await manager.setInstructionBreakpoints([{ instructionReference: instructionReference("thread1", 0x1000n) }]);
    await manager.updateInstructionScopes();
    assert.equal(agent.commands.length, 1);

    threads.push("thread3");
    await manager.updateInstructionScopes();
    assert.equal(agent.commands.length, 2);
    const [command, props] = agent.commands[1] as [string, BreakpointProperties];
    assert.equal(command, "change");
    assert.deepEqual(props.ContextIds, ["proc", "thread1", "thread3"]);
});
