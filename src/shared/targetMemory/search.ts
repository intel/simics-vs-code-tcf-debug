/*
 * Memory search used by the debug adapter for the Target Memory view. The
 * agent has no search command, so the range is read in chunks and searched
 * here. Only addresses that are a multiple of the alignment are tried, and
 * several reads are kept in flight to hide the round trip time.
 *
 * No vscode or TCF imports, so this can be unit tested.
 */

import { alignDown, alignUp } from "./format";

export type SearchDirection = "forward" | "backward";

export const DEFAULT_CHUNK_SIZE = 0x10000;
export const DEFAULT_MAX_IN_FLIGHT = 4;

/** One read of a scan. */
export interface ScanChunk {
    /** First byte to read, also the first candidate match address. */
    address: bigint;
    length: number;
    /** Last candidate match address in the chunk. */
    last: bigint;
}

/**
 * The chunks to read to find a needle of `needleLength` bytes in
 * [start, end] (inclusive) at addresses that are a multiple of `alignment`,
 * in search order. A match must lie entirely within the range. Chunks are at
 * most `chunkSize` bytes and overlap so that no candidate is missed.
 */
export function* planChunks(
    start: bigint,
    end: bigint,
    needleLength: number,
    alignment: number,
    chunkSize: number,
    direction: SearchDirection,
): Generator<ScanChunk> {
    if (needleLength <= 0 || chunkSize < needleLength || alignment < 1) {
        return;
    }
    const a = BigInt(alignment);
    const n = BigInt(needleLength);
    if (end < start || end - start + 1n < n) {
        return;
    }
    const firstCand = alignUp(start, a);
    const lastCand = alignDown(end - n + 1n, a);
    if (firstCand > lastCand) {
        return;
    }
    // Largest distance between the first and last candidate of a chunk.
    const span = alignDown(BigInt(chunkSize) - n, a);
    const chunk = (c0: bigint, c1: bigint): ScanChunk => ({
        address: c0,
        length: Number(c1 - c0 + n),
        last: c1,
    });
    if (direction === "forward") {
        for (let c0 = firstCand; c0 <= lastCand;) {
            const c1 = c0 + span < lastCand ? c0 + span : lastCand;
            yield chunk(c0, c1);
            c0 = c1 + a;
        }
    } else {
        for (let c1 = lastCand; c1 >= firstCand;) {
            const c0 = c1 - span > firstCand ? c1 - span : firstCand;
            yield chunk(c0, c1);
            c1 = c0 - a;
        }
    }
}

/**
 * Offset of the first match in a chunk in search order, or -1. Bytes that
 * are not valid (valid[i] == 0) or missing never match.
 */
export function findInChunk(
    bytes: Uint8Array,
    valid: Uint8Array | undefined,
    needle: Uint8Array,
    chunk: ScanChunk,
    alignment: number,
    direction: SearchDirection,
): number {
    const count = Number((chunk.last - chunk.address) / BigInt(alignment)) + 1;
    for (let k = 0; k < count; k++) {
        const i = direction === "forward" ? k : count - 1 - k;
        const offset = i * alignment;
        if (matchesAt(bytes, valid, needle, offset)) {
            return offset;
        }
    }
    return -1;
}

function matchesAt(bytes: Uint8Array, valid: Uint8Array | undefined, needle: Uint8Array, offset: number): boolean {
    if (offset + needle.length > bytes.length) {
        return false;
    }
    for (let j = 0; j < needle.length; j++) {
        if (bytes[offset + j] !== needle[j] || (valid && !valid[offset + j])) {
            return false;
        }
    }
    return true;
}

export interface ScanRead {
    bytes: Uint8Array;
    /** 1 for each byte that could be read, undefined if all could. */
    valid?: Uint8Array;
}

export interface ScanOptions {
    needle: Uint8Array;
    alignment: number;
    /** First address of the range. */
    start: bigint;
    /** Last address of the range, inclusive. */
    end: bigint;
    direction: SearchDirection;
    read(address: bigint, length: number): Promise<ScanRead>;
    chunkSize?: number;
    maxInFlight?: number;
    isCancelled?(): boolean;
    /** Called after each chunk with the address the scan has reached. */
    onProgress?(address: bigint): void;
}

export type ScanResult =
    | { outcome: "found"; address: bigint }
    | { outcome: "notFound"; failedReads: number; firstError?: string }
    | { outcome: "cancelled" };

export async function scanMemory(options: ScanOptions): Promise<ScanResult> {
    const { needle, alignment, direction } = options;
    const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    const chunks = planChunks(
        options.start,
        options.end,
        needle.length,
        alignment,
        options.chunkSize ?? DEFAULT_CHUNK_SIZE,
        direction,
    );
    const queue: { chunk: ScanChunk; result: Promise<ScanRead | Error> }[] = [];
    const fill = () => {
        while (queue.length < maxInFlight) {
            const next = chunks.next();
            if (next.done) {
                return;
            }
            const chunk = next.value;
            queue.push({
                chunk,
                // Errors are values here, so that reads still in flight when
                // the scan ends are not unhandled rejections.
                result: options.read(chunk.address, chunk.length).then(
                    (r) => r,
                    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
                ),
            });
        }
    };
    const cancelled = () => options.isCancelled?.() === true;

    let failedReads = 0;
    let firstError: string | undefined;
    fill();
    for (let item = queue.shift(); item; item = queue.shift()) {
        if (cancelled()) {
            return { outcome: "cancelled" };
        }
        const read = await item.result;
        if (cancelled()) {
            return { outcome: "cancelled" };
        }
        fill();
        const { chunk } = item;
        if (read instanceof Error) {
            failedReads++;
            firstError ??= read.message;
        } else {
            const offset = findInChunk(read.bytes, read.valid, needle, chunk, alignment, direction);
            if (offset >= 0) {
                return {
                    outcome: "found",
                    address: chunk.address + BigInt(offset),
                };
            }
        }
        options.onProgress?.(direction === "forward" ? chunk.address + BigInt(chunk.length) : chunk.address);
    }
    return { outcome: "notFound", failedReads, firstError };
}
