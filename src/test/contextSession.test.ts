import { test } from "node:test";
import assert from "node:assert/strict";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DebugSession } from "@vscode/debugadapter";
import { ContextGroup, TcfDebugSession } from "@/tcfDebugSession";
import { TcfContextSession } from "@/contextSession";
import type { RunControlContext, RunControlListener, RunControlState } from "@/tcf/services/runControl";

/** Sends requests to an adapter and records what it sends back. */
function client(session: DebugSession) {
    const events: DebugProtocol.Event[] = [];
    const pending = new Map<number, (r: DebugProtocol.Response) => void>();
    let seq = 0;
    session.onDidSendMessage((value) => {
        const message = value as DebugProtocol.ProtocolMessage;
        // Context changes refresh the Path Map view, which is not tested here.
        if (message.type === "event" && (message as DebugProtocol.Event).event !== "pathMapChanged") {
            events.push(message as DebugProtocol.Event);
        } else if (message.type === "response") {
            const r = message as DebugProtocol.Response;
            pending.get(r.request_seq)?.(r);
            pending.delete(r.request_seq);
        }
    });
    const request = (command: string, args: object = {}) =>
        new Promise<DebugProtocol.Response>((resolve) => {
            const next = ++seq;
            pending.set(next, resolve);
            session.handleMessage({ seq: next, type: "request", command, arguments: args } as DebugProtocol.Request);
        });
    /** The events received since the last call. */
    const take = () => events.splice(0);
    return { request, take };
}

function ctx(ID: string, ParentID?: string, HasState = false): RunControlContext {
    return { ID, Name: ID, ...(ParentID && { ParentID }), ...(HasState && { HasState }) };
}

/**
 * A root session with a fake RunControl service:
 *   board (cpu0, cpu1), linux (p1 (t1, t2)), idle
 */
async function rootSession(withHost = true, states: Record<string, RunControlState> = {}) {
    const contexts = [
        ctx("board"),
        ctx("cpu0", "board", true),
        ctx("cpu1", "board", true),
        ctx("linux"),
        ctx("p1", "linux"),
        ctx("t1", "p1", true),
        ctx("t2", "p1", true),
        ctx("idle", undefined, true),
    ];
    const listeners: RunControlListener[] = [];
    const rc = {
        getChildren: async (id: string | null) =>
            contexts.filter((c) => c.ParentID === (id ?? undefined)).map((c) => c.ID),
        getContext: async (id: string) => contexts.find((c) => c.ID === id)!,
        getState: async (id: string) => states[id] ?? { suspended: false },
        addListener: (l: RunControlListener) => listeners.push(l),
    };
    const session = new TcfDebugSession();
    const added: ContextGroup[] = [];
    const renamed: [string, string][] = [];
    const removed: string[] = [];
    const host = {
        added,
        renamed,
        removed,
        groupAdded: (g: ContextGroup) => added.push(g),
        groupRenamed: (key: string, name: string) => renamed.push([key, name]),
        groupRemoved: (key: string) => removed.push(key),
    };
    if (withHost) {
        session.setContextSessionHost(host);
    }
    const internal = session as unknown as {
        addRunControlListener(rc: unknown): void;
        discoverContexts(): Promise<void>;
    };
    Object.assign(session, { runControl: rc });
    internal.addRunControlListener(rc);
    await internal.discoverContexts();
    const root = client(session);
    await root.request("configurationDone");
    // reportInitialState queries the states after the response.
    await new Promise((r) => setImmediate(r));
    const keyOf = (name: string) => [...host.added].reverse().find((g) => g.name === name)!.key;
    /** Starts the child session of a group, like VS Code does. */
    const child = async (name: string) => {
        const adapter = new TcfContextSession((sink) => session.connectContextSession(keyOf(name), sink));
        const c = client(adapter);
        const init = await c.request("initialize", { adapterID: "simics-target-debug", pathFormat: "path" });
        assert.equal(init.body.supportsInstructionBreakpoints, true);
        await c.request("attach");
        await c.request("configurationDone");
        return { adapter, ...c };
    };
    const threadNames = async (c: { request: typeof root.request }) =>
        ((await c.request("threads")).body.threads as DebugProtocol.Thread[]).map((t) => t.name);
    return { session, root, host, listener: listeners[0], keyOf, child, threadNames };
}

