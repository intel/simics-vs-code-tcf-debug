import { alignDown, hexString as hex } from "../../shared/targetMemory/format";
import type { FromWebview, ToWebview } from "../../shared/targetMemory/protocol";

export const BLOCK_SIZE = 1024;
const BLOCK = BigInt(BLOCK_SIZE);
/** Blocks kept, the ones used least recently are dropped. */
const MAX_BLOCKS = 512;

export const enum ByteState {
    Loading,
    Ok,
    Unreadable,
}

interface Block {
    bytes?: Uint8Array;
    /** 1 for each byte that could be read. */
    valid?: Uint8Array;
    /** 1 for each byte that changed when the block was last read again. */
    changed?: Uint8Array;
    error?: string;
    /** Must be read (again). */
    stale: boolean;
    loading: boolean;
    /** Sequence number of the last read request, older replies are ignored. */
    seq: number;
    used: number;
}

export interface BytesView {
    values: (number | undefined)[];
    states: ByteState[];
    changed: boolean[];
}

/**
 * The bytes read from the target, in blocks requested from the extension
 * when they are shown. When memory is read again (after the target ran, for
 * example), the bytes that changed are remembered so they can be
 * highlighted.
 */
export class MemoryCache {
    private readonly blocks = new Map<bigint, Block>();
    private seq = 0;
    private clock = 0;
    private epoch = 0;
    private version = 0;
    private readonly listeners = new Set<() => void>();

    constructor(private readonly send: (m: FromWebview) => void) {}

    readonly subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    };

    readonly getVersion = (): number => this.version;

    /** Another context is shown: forget everything. */
    reset(epoch: number): void {
        this.epoch = epoch;
        this.blocks.clear();
        this.notify();
    }

    /** Memory may have changed: read the blocks again when they are shown. */
    invalidate(): void {
        for (const b of this.blocks.values()) {
            b.stale = true;
            // A reply that is on its way may be from before the change.
            b.loading = false;
        }
        this.notify();
    }

    /** Requests the blocks covering [start, end) that are not loaded. */
    request(start: bigint, end: bigint, canRead: boolean, max: bigint): void {
        const used = ++this.clock;
        for (let base = alignDown(start < 0n ? 0n : start, BLOCK); base < end && base <= max; base += BLOCK) {
            let b = this.blocks.get(base);
            if (!b) {
                b = { stale: true, loading: false, seq: 0, used };
                this.blocks.set(base, b);
            }
            b.used = used;
            if (canRead && b.stale && !b.loading) {
                b.loading = true;
                b.seq = ++this.seq;
                this.send({
                    type: "read",
                    epoch: this.epoch,
                    seq: b.seq,
                    address: hex(base),
                    length: BLOCK_SIZE,
                });
            }
        }
        if (this.blocks.size > MAX_BLOCKS + 64) {
            const byAge = [...this.blocks.entries()].sort((a, b) => a[1].used - b[1].used);
            for (const [base] of byAge.slice(0, this.blocks.size - MAX_BLOCKS)) {
                this.blocks.delete(base);
            }
        }
    }

    handle(m: ToWebview): void {
        if (m.type !== "data" && m.type !== "readError") {
            return;
        }
        const b = this.blocks.get(BigInt(m.address));
        if (m.epoch !== this.epoch || !b || b.seq !== m.seq) {
            return;
        }
        b.loading = false;
        b.stale = false;
        if (m.type === "readError") {
            b.bytes = undefined;
            b.valid = undefined;
            b.changed = undefined;
            b.error = m.error;
        } else {
            const bytes = Uint8Array.from(m.bytes);
            const valid = new Uint8Array(bytes.length).fill(1);
            for (const r of m.unreadable) {
                valid.fill(0, r.offset, r.offset + r.size);
            }
            const old = b.bytes;
            const oldValid = b.valid;
            if (old && oldValid) {
                const changed = new Uint8Array(bytes.length);
                let any = false;
                for (let i = 0; i < bytes.length && i < old.length; i++) {
                    if (valid[i] && oldValid[i] && bytes[i] !== old[i]) {
                        changed[i] = 1;
                        any = true;
                    }
                }
                b.changed = any ? changed : undefined;
            }
            b.bytes = bytes;
            b.valid = valid;
            b.error = undefined;
        }
        this.notify();
    }

    /** The `count` bytes at `address`. */
    read(address: bigint, count: number): BytesView {
        const view: BytesView = { values: [], states: [], changed: [] };
        let base = -1n;
        let b: Block | undefined;
        for (let i = 0; i < count; i++) {
            const a = address + BigInt(i);
            const blockBase = alignDown(a, BLOCK);
            if (blockBase !== base) {
                base = blockBase;
                b = this.blocks.get(base);
            }
            const offset = Number(a - base);
            if (!b?.bytes || !b.valid) {
                view.values.push(undefined);
                view.states.push(b?.error !== undefined ? ByteState.Unreadable : ByteState.Loading);
                view.changed.push(false);
            } else if (b.valid[offset]) {
                view.values.push(b.bytes[offset]);
                view.states.push(ByteState.Ok);
                view.changed.push(b.changed?.[offset] === 1);
            } else {
                view.values.push(undefined);
                view.states.push(ByteState.Unreadable);
                view.changed.push(false);
            }
        }
        return view;
    }

    /** Why the block at `address` could not be read, if it could not. */
    error(address: bigint): string | undefined {
        return this.blocks.get(alignDown(address, BLOCK))?.error;
    }

    private notify(): void {
        this.version++;
        this.listeners.forEach((fn) => fn());
    }
}
