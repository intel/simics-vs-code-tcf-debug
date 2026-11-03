import { DebugProtocol } from "@vscode/debugprotocol";
import { TcfError } from "./tcf/channel";
import { toBigInt } from "./tcf/json";
import { FunctionInfo, functionHeaderLine, functionHeaderSource } from "./functionHeaders";
import { DisassemblyLine, DisassemblyService } from "./tcf/services/disassembly";

/** Room per instruction when reading backwards, x86 needs up to 15 bytes. */
const MAX_INSTRUCTION_BYTES = 16;
const MAX_REQUEST_BYTES = 1024 * 1024;
/** How far below a backward range a known instruction start is used. */
const START_SEARCH_BYTES = 256n;
const MAX_KNOWN_STARTS = 4096;
/** Requests per range, the agent may answer one function at a time. */
const MAX_READS = 256;
const MAX_CACHED_REPLIES = 1024;

type Disassembler = Pick<DisassemblyService, "disassemble">;
type Reader = (start: bigint, end: bigint) => Promise<DisassemblyLine[]>;

/** Where lines come from: the agent, and replies cached for the context. */
interface LineSource {
    service: Disassembler;
    contextId: string;
    cache?: DisassemblyCache;
}

/**
 * Reads `size` bytes of target memory, or returns undefined if some cannot
 * be read.
 */
export type MemoryReader = (contextId: string, address: bigint, size: number) => Promise<Uint8Array | undefined>;

export interface DisassemblyOptions {
    knownStarts?: InstructionStartLookup;
    cache?: DisassemblyCache;
    /**
     * Finds the functions of instructions, for headers at their entries.
     * Addresses come nearest to the requested address first, in case not all
     * can be looked up.
     */
    functions?: (addresses: bigint[]) => Promise<Map<bigint, FunctionInfo>>;
}

/**
 * Returns addresses in [start, end) where an instruction is known to start,
 * in any order.
 */
export type InstructionStartLookup = (start: bigint, end: bigint) => Promise<Iterable<bigint>>;

export function instructionReference(contextId: string, address: bigint): string {
    return JSON.stringify([contextId, formatAddress(address)]);
}

export function parseInstructionReference(reference: string): {
    contextId?: string;
    address: bigint;
} {
    let addressText = reference;
    if (reference.startsWith("[")) {
        const parts: unknown = JSON.parse(reference);
        if (
            !Array.isArray(parts) ||
            parts.length !== 2 ||
            typeof parts[0] !== "string" ||
            typeof parts[1] !== "string"
        ) {
            throw new Error("Invalid instruction reference");
        }
        addressText = parts[1];
        if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(addressText)) {
            throw new Error("Invalid instruction address");
        }
        return { contextId: parts[0], address: BigInt(addressText) };
    }
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(addressText)) {
        throw new Error("Invalid instruction address");
    }
    return { address: BigInt(addressText) };
}

/**
 * Remembers addresses where an instruction is known to start, such as PCs
 * where a context stopped, so that disassembly stays in step with them.
 * Keeps the most recently added addresses per context.
 */
export class KnownInstructionStarts {
    private readonly byContext = new Map<string, Set<bigint>>();

    constructor(private readonly limit = MAX_KNOWN_STARTS) {}

    add(contextId: string, address: bigint): void {
        let starts = this.byContext.get(contextId);
        if (!starts) {
            starts = new Set();
            this.byContext.set(contextId, starts);
        }
        // Sets keep insertion order: the first entry is the oldest.
        starts.delete(address);
        starts.add(address);
        if (starts.size > this.limit) {
            starts.delete(starts.values().next().value!);
        }
    }

    inRange(contextId: string, start: bigint, end: bigint): bigint[] {
        const starts = this.byContext.get(contextId) ?? [];
        return [...starts].filter((a) => a >= start && a < end);
    }

    delete(contextId: string): void {
        this.byContext.delete(contextId);
    }

    clear(): void {
        this.byContext.clear();
    }
}

interface CachedReply {
    /** The lines of the reply from the request address on. */
    lines: DisassemblyLine[];
    /** The generation in which the lines were known to match memory. */
    generation: number;
}

/**
 * Caches Disassembly replies by context and request address, since the agent
 * can take long per request. Code rarely changes, so replies are kept when
 * the target runs. After a resume or a memory write they are only used again
 * once a memory read shows that their opcode bytes are unchanged.
 */
export class DisassemblyCache {
    private readonly byContext = new Map<string, Map<bigint, CachedReply>>();
    private generation = 0;

    constructor(
        private readonly readMemory?: MemoryReader,
        private readonly limit = MAX_CACHED_REPLIES,
    ) {}

