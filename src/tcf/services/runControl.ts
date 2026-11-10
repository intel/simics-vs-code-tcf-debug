import { TcfChannel } from "@/tcf/channel";

/** RunControl context properties, see TCF Services -> Run Control. */
export interface RunControlContext {
    ID: string;
    ParentID?: string;
    ProcessID?: string;
    CreatorID?: string;
    Name?: string;
    IsContainer?: boolean;
    HasState?: boolean;
    CanSuspend?: boolean;
    CanResume?: number;
    CanCount?: number;
    CanTerminate?: boolean;
    RCGroup?: string;
    BPGroup?: string;
    SymbolsGroup?: string;
    CPUGroup?: string;
    [key: string]: unknown;
}

export interface RunControlState {
    suspended: boolean;
    pc?: bigint | number;
    reason?: string;
    data?: Record<string, unknown>;
}

/** Resume modes, see TCF Services -> Run Control -> resume. */
export const enum ResumeMode {
    Resume = 0,
    StepOver = 1,
    StepInto = 2,
    StepOverLine = 3,
    StepIntoLine = 4,
    StepOut = 5,
}

export interface RunControlListener {
    contextAdded?(contexts: RunControlContext[]): void;
    contextChanged?(contexts: RunControlContext[]): void;
    contextRemoved?(ids: string[]): void;
    contextSuspended?(
        id: string,
        pc: bigint | number | undefined,
        reason: string | undefined,
        data: Record<string, unknown> | undefined,
    ): void;
    contextResumed?(id: string): void;
    containerSuspended?(
        id: string,
        pc: bigint | number | undefined,
        reason: string | undefined,
        data: Record<string, unknown> | undefined,
        suspendedIds: string[],
    ): void;
    containerResumed?(ids: string[]): void;
    contextException?(id: string, message: string): void;
}

export class RunControlService {
    static readonly NAME = "RunControl";

    constructor(private readonly channel: Pick<TcfChannel, "command" | "onEvent">) {}

    async getChildren(parentId: string | null): Promise<string[]> {
        const [ids] = await this.channel.command(RunControlService.NAME, "getChildren", parentId);
        return Array.isArray(ids) ? (ids as string[]) : [];
    }

    async getContext(id: string): Promise<RunControlContext> {
        const [ctx] = await this.channel.command(RunControlService.NAME, "getContext", id);
        return ctx as RunControlContext;
    }

    async getState(id: string): Promise<RunControlState> {
        const [suspended, pc, reason, data] = await this.channel.command(RunControlService.NAME, "getState", id);
        return {
            suspended: suspended === true,
            pc: typeof pc === "number" || typeof pc === "bigint" ? pc : undefined,
            reason: typeof reason === "string" ? reason : undefined,
            data: isObject(data) ? data : undefined,
        };
    }

    async suspend(id: string): Promise<void> {
        await this.channel.command(RunControlService.NAME, "suspend", id);
    }

    async resume(id: string, mode: ResumeMode = ResumeMode.Resume, count = 1): Promise<void> {
        await this.channel.command(RunControlService.NAME, "resume", id, mode, count);
    }

    addListener(l: RunControlListener): void {
        const on = (event: string, fn: (args: unknown[]) => void) =>
            this.channel.onEvent(RunControlService.NAME, event, fn);
        on("contextAdded", (a) => l.contextAdded?.(asArray(a[0])));
        on("contextChanged", (a) => l.contextChanged?.(asArray(a[0])));
        on("contextRemoved", (a) => l.contextRemoved?.(asArray(a[0])));
        on("contextSuspended", (a) =>
            l.contextSuspended?.(a[0] as string, asPc(a[1]), asString(a[2]), isObject(a[3]) ? a[3] : undefined),
        );
        on("contextResumed", (a) => l.contextResumed?.(a[0] as string));
        on("containerSuspended", (a) =>
            l.containerSuspended?.(
                a[0] as string,
                asPc(a[1]),
                asString(a[2]),
                isObject(a[3]) ? a[3] : undefined,
                asArray(a[4]),
            ),
        );
        on("containerResumed", (a) => l.containerResumed?.(asArray(a[0])));
        on("contextException", (a) => l.contextException?.(a[0] as string, String(a[1] ?? "")));
    }
}

function asArray<T>(v: unknown): T[] {
    return Array.isArray(v) ? (v as T[]) : [];
}

function asString(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
}

function asPc(v: unknown): bigint | number | undefined {
    return typeof v === "number" || typeof v === "bigint" ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
