import { ExpressionContext, ExpressionsService, ExpressionValue, TypeClass } from "./tcf/services/expressions";
import { SymbolClass, SymbolContext, SymbolFlags, SymbolsService } from "./tcf/services/symbols";
import { toBigInt } from "./tcf/json";

/** How a variable expands into children. */
export type Expansion =
    | { kind: "fields"; typeId: string; deref: boolean }
    | { kind: "array"; length: number; lowerBound: bigint }
    | { kind: "deref" };

/** A variable or (sub)expression shown in the Variables, Watch or hover views. */
export interface VariableNode {
    name: string;
    /** Expression script for the agent, may contain ${<symbol ID>} references. */
    script: string;
    /** Human readable expression, used for "Add to Watch" and "Copy as Expression". */
    displayExpr: string;
    value: string;
    type?: string;
    expand?: Expansion;
}

interface Field {
    id: string;
    name: string;
}

/** Flags of type modifier symbols that refer to the modified type through TypeID. */
const MODIFIER_FLAGS = SymbolFlags.Typedef | 0x04 /* const */ | 0x20 /* volatile */ | 0x40; /* restrict */

/**
 * Variables through the TCF Expressions and Symbols services, the same way
 * as the Eclipse TCF client: the agent lists the variables of a frame and
 * evaluates all values. Members, elements and pointer targets are evaluated
 * as new expressions built from the parent expression and member symbol IDs,
 * e.g. "(parent).${<member symbol ID>}", so no expression parsing is needed.
 */
export class VariablesProvider {
    private readonly symbolCache = new Map<string, Promise<SymbolContext | undefined>>();
    private readonly symbolChildrenCache = new Map<string, Promise<string[]>>();

    constructor(
        private readonly expressions: ExpressionsService,
        private readonly symbols: SymbolsService | undefined,
    ) {}

    /** Symbol information can change while running, for example when symbol files are loaded. */
    clearCaches(): void {
        this.symbolCache.clear();
        this.symbolChildrenCache.clear();
    }

    /** Local variables and arguments of a stack frame (or the top frame of a context). */
    async locals(scopeId: string): Promise<VariableNode[]> {
        const ids = await this.expressions.getChildren(scopeId);
        return Promise.all(ids.map((id) => this.local(id)));
    }

    /** Evaluates an expression typed by the user, for example in the Watch view. */
    async evaluate(scopeId: string, text: string): Promise<VariableNode> {
        const { context, value } = await this.expressions.evaluateScript(scopeId, text);
        return this.makeNode(text, text, text, context, value);
    }

    /** Returns the children of an expandable node. For arrays, `start` and `count` select elements. */
    async children(scopeId: string, node: VariableNode, start?: number, count?: number): Promise<VariableNode[]> {
        const parent = `(${node.script})`;
        const expand = node.expand;
        if (!expand) {
            return [];
        }
        switch (expand.kind) {
            case "fields": {
                const fields = await this.fields(expand.typeId);
                const op = expand.deref ? "->" : ".";
                return Promise.all(
                    fields.map((f) =>
                        this.child(
                            scopeId,
                            `${parent}${op}\${${f.id}}`,
                            f.name,
                            `${wrap(node.displayExpr)}${op}${f.name}`,
                        ),
                    ),
                );
            }
            case "array": {
                const first = Math.max(start ?? 0, 0);
                const end = Math.min(count !== undefined ? first + count : expand.length, expand.length);
                const indexes: bigint[] = [];
                for (let i = first; i < end; i++) {
                    indexes.push(expand.lowerBound + BigInt(i));
                }
                return Promise.all(
                    indexes.map((i) =>
                        this.child(scopeId, `${parent}[${i}]`, `[${i}]`, `${wrap(node.displayExpr)}[${i}]`),
                    ),
                );
            }
            case "deref":
                return [await this.child(scopeId, `*${parent}`, `*${node.name}`, `(*${wrap(node.displayExpr)})`)];
        }
    }