    /** Memory may have changed: check replies before using them. */
    invalidate(): void {
        this.generation++;
    }

    /** Pass to set() for a reply to a request sent now. */
    get current(): number {
        return this.generation;
    }

    delete(contextId: string): void {
        this.byContext.delete(contextId);
    }

    clear(): void {
        this.byContext.clear();
    }

    /** The lines before `end` of a checked reply for a request at `from`. */
    get(contextId: string, from: bigint, end: bigint): DisassemblyLine[] | undefined {
        const reply = this.byContext.get(contextId)?.get(from);
        if (!reply || reply.generation !== this.generation) {
            return undefined;
        }
        return reply.lines.filter((line) => addressOf(line) < end);
    }

    set(contextId: string, from: bigint, lines: DisassemblyLine[], generation: number): void {
        let replies = this.byContext.get(contextId);
        if (!replies) {
            replies = new Map();
            this.byContext.set(contextId, replies);
        }
        // Maps keep insertion order: the first entry is the oldest.
        replies.delete(from);
        replies.set(from, { lines, generation });
        if (replies.size > this.limit) {
            replies.delete(replies.keys().next().value!);
        }
    }

    /**
     * Checks the cached replies for requests in [start, end), with one memory
     * read. Replies whose bytes changed are dropped.
     */
    async check(contextId: string, start: bigint, end: bigint): Promise<void> {
        const replies = this.byContext.get(contextId);
        if (!replies || !this.readMemory) {
            return;
        }
        const generation = this.generation;
        const stale: [bigint, CachedReply][] = [];
        let low: bigint | undefined;
        let high: bigint | undefined;
        for (const [from, reply] of replies) {
            if (from < start || from >= end || reply.generation === generation) {
                continue;
            }
            const first = reply.lines[0];
            const last = reply.lines.at(-1);
            if (!first || !last) {
                replies.delete(from);
                continue;
            }
            stale.push([from, reply]);
            const a = addressOf(first);
            const b = endOf(last);
            low = low === undefined || a < low ? a : low;
            high = high === undefined || b > high ? b : high;
        }
        if (low === undefined || high === undefined) {
            return;
        }
        let bytes: Uint8Array | undefined;
        try {
            bytes = await this.readMemory(contextId, low, Number(high - low));
        } catch {
            bytes = undefined;
        }
        for (const [from, reply] of stale) {
            if (bytes && reply.lines.every((l) => matches(l, bytes, low))) {
                reply.generation = generation;
            } else {
                replies.delete(from);
            }
        }
    }
}

/** Whether the opcode bytes of `line` are in `bytes`, read at `address`. */
function matches(line: DisassemblyLine, bytes: Uint8Array, address: bigint): boolean {
    if (!line.OpcodeValue) {
        return false;
    }
    const opcode = Buffer.from(line.OpcodeValue, "base64");
    const offset = Number(addressOf(line) - address);
    return (
        offset >= 0 &&
        offset + opcode.length <= bytes.length &&
        opcode.equals(bytes.subarray(offset, offset + opcode.length))
    );
}

/**
 * Handles a DAP disassemble request. `address` must be the start of an
 * instruction, such as a PC. On instruction sets with variable length,
 * decoding from an arbitrary address can get out of step with the real
 * instructions, so `knownStarts` gives addresses that decoding must stay in
 * step with. See disassembleBefore and disassembleAligned.
 */
