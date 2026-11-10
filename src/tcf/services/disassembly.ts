import { TcfChannel } from "@/tcf/channel";

export interface DisassemblyField {
    Type?: string;
    Text?: string;
    Value?: bigint | number;
    AddressSpace?: string;
}

export interface DisassemblyLine {
    Address: bigint | number;
    Size: number;
    Instruction?: DisassemblyField[];
    OpcodeValue?: string;
}

export class DisassemblyService {
    static readonly NAME = "Disassembly";

    constructor(private readonly channel: TcfChannel) {}

    async disassemble(contextId: string, address: bigint, size: number): Promise<DisassemblyLine[]> {
        const [lines] = await this.channel.command(DisassemblyService.NAME, "disassemble", contextId, address, size, {
            OpcodeValue: true,
        });
        return Array.isArray(lines) ? (lines as DisassemblyLine[]) : [];
    }
}