// Each container with two threads or more below it gets a group, parents
// first. A session with a single thread next to child sessions would hide
// it, so the top-level thread idle gets a session of its own. Sessions of
// threads come first.
test("container contexts become child sessions with their threads", async () => {
    const { root, host, child, keyOf, threadNames } = await rootSession();
    assert.deepEqual(
        host.added.map((g) => [g.name, g.parentKey]),
        [
            ["idle", undefined],
            ["board", undefined],
            ["linux", undefined],
            ["p1", keyOf("linux")],
        ],
    );
    assert.deepEqual(await threadNames(root), []);
    assert.deepEqual(await threadNames(await child("idle")), ["idle"]);
    const board = await child("board");
    assert.deepEqual(await threadNames(board), ["cpu0", "cpu1"]);
    assert.deepEqual(await threadNames(await child("linux")), []);
    assert.deepEqual(await threadNames(await child("p1")), ["t1", "t2"]);
    const initialized = board.take().map((e) => e.event);
    assert.deepEqual(initialized, ["initialized"]);
});

// Each session gets the stop of its own threads. Only the session of the
// thread that caused it may take the focus.
test("stops and resumes are reported to the session of each thread", async () => {
    const { root, listener, child } = await rootSession();
    const board = await child("board");
    const p1 = await child("p1");
    const idle = await child("idle");
    root.take();
    board.take();
    p1.take();
    idle.take();
    listener.containerSuspended!("t2", 0x1000, "Breakpoint", undefined, ["cpu0", "cpu1", "t1", "t2", "idle"]);
    const [p1Stop] = p1.take() as DebugProtocol.StoppedEvent[];
    assert.equal(p1Stop.body.allThreadsStopped, true);
    assert.equal(p1Stop.body.reason, "breakpoint");
    assert.equal(p1Stop.body.description, "Breakpoint");
    assert.equal(p1Stop.body.preserveFocusHint, undefined);
    const [boardStop, ...more] = board.take() as DebugProtocol.StoppedEvent[];
    assert.deepEqual(more, []);
    assert.equal(boardStop.body.allThreadsStopped, true);
    assert.equal(boardStop.body.preserveFocusHint, true);
    // The reason is the trigger's, other threads are just paused.
    assert.equal(boardStop.body.reason, "pause");
    assert.equal(boardStop.body.description, "Paused");
    const [idleStop] = idle.take() as DebugProtocol.StoppedEvent[];
    assert.equal(idleStop.event, "stopped");
    assert.equal(idleStop.body.preserveFocusHint, true);
    // The root session has no threads of its own.
    const [rootStop] = root.take() as DebugProtocol.StoppedEvent[];
    assert.equal(rootStop.body.threadId, undefined);

    listener.contextResumed!("cpu0");
    const [resumed] = board.take() as DebugProtocol.ContinuedEvent[];
    assert.equal(resumed.event, "continued");
    assert.equal(resumed.body.allThreadsContinued, false);
    listener.containerResumed!(["t1", "t2"]);
    const continued = p1.take() as DebugProtocol.ContinuedEvent[];
    assert.deepEqual(
        continued.map((e) => e.body.allThreadsContinued),
        [true],
    );
    assert.deepEqual(
        root.take().map((e) => e.event),
        ["continued"],
    );
});

// A child session that starts while its threads are suspended reports them.
test("a new child session reports its suspended threads", async () => {
    const { listener, child } = await rootSession();
    listener.containerSuspended!("t1", 0x1000, "Suspended", undefined, ["cpu0", "cpu1", "t1", "t2", "idle"]);
    const p1 = await child("p1");
    const stops = p1.take().filter((e) => e.event === "stopped") as DebugProtocol.StoppedEvent[];
    assert.equal(stops.length, 1);
    assert.equal(stops[0].body.allThreadsStopped, true);
});

