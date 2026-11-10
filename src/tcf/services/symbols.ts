import { TcfChannel } from "@/tcf/channel";

/** Symbol classes, see TCF Services -> Symbols -> SymbolClass. */
export const enum SymbolClass {
    Unknown = 0,
    Value = 1,
    Reference = 2,
    Function = 3,
    Type = 4,
    CompUnit = 5,
    Block = 6,
    Namespace = 7,
    VariantPart = 8,
    Variant = 9,
}

/** Symbol flags, see TCF Services -> Symbols -> Flags. */
export const enum SymbolFlags {
    Parameter = 0x00000001,
    Typedef = 0x00000002,
    Artificial = 0x00020000,
    Inheritance = 0x02000000,
    BoolType = 0x04000000,
}

export interface SymbolContext {
    ID: string;
    OwnerID?: string;
    /** The enclosing scope, for example the function of a lexical block. */
    ContainerID?: string;
    Name?: string;
    /** Symbol class, see SymbolClass. */
    Class?: number;
    /** Type class of a type symbol, see TypeClass in the Expressions service. */
    TypeClass?: number;
    TypeID?: string;
    BaseTypeID?: string;
    Address?: bigint | number;
    Size?: number;
    /** Number of elements of an array type. */
    Length?: number;
    LowerBound?: number | bigint;
    Offset?: number;
    Flags?: number;
    /** Base64 encoded value, for example of an enumerator. */
    Value?: string;
    [key: string]: unknown;
}

export class SymbolsService {
    static readonly NAME = "Symbols";

    constructor(private readonly channel: TcfChannel) {}

    /**
     * Returns the IDs of the symbols containing `address`. Older agents reply
     * with a single ID, newer with an array.
     */
    async findByAddr(contextId: string, address: bigint): Promise<string[]> {
        const [ids] = await this.channel.command(SymbolsService.NAME, "findByAddr", contextId, address);
        if (typeof ids === "string") {
            return [ids];
        }
        return Array.isArray(ids) ? (ids as string[]) : [];
    }

    async getContext(id: string): Promise<SymbolContext> {
        const [ctx] = await this.channel.command(SymbolsService.NAME, "getContext", id);
        return ctx as SymbolContext;
    }

    /** Returns the children of a symbol, for example the members of a structure type. */
    async getChildren(id: string): Promise<string[]> {
        const [ids] = await this.channel.command(SymbolsService.NAME, "getChildren", id);
        return Array.isArray(ids) ? (ids as string[]) : [];
    }
}
