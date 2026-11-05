import assert from "node:assert/strict";
import { test } from "node:test";
import { DebugProtocol } from "@vscode/debugprotocol";
import { TcfChannel } from "../src/tcf/channel";
import { RunControlContext } from "../src/tcf/services/runControl";
import { TcfDebugSession } from "../src/tcfDebugSession";
import { symbolFileBreakpointContext } from "../src/symbolFiles";

test("symbol file breakpoints resolve their own context, not the selected thread", () => {
    const contexts = [
        { id: "core-0", name: "board.cpu0" },
        { id: "core-1", name: "board.cpu1" },
    ];
    assert.equal(symbolFileBreakpointContext({ context: "core-1" }, contexts), "core-1");
    assert.equal(symbolFileBreakpointContext({ context: "board.cpu0" }, contexts), "core-0");
    assert.equal(
        symbolFileBreakpointContext({ context: "core-0" }, [...contexts, { id: "other", name: "core-0" }]),
        "core-0",
    );
    assert.throws(() => symbolFileBreakpointContext({}, contexts), /no context/);
    assert.throws(() => symbolFileBreakpointContext({ context: "missing" }, contexts), /not available/);
    assert.throws(
        () =>
            symbolFileBreakpointContext({ context: "board.cpu0" }, [...contexts, { id: "other", name: "board.cpu0" }]),
        /ambiguous/,
    );
});

test("symbol context suggestions query the agent for stateful cores", async () => {
    const session = new TcfDebugSession();
    const state = session as unknown as {
        channel: TcfChannel;
        contexts: Map<string, RunControlContext>;
        contextOrder: string[];
        threadIdByCtx: Map<string, number>;
    };
    const commands: unknown[][] = [];
    state.channel = {
        hasService: (name: string) => name === "ContextQuery",
        command: async (...args: unknown[]) => {
            commands.push(args);
            return [["core-0"]];
        },
    } as unknown as TcfChannel;
    state.contexts.set("board", { ID: "board", Name: "board", IsContainer: true });
    state.contexts.set("core-0", { ID: "core-0", ParentID: "board", Name: "cpu0", HasState: true });
    state.contextOrder.push("board", "core-0");
    state.threadIdByCtx.set("core-0", 7);

    let sequence = 0;
    function listContexts(command = "getSymbolContexts", args?: unknown): Promise<DebugProtocol.Response> {
        return new Promise((resolve) => {
            const next = ++sequence;
            const listener = session.onDidSendMessage((message) => {
                const response = message as DebugProtocol.Response;
                if (response.type === "response" && response.request_seq === next) {
                    listener.dispose();
                    resolve(response);
                }
            });
            session.handleMessage({
                seq: next,
                type: "request",
                command,
                arguments: args,
            } as DebugProtocol.Request);
        });
    }

    assert.deepEqual((await listContexts()).body, [{ id: "core-0", name: "board.cpu0" }]);
    assert.deepEqual(commands, [["ContextQuery", "query", "HasState=true"]]);
    assert.deepEqual((await listContexts("getFunctionBreakpointContexts")).body, [
        { id: "core-0", name: "board.cpu0", threadId: 7 },
    ]);
    const symbolFileContexts = (await listContexts("getFunctionBreakpointContexts", { includeContainers: true })).body;
    assert.deepEqual(symbolFileContexts, [
        { id: "board", name: "board" },
        { id: "core-0", name: "board.cpu0", threadId: 7 },
    ]);
    assert.equal(Object.hasOwn(symbolFileContexts[0], "threadId"), false);
    assert.equal(symbolFileBreakpointContext({ context: "board" }, symbolFileContexts), "board");
    state.channel = { hasService: () => false } as unknown as TcfChannel;
    assert.deepEqual((await listContexts()).body, [{ id: "core-0", name: "board.cpu0" }]);
    assert.deepEqual((await listContexts("getFunctionBreakpointContexts")).body, [
        { id: "core-0", name: "board.cpu0", threadId: 7 },
    ]);
    state.threadIdByCtx.delete("core-0");
    assert.deepEqual((await listContexts("getFunctionBreakpointContexts")).body, [
        { id: "core-0", name: "board.cpu0" },
    ]);
    state.contexts.delete("core-0");
    assert.deepEqual((await listContexts()).body, []);
});