// Requests other than the session's own are handled by the root adapter,
// which owns the thread, frame and variable IDs.
test("child sessions pass requests on and leave breakpoints to the root", async () => {
    const { session, child } = await rootSession();
    const p1 = await child("p1");
    const threads = (await p1.request("threads")).body.threads as DebugProtocol.Thread[];
    const context = await p1.request("tcfThreadContext", { threadId: threads[0].id });
    assert.equal(context.success, true);
    assert.equal(context.command, "tcfThreadContext");
    assert.deepEqual(context.body, { contextId: "t1", name: "linux.p1.t1" });
    const failed = await p1.request("tcfThreadContext", { threadId: 999 });
    assert.equal(failed.success, false);
    const bps = await p1.request("setBreakpoints", {
        source: { path: "/src/a.c" },
        breakpoints: [{ line: 3 }],
    });
    assert.deepEqual(bps.body, { breakpoints: [] });
    assert.equal((session as unknown as { forwardedRequests: Map<number, unknown> }).forwardedRequests.size, 0);
});

// Breakpoint IDs in stopped events are the root session's.
test("child sessions leave out hit breakpoint IDs", async () => {
    const { child } = await rootSession();
    const p1 = await child("p1");
    p1.take();
    p1.adapter.sendEvent({
        seq: 0,
        type: "event",
        event: "stopped",
        body: { reason: "breakpoint", threadId: 1, hitBreakpointIds: [4] },
    } as DebugProtocol.StoppedEvent);
    const [stop] = p1.take() as DebugProtocol.StoppedEvent[];
    assert.deepEqual(stop.body, { reason: "breakpoint", threadId: 1 });
});

// Processes come and go with OS awareness.
test("groups follow added, changed and removed contexts", async () => {
    const { root, host, listener, child, keyOf, threadNames } = await rootSession();
    const p1 = await child("p1");
    // With more top-level threads, idle is back in the root session.
    listener.contextAdded!([ctx("spare1", undefined, true), ctx("spare2", undefined, true)]);
    assert.deepEqual(host.removed, [keyOf("idle")]);
    assert.deepEqual(await threadNames(root), ["idle", "spare1", "spare2"]);
    root.take();

    // Processes with one thread have no session of their own.
    const linux = await child("linux");
    linux.take();
    listener.contextAdded!([
        ctx("p2", "linux"),
        ctx("t3", "p2", true),
        ctx("p3", "linux"),
        ctx("t6", "p3", true),
        ctx("p4", "linux"),
        ctx("t7", "p4", true),
    ]);
    assert.equal(host.added.length, 4);
    assert.deepEqual(await threadNames(linux), ["p2.t3", "p3.t6", "p4.t7"]);
    linux.take();
    // With a second thread it gets one, and the thread moves there.
    listener.contextAdded!([ctx("t5", "p2", true)]);
    const p2 = host.added.at(-1)!;
    assert.deepEqual([p2.name, p2.parentKey], ["p2", keyOf("linux")]);
    assert.deepEqual(
        linux.take().map((e) => (e as DebugProtocol.ThreadEvent).body.reason),
        ["exited"],
    );
    assert.deepEqual(await threadNames(linux), ["p3.t6", "p4.t7"]);
    assert.deepEqual(await threadNames(await child("p2")), ["t3", "t5"]);

    listener.contextChanged!([{ ...ctx("p2", "linux"), Name: "bash" }]);
    assert.deepEqual(host.renamed, [[p2.key, "bash"]]);

    p1.take();
    listener.contextRemoved!(["t1", "t2", "p1"]);
    assert.deepEqual(
        p1.take().map((e) => e.event),
        ["thread", "thread", "terminated"],
    );
    assert.deepEqual(host.removed.at(-1), keyOf("p1"));
    assert.equal((await p1.request("disconnect")).success, true);
    assert.deepEqual(root.take(), []);

    // A thread that gets children becomes a container, and moves to its own session.
    listener.contextAdded!([ctx("t4", "idle", true)]);
    const idle = host.added.at(-1)!;
    assert.deepEqual([idle.name, idle.parentKey], ["idle", undefined]);
    assert.deepEqual(
        (root.take() as DebugProtocol.ThreadEvent[]).map((e) => e.body.reason),
        ["exited"],
    );
    assert.deepEqual(await threadNames(root), ["spare1", "spare2"]);
    assert.deepEqual(await threadNames(await child("idle")), ["idle", "t4"]);

    // Back in the root session, a suspended thread is reported stopped there.
    // It caused the last stop, so it gets the focus again.
    listener.contextSuspended!("idle", 0x2000, "Suspended", undefined);
    root.take();
    listener.contextRemoved!(["t4"]);
    assert.deepEqual(host.removed.at(-1), idle.key);
    const moved = root.take().filter((e) => e.event === "thread" || e.event === "stopped");
    assert.deepEqual(
        moved.map((e) => e.event),
        ["thread", "stopped"],
    );
    assert.equal((moved[1] as DebugProtocol.StoppedEvent).body.preserveFocusHint, undefined);
    assert.deepEqual(await threadNames(root), ["idle", "spare1", "spare2"]);
});