    private async local(id: string): Promise<VariableNode> {
        const ctx = await this.expressions.getContext(id);
        const sym = ctx.SymbolID ? await this.symbol(ctx.SymbolID) : undefined;
        const name = sym?.Name ?? ctx.Expression ?? id;
        let value: ExpressionValue | undefined;
        let error: string | undefined;
        try {
            value = await this.expressions.evaluateId(id);
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
        return this.makeNode(name, ctx.Expression ?? name, name, ctx, value, error);
    }

    private async child(scopeId: string, script: string, name: string, displayExpr: string): Promise<VariableNode> {
        try {
            const { context, value } = await this.expressions.evaluateScript(scopeId, script);
            return this.makeNode(name, script, displayExpr, context, value);
        } catch (err) {
            return { name, script, displayExpr, value: `<${err instanceof Error ? err.message : String(err)}>` };
        }
    }

    private async makeNode(
        name: string,
        script: string,
        displayExpr: string,
        ctx: ExpressionContext | undefined,
        value: ExpressionValue | undefined,
        error?: string,
    ): Promise<VariableNode> {
        const typeId = ctx?.Type ?? value?.properties.Type;
        const type = typeId ? await this.resolvedType(typeId) : undefined;
        const typeClass = type?.TypeClass ?? value?.properties.Class ?? ctx?.Class;
        const node: VariableNode = {
            name,
            script,
            displayExpr,
            value: "",
            type: typeId ? await this.typeName(typeId) : undefined,
        };
        if (error !== undefined || !value) {
            node.value = `<${error ?? "no value"}>`;
            return node;
        }
        node.value = await this.formatValue(value, typeClass, type, node.type);
        node.expand = await this.expansion(typeClass, type, value);
        return node;
    }

    private async expansion(
        typeClass: number | undefined,
        type: SymbolContext | undefined,
        value: ExpressionValue,
    ): Promise<Expansion | undefined> {
        if (!type) {
            return undefined;
        }
        switch (typeClass) {
            case TypeClass.Composite:
                return { kind: "fields", typeId: type.ID, deref: false };
            case TypeClass.Array:
                return type.Length && type.Length > 0
                    ? { kind: "array", length: type.Length, lowerBound: toBigInt(type.LowerBound) ?? 0n }
                    : undefined;
            case TypeClass.Pointer: {
                if (value.bytes.every((b) => b === 0) || !type.BaseTypeID) {
                    return undefined;
                }
                const base = await this.resolvedType(type.BaseTypeID);
                if (!base || base.TypeClass === TypeClass.Function || !base.Size) {
                    return undefined;
                }
                return base.TypeClass === TypeClass.Composite
                    ? { kind: "fields", typeId: base.ID, deref: true }
                    : { kind: "deref" };
            }
            default:
                return undefined;
        }
    }

    private async formatValue(
        value: ExpressionValue,
        typeClass: number | undefined,
        type: SymbolContext | undefined,
        typeName: string | undefined,
    ): Promise<string> {
        const le = value.properties.BigEndian ? Buffer.from(value.bytes).reverse() : value.bytes;
        if (le.length === 0) {
            return "";
        }
        const hex = `0x${Buffer.from(le)
            .reverse()
            .toString("hex")
            .replace(/^0+(?=.)/, "")}`;
        const unsigned = le.length <= 8 ? readUnsigned(le) : undefined;
        switch (typeClass) {
            case TypeClass.Composite:
                return "{...}";
            case TypeClass.Array:
                return `[${type?.Length ?? "?"}]`;
            case TypeClass.Pointer:
            case TypeClass.Function:
                return hex;
            case TypeClass.Real:
                if (le.length === 4) {
                    return String(le.readFloatLE(0));
                }
                return le.length === 8 ? String(le.readDoubleLE(0)) : hex;
            case TypeClass.Enumeration: {
                const name = type ? await this.enumeratorName(type.ID, le) : undefined;
                const n = unsigned !== undefined ? BigInt.asIntN(le.length * 8, unsigned).toString() : hex;
                return name ? `${name} (${n})` : n;
            }
            case TypeClass.Cardinal:
            case TypeClass.Integer: {
                if (unsigned === undefined) {
                    return hex;
                }
                const n = typeClass === TypeClass.Integer ? BigInt.asIntN(le.length * 8, unsigned) : unsigned;
                if (((type?.Flags ?? 0) & SymbolFlags.BoolType) !== 0 || typeName === "_Bool" || typeName === "bool") {
                    return n === 0n ? "false" : "true";
                }
                if (le.length === 1 && typeName && /char/.test(typeName)) {
                    return `${n} ${charLiteral(Number(unsigned))}`;
                }
                return n.toString();
            }
            default:
                return hex;
        }
    }

    private async enumeratorName(typeId: string, le: Buffer): Promise<string | undefined> {
        for (const id of await this.symbolChildren(typeId)) {
            const e = await this.symbol(id);
            if (e?.Value === undefined) {
                continue;
            }
            const v = Buffer.from(e.Value, "base64");
            const n = Math.min(v.length, le.length);
            // Enumerator values can be shorter than the variable, compare the common bytes.
            if (n > 0 && v.subarray(0, n).equals(le.subarray(0, n)) && le.subarray(n).every((b) => b === 0)) {
                return e.Name;
            }
        }
        return undefined;
    }

    /** Members of a composite type, including members of anonymous members and variants. */
    private async fields(typeId: string): Promise<Field[]> {
        const result: Field[] = [];
        for (const id of await this.symbolChildren(typeId)) {
            const sym = await this.symbol(id);
            if (!sym) {
                continue;
            }
            const flags = sym.Flags ?? 0;
            if (sym.Class === SymbolClass.Reference) {
                if ((flags & SymbolFlags.Artificial) !== 0) {
                    continue;
                }
                if (!sym.Name && (flags & SymbolFlags.Inheritance) === 0) {
                    // Members of anonymous structs and unions are accessed through the parent.
                    result.push(...(await this.fields(sym.TypeID ?? sym.ID)));
                } else {
                    result.push({
                        id,
                        name: sym.Name ?? (sym.TypeID ? await this.typeName(sym.TypeID) : undefined) ?? id,
                    });
                }
            } else if (sym.Class === SymbolClass.Variant || sym.Class === SymbolClass.VariantPart) {
                result.push(...(await this.fields(id)));
            }
        }
        return result;
    }

    /** Follows typedefs and const/volatile modifiers to the actual type. */
    private async resolvedType(typeId: string): Promise<SymbolContext | undefined> {
        let sym = await this.symbol(typeId);
        for (let depth = 0; sym && depth < 16; depth++) {
            if (((sym.Flags ?? 0) & MODIFIER_FLAGS) === 0 || !sym.TypeID || sym.TypeID === sym.ID) {
                break;
            }
            sym = await this.symbol(sym.TypeID);
        }
        return sym;
    }

    private async typeName(typeId: string, depth = 0): Promise<string | undefined> {
        const sym = await this.symbol(typeId);
        if (!sym) {
            return undefined;
        }
        if (sym.Name) {
            return sym.Name;
        }
        if (depth > 8) {
            return undefined;
        }
        const base = sym.BaseTypeID ? await this.typeName(sym.BaseTypeID, depth + 1) : undefined;
        switch (sym.TypeClass) {
            case TypeClass.Pointer:
                return `${base ?? "void"} *`;
            case TypeClass.Array:
                return `${base ?? "?"}[${sym.Length ?? ""}]`;
            case TypeClass.Composite:
                return ((sym.Flags ?? 0) & 0x80) !== 0 ? "union" : "struct";
            case TypeClass.Function:
                return "function";
            default:
                return sym.TypeID && sym.TypeID !== sym.ID ? this.typeName(sym.TypeID, depth + 1) : undefined;
        }
    }

    private symbol(id: string): Promise<SymbolContext | undefined> {
        let p = this.symbolCache.get(id);
        if (!p) {
            p = this.symbols ? this.symbols.getContext(id).catch(() => undefined) : Promise.resolve(undefined);
            this.symbolCache.set(id, p);
        }
        return p;
    }

    private symbolChildren(id: string): Promise<string[]> {
        let p = this.symbolChildrenCache.get(id);
        if (!p) {
            p = this.symbols ? this.symbols.getChildren(id).catch(() => []) : Promise.resolve([]);
            this.symbolChildrenCache.set(id, p);
        }
        return p;
    }
}

/** Wraps an expression in parentheses unless it is a simple name, member or element access. */
function wrap(expr: string): string {
    return /^[\w$]+(?:(?:\.|->)[\w$]+|\[\d+\])*$/.test(expr) ? expr : `(${expr})`;
}

function readUnsigned(le: Buffer): bigint {
    let v = 0n;
    for (let i = le.length - 1; i >= 0; i--) {
        v = (v << 8n) | BigInt(le[i]);
    }
    return v;
}

function charLiteral(code: number): string {
    const escapes: Record<number, string> = {
        0: "\\0",
        7: "\\a",
        8: "\\b",
        9: "\\t",
        10: "\\n",
        11: "\\v",
        12: "\\f",
        13: "\\r",
        39: "\\'",
        92: "\\\\",
    };
    if (escapes[code] !== undefined) {
        return `'${escapes[code]}'`;
    }
    return code >= 0x20 && code < 0x7f
        ? `'${String.fromCharCode(code)}'`
        : `'\\x${code.toString(16).padStart(2, "0")}'`;
}
