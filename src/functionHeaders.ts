import { DebugProtocol } from "@vscode/debugprotocol";

/**
 * URI scheme of the one-line documents that hold the function headers shown
 * in the Disassembly view. The extension provides their content.
 */
export const FUNCTION_HEADER_SCHEME = "simics-target-debug-function";

/** Lookups per disassemble request, code without symbols needs one each. */
const MAX_LOOKUPS = 64;
const MAX_FUNCTIONS = 4096;
const MAX_NO_FUNCTION = 16384;

/** A function and the address range of its code. */
export interface FunctionInfo {
    name: string;
    address: bigint;
    /** Missing if the agent does not report one, for example split code. */
    size?: number;
    /** File name (without directory) and line of the entry, if known. */
    file?: string;
    line?: number;
}

/**
 * Returns the function containing `address`, or undefined if there is none.
 * Errors count as no function.
 */
export type FunctionLookup = (contextId: string, address: bigint) => Promise<FunctionInfo | undefined>;

function contains(f: FunctionInfo, address: bigint): boolean {
    return f.size !== undefined && f.size > 0
        ? f.address <= address && address < f.address + BigInt(f.size)
        : address === f.address;
}

/**
 * Finds the functions of disassembled instructions. A function covers all
 * of its instructions, so there is one lookup per function. Results are
 * kept per context until symbols change.
 */
export class FunctionRanges {
    private readonly functions = new Map<string, FunctionInfo[]>();
    private readonly noFunction = new Map<string, Set<bigint>>();

    constructor(
        private readonly lookup: FunctionLookup,
        private readonly maxLookups = MAX_LOOKUPS,
    ) {}

    /**
     * The function of each of `addresses` that is in one. Addresses are looked
     * up in the given order, so the first ones get a function if the lookups
     * run out.
     */
    async find(contextId: string, addresses: bigint[]): Promise<Map<bigint, FunctionInfo>> {
        const functions = this.functions.get(contextId) ?? [];
        this.functions.set(contextId, functions);
        const none = this.noFunction.get(contextId) ?? new Set<bigint>();
        this.noFunction.set(contextId, none);
        const result = new Map<bigint, FunctionInfo>();
        let lookups = 0;
        for (const address of addresses) {
            let f = functions.find((g) => contains(g, address));
            if (!f && !none.has(address) && lookups < this.maxLookups) {
                lookups++;
                f = await this.lookup(contextId, address).catch(() => undefined);
                if (f && contains(f, address)) {
                    functions.push(f);
                    if (functions.length > MAX_FUNCTIONS) {
                        functions.shift();
                    }
                } else {
                    f = undefined;
                    none.add(address);
                    if (none.size > MAX_NO_FUNCTION) {
                        none.delete(none.values().next().value!);
                    }
                }
            }
            if (f) {
                result.set(address, f);
            }
        }
        return result;
    }

    delete(contextId: string): void {
        this.functions.delete(contextId);
        this.noFunction.delete(contextId);
    }

    clear(): void {
        this.functions.clear();
        this.noFunction.clear();
    }
}

/**
 * The source of a function's header, see functionHeaderText. VS Code shows
 * its line `functionHeaderLine(f)` above the entry instruction, prefixed with
 * the line number. The address keeps functions with the same name apart.
 */
export function functionHeaderSource(f: FunctionInfo): DebugProtocol.Source {
    const address = `0x${f.address.toString(16)}`;
    const parts = [
        address,
        String(functionHeaderLine(f)),
        encodeURIComponent(f.file ?? ""),
        encodeURIComponent(f.name),
    ];
    return {
        name: f.name,
        path: `${FUNCTION_HEADER_SCHEME}:/${parts.join("/")}`,
    };
}

/** The line of the header: the entry's source line, or 1. */
export function functionHeaderLine(f: FunctionInfo): number {
    return f.line !== undefined && Number.isSafeInteger(f.line) && f.line > 0 ? f.line : 1;
}

/**
 * The document for the decoded path of a functionHeaderSource URI: the
 * header on its line, empty lines before it. Undefined for other paths,
 * which are directories.
 */
export function functionHeaderText(path: string): string | undefined {
    const [empty, address, lineText, file, ...name] = path.split("/");
    const line = Number(lineText);
    if (empty !== "" || !address || !Number.isSafeInteger(line) || line < 1 || name.length === 0) {
        return undefined;
    }
    const header = `${file ? `${file}: ` : ""}<${name.join("/")}>`;
    return "\n".repeat(line - 1) + header;
}