// A top-level CPU next to an OS awareness tracker would be hidden in the
// root session, as its only thread, so it gets a session of its own, named
// by the contexts down to it.
test("a lone thread next to child sessions gets a session of its own", async () => {
    const { root, host, listener, child, threadNames } = await rootSession();
    listener.contextRemoved!(["idle", "cpu1"]);
    // board has a single CPU, so it has no session; cpu0 would be the only
    // thread of the root session.
    const lone = host.added.at(-1)!;
    assert.deepEqual([lone.name, lone.parentKey], ["board.cpu0", undefined]);
    assert.deepEqual(await threadNames(root), []);
    assert.deepEqual(await threadNames(await child("board.cpu0")), ["cpu0"]);
});

// The connection is the root session's: when it ends, so do the children.
test("disconnecting the root session ends the child sessions", async () => {
    const { root, host, child } = await rootSession();
    const board = await child("board");
    board.take();
    await root.request("disconnect");
    assert.deepEqual(
        board.take().map((e) => e.event),
        ["terminated"],
    );
    assert.equal(host.removed.length, 4);
});

// Without a host all threads are in the root session, with full names.
test("without a host the threads are a flat list", async () => {
    const { root, listener, threadNames } = await rootSession(false);
    assert.deepEqual(await threadNames(root), ["board.cpu0", "board.cpu1", "linux.p1.t1", "linux.p1.t2", "idle"]);
    root.take();
    listener.containerSuspended!("t2", 0x1000, "Breakpoint", undefined, ["cpu0", "cpu1", "t1", "t2", "idle"]);
    const stops = root.take() as DebugProtocol.StoppedEvent[];
    assert.equal(stops.length, 1);
    assert.equal(stops[0].body.allThreadsStopped, true);
    assert.equal(stops[0].body.preserveFocusHint, undefined);
    listener.contextAdded!([ctx("t5", "p1", true)]);
    assert.deepEqual(
        (root.take().filter((e) => e.event === "thread") as DebugProtocol.ThreadEvent[]).map((e) => e.body.reason),
        ["started"],
    );
});

// A process with a single thread is shown as a thread of the session above,
// named by the contexts below that session. Repeated names are shown once.
test("containers with a single thread are shown as a thread", async () => {
    const { root, host, listener, child, threadNames } = await rootSession();
    listener.contextAdded!([
        ctx("init", "linux"),
        { ...ctx("init-thread", "init", true), Name: "init" },
        ctx("p3", "linux"),
        ctx("worker", "p3", true),
        ctx("solo"),
        ctx("cpu", "solo", true),
    ]);
    // idle had a session of its own, as the only thread of the root session.
    assert.deepEqual(
        host.added.map((g) => g.name),
        ["idle", "board", "linux", "p1"],
    );
    assert.deepEqual(host.removed, [host.added[0].key]);
    assert.deepEqual(await threadNames(await child("linux")), ["init", "p3.worker"]);
    assert.deepEqual(await threadNames(root), ["idle", "solo.cpu"]);
});

// Only the thread that caused a stop shows its reason. With a step, the
// other threads are paused, not stepped.
test("only the trigger thread shows the stop reason", async () => {
    const { listener, child } = await rootSession();
    const board = await child("board");
    const p1 = await child("p1");
    const idle = await child("idle");
    board.take();
    p1.take();
    idle.take();
    listener.containerSuspended!("t1", 0x1000, "Step", undefined, ["t1", "t2", "cpu0", "idle"]);
    const [p1Stop, ...p1More] = p1.take() as DebugProtocol.StoppedEvent[];
    assert.deepEqual(p1More, []);
    assert.deepEqual(
        [p1Stop.body.description, p1Stop.body.allThreadsStopped, p1Stop.body.preserveFocusHint],
        ["Step", true, undefined],
    );
    // cpu1 runs, so cpu0 gets an event of its own.
    const [boardStop, ...boardMore] = board.take() as DebugProtocol.StoppedEvent[];
    assert.deepEqual(boardMore, []);
    assert.deepEqual(
        [boardStop.body.reason, boardStop.body.description, boardStop.body.allThreadsStopped],
        ["pause", "Paused", false],
    );
    const [idleStop] = idle.take() as DebugProtocol.StoppedEvent[];
    assert.equal(idleStop.body.description, "Paused");
});

