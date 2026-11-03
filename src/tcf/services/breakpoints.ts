import { TcfChannel } from "../channel";

/** Breakpoint properties, see TCF Services -> Breakpoints -> set. */
export interface BreakpointProperties {
    ID: string;
    Enabled?: boolean;
    BreakpointType?: "Software" | "Hardware" | "Auto";
    ContextIds?: string[];
    Location?: string;
    /** Bit set of AccessMode values. */
    AccessMode?: number;
    Size?: number;
    File?: string;
    Line?: number;
    Column?: number;
    Condition?: string;
    IgnoreCount?: number;
    Temporary?: boolean;
    [key: string]: unknown;
}

export const enum AccessMode {
    Read = 0x01,
    Write = 0x02,
    Execute = 0x04,
    Change = 0x08,
}

export interface BreakpointInstanceStatus {
    LocationContext?: string;
    Error?: string;
    Address?: bigint | number;
    Size?: number;
    HitCount?: number;
    BreakpointType?: string;
    ConditionError?: string;
    [key: string]: unknown;
}

export interface BreakpointStatus {
    Instances?: BreakpointInstanceStatus[];
    Error?: string;
    File?: string;
    Line?: number;
    Column?: number;
    [key: string]: unknown;
}

export interface BreakpointCapabilities {
    Location?: boolean;
    Condition?: boolean;
    FileLine?: boolean;
    IgnoreCount?: boolean;
    /** Bit set of supported AccessMode values. */
    AccessMode?: number;
    ContextIds?: boolean;
    [key: string]: unknown;
}

export interface BreakpointsListener {
    status?(id: string, status: BreakpointStatus): void;
    contextRemoved?(ids: string[]): void;
}

export class BreakpointsService {
    static readonly NAME = "Breakpoints";

    constructor(private readonly channel: TcfChannel) {}

    async add(bp: BreakpointProperties): Promise<void> {
        await this.channel.command(BreakpointsService.NAME, "add", bp);
    }

    /** Replaces all properties of a breakpoint. */
    async change(bp: BreakpointProperties): Promise<void> {
        await this.channel.command(BreakpointsService.NAME, "change", bp);
    }

    async remove(ids: string[]): Promise<void> {
        await this.channel.command(BreakpointsService.NAME, "remove", ids);
    }

    async getStatus(id: string): Promise<BreakpointStatus> {
        const [status] = await this.channel.command(BreakpointsService.NAME, "getStatus", id);
        return (status ?? {}) as BreakpointStatus;
    }

    /** Returns the capabilities for a context, or the global ones for an empty context ID. */
    async getCapabilities(contextId: string): Promise<BreakpointCapabilities> {
        const [caps] = await this.channel.command(BreakpointsService.NAME, "getCapabilities", contextId);
        return (caps ?? {}) as BreakpointCapabilities;
    }

    addListener(l: BreakpointsListener): void {
        this.channel.onEvent(BreakpointsService.NAME, "status", (a) =>
            l.status?.(a[0] as string, (a[1] ?? {}) as BreakpointStatus),
        );
        this.channel.onEvent(BreakpointsService.NAME, "contextRemoved", (a) =>
            l.contextRemoved?.(Array.isArray(a[0]) ? (a[0] as string[]) : []),
        );
    }
}
