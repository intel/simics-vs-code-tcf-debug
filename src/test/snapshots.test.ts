import { test } from "node:test";
import assert from "node:assert/strict";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { NO_SIMUTILS, NO_SNAPSHOT_COMMANDS, Snapshots, freeSnapshotName, snapshotNameProblem } from "@/snapshots";
import { TcfDebugSession } from "@/tcfDebugSession";
import { TcfError } from "@/tcf/channel";
import { SimUtilsChannel, SimUtilsService } from "@/tcf/services/simUtils";

type Handler = (...args: unknown[]) => unknown[];

/** A SimUtils agent; commands without a handler get an N reply. */
function fakeSimUtils(handlers: Record<string, Handler>) {
    const sent: { command: string; args: unknown[] }[] = [];
    const channel: SimUtilsChannel = {
        command: async (service, command, ...args) => {
            sent.push({ command, args });
            const handler = handlers[command];
            if (!handler) {
                throw new TcfError(`${service}.${command}: unknown command`, undefined, undefined, true);
            }
            return handler(...args);
        },
        onEvent: () => () => {},
    };
    return { service: new SimUtilsService(channel), sent };
}

const ALL_COMMANDS: Handler = () => [["getCommands", ...SimUtilsService.SNAPSHOT_COMMANDS]];

test("freeSnapshotName picks names like the Simics take-snapshot command", () => {
    assert.equal(freeSnapshotName([]), "snapshot");
    assert.equal(freeSnapshotName(["snapshot", "snapshot1"]), "snapshot2");
    assert.equal(freeSnapshotName(["snapshot1", "boot"]), "snapshot");
});

test("snapshotNameProblem rejects empty, padded and taken names", () => {
    assert.ok(snapshotNameProblem("", []));
    assert.ok(snapshotNameProblem("   ", []));
    assert.ok(snapshotNameProblem(" boot", []));
    assert.match(snapshotNameProblem("boot", ["boot"]) ?? "", /already/);
    assert.equal(snapshotNameProblem("boot", ["boot2"]), undefined);
});

test("Snapshots: unsupported without SimUtils or its snapshot commands", async () => {
    assert.deepEqual(await new Snapshots(undefined).list(), { supported: false, reason: NO_SIMUTILS, snapshots: [] });
    await assert.rejects(new Snapshots(undefined).take("a"), { message: NO_SIMUTILS });

    const old = fakeSimUtils({ getCommands: () => [["getCheckpointInfo", "listCheckpoints"]] });
    const snapshots = new Snapshots(old.service);
    assert.deepEqual(await snapshots.list(), { supported: false, reason: NO_SNAPSHOT_COMMANDS, snapshots: [] });
    await assert.rejects(snapshots.restore("a"), { message: NO_SNAPSHOT_COMMANDS });
    // The check is made once.
    assert.equal(old.sent.filter((s) => s.command === "getCommands").length, 1);
});

test("Snapshots: without getCommands, getSnapshotIDs decides", async () => {
    const works = fakeSimUtils({ getSnapshotIDs: () => [["a"]] });
    assert.deepEqual(await new Snapshots(works.service).list(), { supported: true, snapshots: ["a"] });
    const missing = fakeSimUtils({});
    assert.equal((await new Snapshots(missing.service).list()).reason, NO_SNAPSHOT_COMMANDS);
});

test("Snapshots: a lost connection is not taken as unsupported", async () => {
    let connected = false;
    const fake = fakeSimUtils({
        getCommands: (...args) => {
            if (!connected) {
                throw new Error("Not connected to a TCF agent");
            }
            return ALL_COMMANDS(...args);
        },
        getSnapshotIDs: () => [null],
    });
    const snapshots = new Snapshots(fake.service);
    await assert.rejects(snapshots.list(), /Not connected/);
    connected = true;
    assert.deepEqual(await snapshots.list(), { supported: true, snapshots: [] });
});

