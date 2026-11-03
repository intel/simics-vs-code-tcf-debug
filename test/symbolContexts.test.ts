import assert from "node:assert/strict";
import { test } from "node:test";
import { DebugProtocol } from "@vscode/debugprotocol";
import { TcfChannel } from "../src/tcf/channel";
import { RunControlContext } from "../src/tcf/services/runControl";
import { TcfDebugSession } from "../src/tcfDebugSession";

test("symbol context suggestions query the agent for stateful cores", async () => {
    const session = new TcfDebugSession();
    const state = session as unknown as {
        channel: TcfChannel;
        contexts: Map<string, RunControlContext>;
        contextOrder: string[];
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

    let sequence = 0;
    function listContexts(): Promise<DebugProtocol.Response> {
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
                command: "getSymbolContexts",
            } as DebugProtocol.Request);
        });
    }

    assert.deepEqual((await listContexts()).body, [{ id: "core-0", name: "board.cpu0" }]);
    assert.deepEqual(commands, [["ContextQuery", "query", "HasState=true"]]);
    state.channel = { hasService: () => false } as unknown as TcfChannel;
    assert.deepEqual((await listContexts()).body, [{ id: "core-0", name: "board.cpu0" }]);
    state.contexts.delete("core-0");
    assert.deepEqual((await listContexts()).body, []);
});