export async function disassembleInstructions(
    service: Disassembler,
    contextId: string,
    address: bigint,
    args: DebugProtocol.DisassembleArguments,
    options: DisassemblyOptions = {},
): Promise<DebugProtocol.DisassembledInstruction[]> {
    const { knownStarts, cache } = options;
    const source: LineSource = { service, contextId, cache };
    const count = args.instructionCount;
    const instructionOffset = args.instructionOffset ?? 0;
    const byteOffset = args.offset ?? 0;
    if (![count, instructionOffset, byteOffset].every(Number.isSafeInteger) || count < 0) {
        throw new Error("Invalid disassembly offset or instruction count");
    }
    if (count === 0) {
        return [];
    }
    const base = address + BigInt(byteOffset);
    if (base < 0n) {
        throw new Error("Disassembly address must not be negative");
    }
    const before = Math.max(0, -instructionOffset);
    const after = Math.max(0, instructionOffset + count);
    const lookBack = BigInt(before) * BigInt(MAX_INSTRUCTION_BYTES);
    const low = base > lookBack ? base - lookBack : 0n;
    const high = base + BigInt(after) * BigInt(MAX_INSTRUCTION_BYTES);
    if (high - low > BigInt(MAX_REQUEST_BYTES)) {
        throw new Error("Disassembly request is too large");
    }
    // Known starts do not help when reading a single instruction.
    const starts =
        knownStarts && (before > 0 || after > 1)
            ? await sortedStarts(knownStarts, low > START_SEARCH_BYTES ? low - START_SEARCH_BYTES : 0n, high)
            : [];
    const lines: DisassemblyLine[] = [];
    if (before > 0) {
        const below = starts.filter((a) => a < base);
        lines.push(...(await disassembleBefore(source, low, base, below)));
    }
    if (after > 0) {
        const read: Reader = (from, to) => disassembleMappedRange(source, from, to);
        const above = starts.filter((a) => a > base);
        lines.push(...(await disassembleAligned(read, base, high, above, true)));
    }
    const pivot = lines.findIndex((line) => addressOf(line) >= base);
    const first = (pivot < 0 ? lines.length : pivot) + instructionOffset;
    const result = Array.from({ length: count }, (_, index) => {
        const position = first + index;
        const line = lines[position];
        if (line) {
            return toDapInstruction(line);
        }
        if (position < 0) {
            // VS Code skips address -1. A made-up "??" address would replace
            // instructions it already shows around that address.
            return {
                address: "-1",
                instruction: "??",
                presentationHint: "invalid" as const,
            };
        }
        const last = lines.at(-1);
        const fallback = last ? endOf(last) + BigInt(Math.max(0, position - lines.length)) : base + BigInt(index);
        return {
            address: formatAddress(fallback),
            instruction: "??",
            presentationHint: "invalid" as const,
        };
    });
    if (options.functions) {
        await addFunctions(result, options.functions, -instructionOffset);
    }
    return result;
}

/**
 * Sets the symbol of instructions in a function, and a header at function
 * entries. VS Code shows line 1 of the header's source above the entry, and
 * only shows sources of instructions that have a line.
 */
async function addFunctions(
    instructions: DebugProtocol.DisassembledInstruction[],
    functions: NonNullable<DisassemblyOptions["functions"]>,
    baseIndex: number,
): Promise<void> {
    const decoded = instructions
        .map((instruction, index) => ({ instruction, index }))
        .filter(({ instruction }) => instruction.presentationHint !== "invalid")
        .sort((a, b) => Math.abs(a.index - baseIndex) - Math.abs(b.index - baseIndex))
        .map(({ instruction }) => instruction);
    let found: Map<bigint, FunctionInfo>;
    try {
        found = await functions(decoded.map((i) => BigInt(i.address)));
    } catch {
        return;
    }
    for (const instruction of decoded) {
        const address = BigInt(instruction.address);
        const f = found.get(address);
        if (!f) {
            continue;
        }
        instruction.symbol = f.name;
        if (f.address === address) {
            instruction.location = functionHeaderSource(f);
            instruction.line = functionHeaderLine(f);
        }
    }
}

