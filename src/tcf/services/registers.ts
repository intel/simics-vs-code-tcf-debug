import { TcfChannel } from "@/tcf/channel";

export interface NamedValue {
    Name?: string;
    Description?: string;
    /** Base64 encoded value. */
    Value?: string;
}

/** Registers context properties, see TCF Services -> Registers. */
export interface RegistersContext {
    ID: string;
    ParentID?: string;
    ProcessID?: string;
    Name?: string;
    Description?: string;
    Size?: number;
    Readable?: boolean;
    ReadOnce?: boolean;
    Writeable?: boolean;
    WriteOnce?: boolean;
    SideEffects?: boolean;
    Volatile?: boolean;
    Float?: boolean;
    BigEndian?: boolean;
    LeftToRight?: boolean;
    FirstBit?: number;
    Bits?: number[];
    Values?: NamedValue[];
    Role?: string;
    [key: string]: unknown;
}

export interface RegistersListener {
    contextChanged?(): void;
    registerChanged?(id: string): void;
}

export class RegistersService {
    static readonly NAME = "Registers";

    constructor(private readonly channel: TcfChannel) {}

    /**
     * Returns the IDs of the register contexts directly below `parentId`,
     * which is either a run control context, a stack frame or a register
     * (group) context.
     */
    async getChildren(parentId: string): Promise<string[]> {
        const [ids] = await this.channel.command(RegistersService.NAME, "getChildren", parentId);
        return Array.isArray(ids) ? (ids as string[]) : [];
    }

    async getContext(id: string): Promise<RegistersContext> {
        const [ctx] = await this.channel.command(RegistersService.NAME, "getContext", id);
        return ctx as RegistersContext;
    }

    /** Reads a register value, returned as raw bytes in target byte order. */
    async get(id: string): Promise<Buffer> {
        const [value] = await this.channel.command(RegistersService.NAME, "get", id);
        return typeof value === "string" ? Buffer.from(value, "base64") : Buffer.alloc(0);
    }

    addListener(l: RegistersListener): void {
        this.channel.onEvent(RegistersService.NAME, "contextChanged", () => l.contextChanged?.());
        this.channel.onEvent(RegistersService.NAME, "registerChanged", (a) => l.registerChanged?.(a[0] as string));
    }
}