// VS Code shows a session without threads as running: it is reported
// stopped, without a thread, while all threads below it are suspended.
test("sessions without threads follow the threads below them", async () => {
    const { listener, child } = await rootSession();
    const linux = await child("linux");
    linux.take();
    listener.containerSuspended!("t1", 0x1000, "Breakpoint", undefined, ["t1"]);
    assert.deepEqual(linux.take(), []);
    listener.containerSuspended!("cpu0", 0x1000, "Suspended", undefined, ["cpu0", "cpu1", "t2", "idle"]);
    const [stop, ...more] = linux.take() as DebugProtocol.StoppedEvent[];
    assert.deepEqual(more, []);
    assert.equal(stop.event, "stopped");
    assert.deepEqual(stop.body, {
        reason: "pause",
        description: "Paused",
        preserveFocusHint: true,
        allThreadsStopped: false,
    });
    listener.contextResumed!("cpu0");
    assert.deepEqual(linux.take(), []);
    listener.contextResumed!("t2");
    const [resumed] = linux.take() as DebugProtocol.ContinuedEvent[];
    assert.equal(resumed.event, "continued");
    assert.equal(resumed.body.allThreadsContinued, true);
    // A session that starts while all is suspended is stopped at once.
    const late = await rootSession();
    late.listener.containerSuspended!("t1", 0x1000, "Suspended", undefined, ["t1", "t2"]);
    const lateLinux = await late.child("linux");
    assert.deepEqual(
        lateLinux.take().map((e) => e.event),
        ["initialized", "stopped"],
    );
});

// Child sessions start after the stop is reported. Only the session of the
// thread that caused it takes the focus.
test("child sessions that start later leave the focus to the trigger", async () => {
    const { listener, child } = await rootSession();
    listener.containerSuspended!("t2", 0x1000, "Breakpoint", undefined, ["cpu0", "cpu1", "t1", "t2", "idle"]);
    const board = await child("board");
    const [boardStop] = board.take().filter((e) => e.event === "stopped") as DebugProtocol.StoppedEvent[];
    assert.equal(boardStop.body.preserveFocusHint, true);
    assert.equal(boardStop.body.description, "Paused");
    const p1 = await child("p1");
    const [p1Stop] = p1.take().filter((e) => e.event === "stopped") as DebugProtocol.StoppedEvent[];
    assert.equal(p1Stop.body.preserveFocusHint, undefined);
    assert.equal(p1Stop.body.description, "Breakpoint");
});

// When attaching, getState gives each thread's own reason. A thread with a
// reason other than Suspended is reported first and gets the focus; the
// others with a reason of their own are reported too.
test("the initial state shows the reasons of the threads", async () => {
    const suspended = (reason: string): RunControlState => ({ suspended: true, reason });
    const { root, child } = await rootSession(true, {
        cpu0: suspended("Suspended"),
        cpu1: suspended("Suspended"),
        t1: suspended("Active"),
        t2: suspended("Active"),
        idle: suspended("Suspended"),
    });
    const [rootStop] = root.take().filter((e) => e.event === "stopped") as DebugProtocol.StoppedEvent[];
    assert.equal(rootStop.body.description, "Paused");
    assert.equal(rootStop.body.preserveFocusHint, true);
    const p1 = await child("p1");
    const stops = p1.take().filter((e) => e.event === "stopped") as DebugProtocol.StoppedEvent[];
    assert.deepEqual(
        stops.map((e) => [e.body.description, e.body.allThreadsStopped, e.body.preserveFocusHint]),
        [
            ["Active", true, undefined],
            ["Active", false, true],
        ],
    );
});
