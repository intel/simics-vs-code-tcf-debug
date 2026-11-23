/*
 * Simics snapshots through the SimUtils service, and the custom DAP requests
 * and event through which the Snapshots view uses them. No vscode
 * dependency, the debug adapter owns the TCF connection.
 */

import { TcfError } from "./tcf/channel";
import { SimUtilsService } from "./tcf/services/simUtils";

export const enum SnapshotRequest {
    List = "getSnapshots",
    Take = "takeSnapshot",
    Restore = "restoreSnapshot",
    Delete = "deleteSnapshot",
    DeleteAll = "deleteAllSnapshots",
}

/** Sent after attaching, and when a snapshot is taken or deleted by any client. */
export const SNAPSHOTS_CHANGED_EVENT = "snapshotsChanged";

export interface SnapshotsResult {
    supported: boolean;
    /** Why snapshots cannot be used. Left out when not supported because the adapter is not attached (yet). */
    reason?: string;
    /** In the order the agent lists them. */
    snapshots: string[];
}

export interface TakeSnapshotArgs {
    /** Without a name, the adapter picks a free one. */
    name?: string;
}

export interface TakeSnapshotResult {
    name: string;
}

export interface SnapshotArgs {
    name: string;
}

export interface DeleteAllSnapshotsResult {
    /** The snapshots that were deleted. */
    deleted: string[];
}

/** AltCode of the agent's error report when the snapshot does not exist. */
const SNAPSHOT_NOT_FOUND = 2;

export const NO_SIMUTILS = "The TCF agent does not provide the Simics SimUtils service.";
export const NO_SNAPSHOT_COMMANDS = "The SimUtils service of the TCF agent has no snapshot commands.";

/**
 * A name that is not in `existing`, picked like the Simics take-snapshot
 * command does: "snapshot", "snapshot1", "snapshot2" and so on.
 */
export function freeSnapshotName(existing: Iterable<string>): string {
    const used = new Set(existing);
    for (let i = 0; ; i++) {
        const candidate = i ? `snapshot${i}` : "snapshot";
        if (!used.has(candidate)) {
            return candidate;
        }
    }
}

/** Why `name` cannot be used for a new snapshot, undefined if it can. */
export function snapshotNameProblem(name: string, existing: readonly string[]): string | undefined {
    if (name.trim().length === 0) {
        return "Enter a snapshot name.";
    }
    if (name !== name.trim()) {
        return "The name cannot start or end with white space.";
    }
    if (existing.includes(name)) {
        return `There is already a snapshot named "${name}".`;
    }
    return undefined;
}

/**
 * The snapshots of one agent. Whether the agent supports them is checked on
 * first use: the SimUtils service is internal to Simics, and older versions
 * have it without the snapshot commands.
 */
export class Snapshots {
    /** Resolves to why snapshots are not supported, or undefined if they are. */
    private support: Promise<string | undefined> | undefined;
    /** The last change, so that changes run one at a time and an unnamed take sees the snapshots of earlier ones. */
    private changes: Promise<unknown> = Promise.resolve();

    constructor(private readonly service: SimUtilsService | undefined) {}

    async list(): Promise<SnapshotsResult> {
        const reason = await this.unsupportedReason();
        if (reason !== undefined) {
            return { supported: false, reason, snapshots: [] };
        }
        return { supported: true, snapshots: await this.service!.getSnapshotIDs() };
    }

    /** Takes a snapshot and returns its name. */
    take(name?: string): Promise<string> {
        return this.change(async (service) => {
            const id = name ?? freeSnapshotName(await service.getSnapshotIDs());
            if (id.trim().length === 0) {
                throw new Error("Enter a snapshot name.");
            }
            await service.takeSnapshot(id);
            return id;
        });
    }

    restore(name: string): Promise<void> {
        return this.change((service) => service.restoreSnapshot(name));
    }

    delete(name: string): Promise<void> {
        return this.change((service) => service.deleteSnapshot(name));
    }

    /** Deletes every snapshot of the agent, and returns their names. */
    deleteAll(): Promise<string[]> {
        return this.change(async (service) => {
            const deleted: string[] = [];
            for (const id of await service.getSnapshotIDs()) {
                try {
                    await service.deleteSnapshot(id);
                    deleted.push(id);
                } catch (err) {
                    // Another client may have deleted it meanwhile.
                    if (!(err instanceof TcfError && altCode(err) === SNAPSHOT_NOT_FOUND)) {
                        throw err;
                    }
                }
            }
            return deleted;
        });
    }

    private change<T>(fn: (service: SimUtilsService) => Promise<T>): Promise<T> {
        const run = async () => fn(await this.requireService());
        const result = this.changes.then(run, run);
        this.changes = result.catch(() => undefined);
        return result;
    }

    private async requireService(): Promise<SimUtilsService> {
        const reason = await this.unsupportedReason();
        if (reason !== undefined) {
            throw new Error(reason);
        }
        return this.service!;
    }

    private unsupportedReason(): Promise<string | undefined> {
        if (!this.support) {
            const check = this.checkSupport();
            this.support = check;
            // Not a reply from the agent, such as a closed connection: check again next time.
            check.catch(() => {
                if (this.support === check) {
                    this.support = undefined;
                }
            });
        }
        return this.support;
    }

    private async checkSupport(): Promise<string | undefined> {
        const service = this.service;
        if (!service) {
            return NO_SIMUTILS;
        }
        let commands: string[];
        try {
            commands = await service.getCommands();
        } catch (err) {
            if (!(err instanceof TcfError)) {
                throw err;
            }
            // Without getCommands, try the command itself.
            try {
                await service.getSnapshotIDs();
                return undefined;
            } catch (e) {
                if (e instanceof TcfError) {
                    return NO_SNAPSHOT_COMMANDS;
                }
                throw e;
            }
        }
        return SimUtilsService.SNAPSHOT_COMMANDS.every((c) => commands.includes(c)) ? undefined : NO_SNAPSHOT_COMMANDS;
    }
}

function altCode(err: TcfError): unknown {
    return typeof err.data === "object" && err.data !== null ? (err.data as { AltCode?: unknown }).AltCode : undefined;
}
