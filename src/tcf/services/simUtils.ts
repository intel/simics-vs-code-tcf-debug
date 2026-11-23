import { TcfChannel } from "@/tcf/channel";

/*
 * The Simics SimUtils service, see SimUtils-service.md in the Simics TCF
 * agent. It is internal to Simics; commands may differ between releases, so
 * check getCommands before relying on one. Only the snapshot commands are
 * wrapped here.
 */

/** The parts of a channel the service uses. */
export type SimUtilsChannel = Pick<TcfChannel, "command" | "onEvent">;

export class SimUtilsService {
    static readonly NAME = "SimUtils";
    static readonly SNAPSHOT_COMMANDS: readonly string[] = [
        "getSnapshotIDs",
        "takeSnapshot",
        "restoreSnapshot",
        "deleteSnapshot",
    ];

    constructor(private readonly channel: SimUtilsChannel) {}

    /** The names of all commands the service supports. */
    async getCommands(): Promise<string[]> {
        const [names] = await this.cmd("getCommands");
        return stringList(names);
    }

    async getSnapshotIDs(): Promise<string[]> {
        const [ids] = await this.cmd("getSnapshotIDs");
        return stringList(ids);
    }

    async takeSnapshot(id: string): Promise<void> {
        await this.cmd("takeSnapshot", id);
    }

    async restoreSnapshot(id: string): Promise<void> {
        await this.cmd("restoreSnapshot", id);
    }

    async deleteSnapshot(id: string): Promise<void> {
        await this.cmd("deleteSnapshot", id);
    }

    /** Sent when a snapshot is taken or deleted, by any client. Returns a function that removes the listener. */
    onSnapshotsChanged(listener: () => void): () => void {
        return this.channel.onEvent(SimUtilsService.NAME, "snapshotsChanged", () => listener());
    }

    private cmd(command: string, ...args: unknown[]): Promise<unknown[]> {
        return this.channel.command(SimUtilsService.NAME, command, ...args);
    }
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
