import { TcfChannel } from "@/tcf/channel";

/** A code area, see TCF Services -> Line Numbers. */
export interface CodeArea {
    /** Compilation directory, used to resolve a relative File. */
    Dir?: string;
    File?: string;
    SLine?: number;
    SCol?: number;
    ELine?: number;
    ECol?: number;
    SAddr?: bigint | number;
    EAddr?: bigint | number;
    IsStmt?: boolean;
    [key: string]: unknown;
}

export class LineNumbersService {
    static readonly NAME = "LineNumbers";

    constructor(private readonly channel: TcfChannel) {}

    /** Returns the code areas that cover the address range [start, end). */
    async mapToSource(contextId: string, start: bigint, end: bigint): Promise<CodeArea[]> {
        const [areas] = await this.channel.command(LineNumbersService.NAME, "mapToSource", contextId, start, end);
        return Array.isArray(areas) ? (areas as CodeArea[]) : [];
    }
}
