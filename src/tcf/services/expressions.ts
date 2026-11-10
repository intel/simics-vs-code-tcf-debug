import { TcfChannel, formatTcfError } from "@/tcf/channel";

/** Type classes, see TCF Services -> Symbols -> TypeClass. */
export const enum TypeClass {
    Unknown = 0,
    Cardinal = 1,
    Integer = 2,
    Real = 3,
    Pointer = 4,
    Array = 5,
    Composite = 6,
    Enumeration = 7,
    Function = 8,
}

export interface ValueProperties {
    Class?: number;
    Type?: string;
    BigEndian?: boolean;
    [key: string]: unknown;
}

export interface ExpressionValue {
    /** Raw value bytes in target byte order. */
    bytes: Buffer;
    properties: ValueProperties;
}

/** Expression context properties, see TCF Services -> Expressions -> getContext. */
export interface ExpressionContext {
    ID: string;
    ParentID?: string;
    SymbolID?: string;
    /** The expression script, may contain ${<symbol ID>} references. */
    Expression?: string;
    CanAssign?: boolean;
    Class?: number;
    Type?: string;
    Size?: number;
    [key: string]: unknown;
}

export class ExpressionsService {
    static readonly NAME = "Expressions";

    constructor(private readonly channel: TcfChannel) {}

    /**
     * Returns the expression IDs for the variables of a context or stack
     * frame: local variables and function arguments.
     */
    async getChildren(parentId: string): Promise<string[]> {
        const [ids] = await this.channel.command(ExpressionsService.NAME, "getChildren", parentId);
        return Array.isArray(ids) ? (ids as string[]) : [];
    }

    async getContext(id: string): Promise<ExpressionContext> {
        const [ctx] = await this.channel.command(ExpressionsService.NAME, "getContext", id);
        return ctx as ExpressionContext;
    }

    /** Evaluates an existing expression. */
    async evaluateId(id: string): Promise<ExpressionValue> {
        // The reply is <value> <error report> <value properties>.
        const [value, err, props] = await this.channel.sendCommand(ExpressionsService.NAME, "evaluate", [id]);
        if (err !== null && err !== undefined) {
            throw new Error(formatTcfError(err));
        }
        return {
            bytes: typeof value === "string" ? Buffer.from(value, "base64") : Buffer.alloc(0),
            properties: (props ?? {}) as ValueProperties,
        };
    }

    /**
     * Evaluates an expression script once in the scope of a context or stack
     * frame, returning its context (type) and value.
     */
    async evaluateScript(
        contextId: string,
        script: string,
    ): Promise<{ context: ExpressionContext; value: ExpressionValue }> {
        const [ctx] = await this.channel.command(ExpressionsService.NAME, "create", contextId, null, script);
        const context = ctx as ExpressionContext | undefined;
        if (!context?.ID) {
            throw new Error(`Failed to create expression '${script}'`);
        }
        try {
            return { context, value: await this.evaluateId(context.ID) };
        } finally {
            this.channel.command(ExpressionsService.NAME, "dispose", context.ID).catch(() => undefined);
        }
    }

    /** Evaluates an expression script once in the scope of a context or stack frame. */
    async evaluate(contextId: string, script: string): Promise<ExpressionValue> {
        return (await this.evaluateScript(contextId, script)).value;
    }
}

/** Formats an evaluated value for display. */
export function formatExpressionValue(value: ExpressionValue): string {
    const { bytes, properties } = value;
    if (bytes.length === 0) {
        return "";
    }
    const le = properties.BigEndian ? Buffer.from(bytes).reverse() : bytes;
    const hex = `0x${Buffer.from(le)
        .reverse()
        .toString("hex")
        .replace(/^0+(?=.)/, "")}`;
    switch (properties.Class) {
        case TypeClass.Cardinal:
        case TypeClass.Enumeration:
            return le.length <= 8 ? readUnsigned(le).toString() : hex;
        case TypeClass.Integer:
            return le.length <= 8 ? BigInt.asIntN(le.length * 8, readUnsigned(le)).toString() : hex;
        case TypeClass.Real:
            if (le.length === 4) {
                return String(le.readFloatLE(0));
            }
            if (le.length === 8) {
                return String(le.readDoubleLE(0));
            }
            return hex;
        default:
            return hex;
    }
}

function readUnsigned(le: Buffer): bigint {
    let v = 0n;
    for (let i = le.length - 1; i >= 0; i--) {
        v = (v << 8n) | BigInt(le[i]);
    }
    return v;
}
