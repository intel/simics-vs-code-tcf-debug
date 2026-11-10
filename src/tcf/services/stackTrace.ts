import { TcfChannel, TcfError, formatTcfError } from "@/tcf/channel";
import { CodeArea } from "./lineNumbers";

/** Stack frame context properties, see TCF Services -> Stack Trace. */
export interface StackFrameContext {
    ID: string;
    ParentID?: string;
    ProcessID?: string;
    Name?: string;
    TopFrame?: boolean;
    Index?: number;
    Walk?: boolean;
    FP?: bigint | number;
    RP?: bigint | number;
    IP?: bigint | number;
    /** Source location, typically only set for inlined frames. */
    CodeArea?: CodeArea;
    FuncID?: string;
    Inlined?: number;
    [key: string]: unknown;
}

export class StackTraceService {
    static readonly NAME = "StackTrace";

    constructor(private readonly channel: TcfChannel) {}

    /** Returns the frame IDs of a suspended thread, bottom (oldest) frame first. */
    async getChildren(parentId: string): Promise<string[]> {
        const [ids] = await this.channel.command(StackTraceService.NAME, "getChildren", parentId);
        return Array.isArray(ids) ? (ids as string[]) : [];
    }

    /**
     * Returns the frame IDs with index start..end (inclusive), top (current)
     * frame first. Rejects with an unsupported TcfError for older agents.
     */
    async getChildrenRange(parentId: string, start: number, end: number): Promise<string[]> {
        const [ids] = await this.channel.command(StackTraceService.NAME, "getChildrenRange", parentId, start, end);
        return Array.isArray(ids) ? (ids as string[]) : [];
    }

    async getContext(ids: string[]): Promise<(StackFrameContext | null)[]> {
        // Unlike most commands the error report comes after the data.
        const [frames, err] = await this.channel.sendCommand(StackTraceService.NAME, "getContext", [ids]);
        if (err !== null && err !== undefined) {
            throw new TcfError(`StackTrace.getContext: ${formatTcfError(err)}`, undefined, err);
        }
        return Array.isArray(frames) ? (frames as (StackFrameContext | null)[]) : [];
    }
}