test("Snapshots: take names unnamed snapshots, restore and delete pass the name", async () => {
    const fake = fakeSimUtils({
        getCommands: ALL_COMMANDS,
        getSnapshotIDs: () => [["snapshot"]],
        takeSnapshot: () => [null],
        restoreSnapshot: () => [null],
        deleteSnapshot: () => [null],
    });
    const snapshots = new Snapshots(fake.service);
    assert.equal(await snapshots.take(), "snapshot1");
    assert.equal(await snapshots.take("boot"), "boot");
    await snapshots.restore("boot");
    await snapshots.delete("snapshot");
    assert.deepEqual(
        fake.sent.filter((s) => s.command !== "getCommands" && s.command !== "getSnapshotIDs"),
        [
            { command: "takeSnapshot", args: ["snapshot1"] },
            { command: "takeSnapshot", args: ["boot"] },
            { command: "restoreSnapshot", args: ["boot"] },
            { command: "deleteSnapshot", args: ["snapshot"] },
        ],
    );
});

test("Snapshots: unnamed takes at the same time get different names", async () => {
    const ids: string[] = [];
    const fake = fakeSimUtils({
        getCommands: ALL_COMMANDS,
        getSnapshotIDs: () => [[...ids]],
        takeSnapshot: (id) => {
            if (ids.includes(id as string)) {
                throw new TcfError(`SimUtils.takeSnapshot: Taking snapshot '${id}' failed.`, 0x10005);
            }
            ids.push(id as string);
            return [null];
        },
    });
    const snapshots = new Snapshots(fake.service);
    assert.deepEqual(await Promise.all([snapshots.take(), snapshots.take()]), ["snapshot", "snapshot1"]);
});

test("Snapshots: deleteAll deletes every snapshot, also when one is already gone", async () => {
    const ids = ["a", "b", "c"];
    const fake = fakeSimUtils({
        getCommands: ALL_COMMANDS,
        getSnapshotIDs: () => [[...ids]],
        deleteSnapshot: (id) => {
            if (id === "b") {
                // Deleted by another client after the list was read.
                throw new TcfError("SimUtils.deleteSnapshot: Deleting snapshot 'b' failed.", 0x10005, {
                    Code: 0x10005,
                    AltCode: 2,
                });
            }
            return [null];
        },
    });
    assert.deepEqual(await new Snapshots(fake.service).deleteAll(), ["a", "c"]);

    const failing = fakeSimUtils({
        getCommands: ALL_COMMANDS,
        getSnapshotIDs: () => [["a"]],
        deleteSnapshot: () => {
            throw new TcfError("SimUtils.deleteSnapshot: Internal error", 0x10005, { Code: 0x10005, AltCode: 5 });
        },
    });
    await assert.rejects(new Snapshots(failing.service).deleteAll(), /Internal error/);
});

test("TcfDebugSession: snapshot requests", { timeout: 5000 }, async () => {
    const session = new TcfDebugSession();
    let receive: ((response: DebugProtocol.Response) => void) | undefined;
    let seq = 0;
    session.onDidSendMessage((value) => {
        const message = value as DebugProtocol.ProtocolMessage;
        if (message.type === "response") {
            receive?.(message as DebugProtocol.Response);
        }
    });
    const request = (command: string, args: object = {}) =>
        new Promise<DebugProtocol.Response>((resolve) => {
            receive = resolve;
            const message: DebugProtocol.Request = { seq: ++seq, type: "request", command, arguments: args };
            session.handleMessage(message);
        });

    // Not attached yet: not supported, without a reason.
    assert.deepEqual((await request("getSnapshots")).body, { supported: false, snapshots: [] });

    const fake = fakeSimUtils({
        getCommands: ALL_COMMANDS,
        getSnapshotIDs: () => [["boot"]],
        takeSnapshot: (id) => {
            if (id === "boot") {
                throw new TcfError("SimUtils.takeSnapshot: Taking snapshot 'boot' failed.", 0x10005);
            }
            return [null];
        },
    });
    Object.assign(session, { snapshots: new Snapshots(fake.service) });
    assert.deepEqual((await request("getSnapshots")).body, { supported: true, snapshots: ["boot"] });
    assert.deepEqual((await request("takeSnapshot")).body, { name: "snapshot" });
    const failed = await request("takeSnapshot", { name: "boot" });
    assert.equal(failed.success, false);
    assert.match(failed.message ?? "", /Taking snapshot 'boot' failed/);
    assert.equal((await request("restoreSnapshot")).success, false);
});
