import { TcfChannel, TcfError, formatTcfError } from "../channel";
import { toBigInt } from "../json";

/** Memory context properties, see TCF Services -> Memory. */
export interface MemoryContext {
    ID: string;
    ParentID?: string;
    ProcessID?: string;
    BigEndian?: boolean;
    AddressSize?: number;
    Name?: string;
    StartBound?: bigint | number;
    EndBound?: bigint | number;
    /** For example "instruction", "data", "virtual" and "physical". */
    AccessTypes?: string[];
    [key: string]: unknown;
}

/** Memory access mode bits, see TCF Services -> Memory -> get. */
export const enum MemoryAccessMode {
    ContinueOnError = 0x01,
    Verify = 0x02,
    BypassAddressCheck = 0x04,
    BypassCacheSync = 0x08,
    DontStop = 0x10,
    BlockMemoryMappedIO = 0x20,
}

export interface AddressRange {
    addr: bigint;
    size: number;
}

/** A byte range relative to the start address of a read. */
export interface ByteRange {
    offset: number;
    size: number;
}

export interface MemoryReadResult {
    bytes: Buffer;
    /** Ranges that could not be read, only reported with MemoryAccessMode.ContinueOnError. */
    unreadable: ByteRange[];
}

export interface MemoryListener {
    contextAdded?(contexts: MemoryContext[]): void;
    contextChanged?(contexts: MemoryContext[]): void;
    contextRemoved?(ids: string[]): void;
    memoryChanged?(id: string, ranges: AddressRange[]): void;
}

export class MemoryService {
    static readonly NAME = "Memory";

    constructor(private readonly channel: TcfChannel) {}

    async getChildren(parentId: string | null): Promise<string[]> {
        const [ids] = await this.channel.command(MemoryService.NAME, "getChildren", parentId);
        return Array.isArray(ids) ? (ids as string[]) : [];
    }

    async getContext(id: string): Promise<MemoryContext> {
        const [ctx] = await this.channel.command(MemoryService.NAME, "getContext", id);
        return ctx as MemoryContext;
    }

    /** Reads `size` bytes at `address`. The reply has the data before the error report. */
    async get(id: string, address: bigint, wordSize: number, size: number, mode: number): Promise<MemoryReadResult> {
        const [data, error, errorAddresses] = await this.channel.sendCommand(MemoryService.NAME, "get", [
            id,
            address,
            wordSize,
            size,
            mode,
        ]);
        const hasError = error !== null && error !== undefined;
        if (typeof data !== "string" || (hasError && data.length === 0)) {
            throw new TcfError(
                `${MemoryService.NAME}.get: ${hasError ? formatTcfError(error) : "no data"}`,
                undefined,
                error,
            );
        }
        const bytes = Buffer.from(data, "base64");
        return { bytes, unreadable: hasError ? unreadableRanges(address, bytes.length, errorAddresses) : [] };
    }

    async set(id: string, address: bigint, wordSize: number, bytes: Uint8Array, mode: number): Promise<void> {
        await this.channel.command(
            MemoryService.NAME,
            "set",
            id,
            address,
            wordSize,
            bytes.length,
            mode,
            Buffer.from(bytes).toString("base64"),
        );
    }

    addListener(l: MemoryListener): void {
        const on = (event: string, fn: (args: unknown[]) => void) =>
            this.channel.onEvent(MemoryService.NAME, event, fn);
        on("contextAdded", (a) => l.contextAdded?.(asArray(a[0])));
        on("contextChanged", (a) => l.contextChanged?.(asArray(a[0])));
        on("contextRemoved", (a) => l.contextRemoved?.(asArray(a[0])));
        on("memoryChanged", (a) =>
            l.memoryChanged?.(
                a[0] as string,
                asArray<Record<string, unknown>>(a[1]).flatMap((r) => {
                    const addr = toBigInt(r.addr);
                    return addr !== undefined && typeof r.size === "number" ? [{ addr, size: r.size }] : [];
                }),
            ),
        );
    }
}

/**
 * Converts the error addresses of a failed read into unreadable ranges. Bytes
 * that no error address covers inherit the status of the main error report.
 */
function unreadableRanges(address: bigint, length: number, errorAddresses: unknown): ByteRange[] {
    const valid = new Uint8Array(length);
    for (const ea of asArray<Record<string, unknown>>(errorAddresses)) {
        const start = toBigInt(ea.addr);
        if (start === undefined || typeof ea.size !== "number" || ea.stat !== 0) {
            continue;
        }
        const from = start > address ? Number(start - address) : 0;
        const to = Math.min(length, Number(start + BigInt(ea.size) - address));
        valid.fill(1, from, Math.max(from, to));
    }
    const ranges: ByteRange[] = [];
    for (let i = 0; i < length; i++) {
        if (valid[i]) {
            continue;
        }
        const offset = i;
        while (i < length && !valid[i]) {
            i++;
        }
        ranges.push({ offset, size: i - offset });
    }
    return ranges;
}

function asArray<T>(v: unknown): T[] {
    return Array.isArray(v) ? (v as T[]) : [];
}