async function sortedStarts(lookup: InstructionStartLookup, start: bigint, end: bigint): Promise<bigint[]> {
    let starts: Iterable<bigint>;
    try {
        starts = await lookup(start, end);
    } catch {
        return [];
    }
    return [...new Set(starts)].filter((a) => a >= start && a < end).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Decodes the instructions in [low, base), ending exactly at `base`. Starts
 * at the highest known start at or shortly below `low` if there is one, else
 * at `low`. `starts` are the known starts below `base`, ascending. Skips
 * unreadable memory at the start. Returns nothing if the instructions cannot
 * be decoded up to `base`, since the instruction offsets would be wrong.
 */
async function disassembleBefore(
    source: LineSource,
    low: bigint,
    base: bigint,
    starts: bigint[],
): Promise<DisassemblyLine[]> {
    const read: Reader = (from, to) => readLines(source, from, to);
    const known = starts.filter((a) => a <= low).at(-1);
    let start = known ?? low;
    let startKnown = known !== undefined;
    while (start < base) {
        try {
            const targets = [...starts.filter((a) => a > start), base];
            const lines = await disassembleAligned(read, start, base, targets, startKnown);
            const last = lines.at(-1);
            return last && endOf(last) >= base ? lines : [];
        } catch (err) {
            if (!isUnmappedAddress(err)) {
                throw err;
            }
            start += (base - start + 1n) / 2n;
            startKnown = false;
        }
    }
    return [];
}

/**
 * Decodes [start, end) so that an instruction starts at each of `targets`
 * (ascending, in (start, end]). Where a decoded instruction runs over a
 * target, decoding restarts at the target. That instruction is kept: it can
 * be real, such as a lock prefix that code jumps over, or data in the code.
 * If `start` is not a known instruction start, the following addresses are
 * tried first until decoding lands on the first target.
 */
async function disassembleAligned(
    read: Reader,
    start: bigint,
    end: bigint,
    targets: bigint[],
    startKnown: boolean,
): Promise<DisassemblyLine[]> {
    let lines = await read(start, end);
    const result: DisassemblyLine[] = [];
    for (const [index, target] of targets.entries()) {
        if (!runsOver(lines, target)) {
            continue;
        }
        if (index === 0 && !startKnown) {
            const landed = await findLanding(read, start, end, target);
            if (landed) {
                lines = landed;
                continue;
            }
        }
        result.push(...lines.filter((line) => addressOf(line) < target));
        if (target >= end) {
            return result;
        }
        try {
            lines = await read(target, end);
        } catch (err) {
            if (!isUnmappedAddress(err)) {
                throw err;
            }
            return result;
        }
    }
    return [...result, ...lines];
}

/**
 * Tries start addresses up to 15 bytes after `start`, returns the first
 * decoding that has an instruction start at `target`.
 */
async function findLanding(
    read: Reader,
    start: bigint,
    end: bigint,
    target: bigint,
): Promise<DisassemblyLine[] | undefined> {
    for (let shift = 1; shift < MAX_INSTRUCTION_BYTES; shift++) {
        const from = start + BigInt(shift);
        if (from >= target) {
            break;
        }
        try {
            const lines = await read(from, end);
            if (lines.some((line) => endOf(line) === target)) {
                return lines;
            }
        } catch (err) {
            if (!isUnmappedAddress(err)) {
                throw err;
            }
        }
    }
    return undefined;
}

function runsOver(lines: DisassemblyLine[], target: bigint): boolean {
    return lines.some((line) => addressOf(line) < target && target < endOf(line));
}

function isUnmappedAddress(err: unknown): boolean {
    return err instanceof TcfError && /no translation for address/i.test(err.message);
}

/**
 * Returns the lines that start in [start, end). The TCF agent decodes from
 * the start of the function or line area containing the requested address
 * and stops at its end, so requests continue where the previous reply ended.
 * Only an unreadable `start` throws, later unreadable memory ends the lines.
 */
async function readLines(source: LineSource, start: bigint, end: bigint): Promise<DisassemblyLine[]> {
    const { service, contextId, cache } = source;
    await cache?.check(contextId, start, end);
    const lines: DisassemblyLine[] = [];
    let from = start;
    for (let reads = 0; reads < MAX_READS && from < end; reads++) {
        let kept = cache?.get(contextId, from, end);
        if (!kept) {
            const generation = cache?.current ?? 0;
            let reply: DisassemblyLine[];
            try {
                reply = await service.disassemble(contextId, from, Number(end - from));
            } catch (err) {
                if (reads === 0 || !isUnmappedAddress(err)) {
                    throw err;
                }
                break;
            }
            const next = from;
            kept = reply.filter((line) => {
                const address = toBigInt(line.Address);
                return address !== undefined && address >= next && address < end;
            });
            cache?.set(contextId, from, kept, generation);
        }
        if (kept.length === 0) {
            break;
        }
        lines.push(...kept);
        from = endOf(kept.at(-1)!);
    }
    return lines;
}

/** Reads [start, end), halving the size while the end is unreadable. */
async function disassembleMappedRange(source: LineSource, start: bigint, end: bigint): Promise<DisassemblyLine[]> {
    let bytes = end - start;
    while (true) {
        try {
            return await readLines(source, start, start + bytes);
        } catch (err) {
            if (!isUnmappedAddress(err) || bytes === 1n) {
                throw err;
            }
            bytes = bytes > 2n ? bytes / 2n : 1n;
        }
    }
}

function addressOf(line: DisassemblyLine): bigint {
    return toBigInt(line.Address)!;
}

function endOf(line: DisassemblyLine): bigint {
    const size = Number.isSafeInteger(line.Size) && line.Size > 0 ? line.Size : 1;
    return addressOf(line) + BigInt(size);
}

function toDapInstruction(line: DisassemblyLine): DebugProtocol.DisassembledInstruction {
    const instruction =
        line.Instruction?.map(
            (field) => field.Text ?? (field.Value !== undefined ? formatAddress(BigInt(field.Value)) : ""),
        ).join("") || "??";
    const bytes = line.OpcodeValue
        ? Buffer.from(line.OpcodeValue, "base64").toString("hex").match(/../g)?.join(" ")
        : undefined;
    return {
        address: formatAddress(BigInt(line.Address)),
        instruction,
        instructionBytes: bytes,
        presentationHint: instruction === "??" ? "invalid" : "normal",
    };
}

function formatAddress(address: bigint): string {
    return `0x${address.toString(16)}`;
}
