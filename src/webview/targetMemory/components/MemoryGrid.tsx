import * as React from "react";
import { flushSync } from "react-dom";
import {
    alignDown,
    asciiChar,
    formatAddress,
    formatGroup,
    formatHex,
    groupByteOffset,
    hexString,
    setNibble,
    type Endianness,
} from "@/shared/targetMemory/format";
import { ByteState, type MemoryCache } from "@/webview/targetMemory/memoryCache";

export const ROW_HEIGHT = 20;
/**
 * Rows in the scrollable area. The address space is too large for one
 * scroll area, so this window is moved when the view gets close to an edge.
 */
const WINDOW_ROWS = 1 << 16;
const EDGE_ROWS = 1 << 11;

export type Pane = "hex" | "text";

export interface Selection {
    anchor: bigint;
    /** The byte (text) or group (hex) with the keyboard focus. */
    cursor: bigint;
    pane: Pane;
    /** The hex digit of the cursor group that is typed next. */
    nibble: number;
}

/** First and last byte of the selection. */
export function selectionRange(sel: Selection, groupSize: number): [bigint, bigint] {
    let lo = sel.anchor < sel.cursor ? sel.anchor : sel.cursor;
    let hi = sel.anchor < sel.cursor ? sel.cursor : sel.anchor;
    if (sel.pane === "hex") {
        const g = BigInt(groupSize);
        lo = alignDown(lo, g);
        hi = alignDown(hi, g) + g - 1n;
    }
    return [lo, hi];
}

export interface GridHandle {
    /** Scrolls to an address, centered unless it is visible already. */
    reveal(address: bigint): void;
    focus(): void;
}

interface GridProps {
    cache: MemoryCache;
    cacheVersion: number;
    maxAddress: bigint;
    addressSize: number;
    groupSize: number;
    endianness: Endianness;
    bytesPerRow: number;
    canRead: boolean;
    canWrite: boolean;
    dimmed: boolean;
    selection: Selection | undefined;
    onSelection(selection: Selection): void;
    pending: ReadonlyMap<string, number>;
    onPending(pending: Map<string, number>): void;
    onApply(): void;
    onDiscard(): void;
    onEditBlocked(): void;
    onTopAddress(address: bigint): void;
    onCopy(): void;
}

export const MemoryGrid = React.forwardRef<GridHandle, GridProps>(function MemoryGrid(props, ref) {
    const { cache, cacheVersion, maxAddress, groupSize, bytesPerRow, selection, pending } = props;
    const bpr = BigInt(bytesPerRow);
    const totalRows = (maxAddress + 1n) / bpr;
    const windowRows = totalRows < BigInt(WINDOW_ROWS) ? Number(totalRows) : WINDOW_ROWS;
    const maxBase = (totalRows - BigInt(windowRows)) * bpr;

    const scrollRef = React.useRef<HTMLDivElement>(null);
    // Address of the first row of the window, undefined until an
    // address is shown.
    const [base, setBase] = React.useState<bigint | undefined>();
    const [scrollTop, setScrollTop] = React.useState(0);
    const [height, setHeight] = React.useState(400);

    const clampBase = (b: bigint): bigint => {
        const aligned = b < 0n ? 0n : alignDown(b, bpr);
        return aligned > maxBase ? maxBase : aligned;
    };

    /**
     * Scrolls an address into view: just enough for keyboard moves, or
     * centered (a third from the top) if `center` and it is not visible.
     */
    const scrollTo = (address: bigint, center: boolean) => {
        const row = alignDown(address > maxAddress ? maxAddress : address, bpr);
        let b = base;
        const idxIn = (x: bigint) => Number((row - x) / bpr);
        if (
            b === undefined ||
            row < b ||
            (idxIn(b) < EDGE_ROWS && b > 0n) ||
            idxIn(b) >= windowRows ||
            (idxIn(b) > windowRows - EDGE_ROWS && b < maxBase)
        ) {
            b = clampBase(row - BigInt(windowRows / 2) * bpr);
            center = true;
            const nb = b;
            flushSync(() => setBase(nb));
        }
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        const idx = idxIn(b);
        let top = el.scrollTop;
        const above = idx * ROW_HEIGHT < top;
        const below = (idx + 1) * ROW_HEIGHT > top + el.clientHeight;
        if (center && (above || below || b !== base)) {
            top = idx * ROW_HEIGHT - Math.floor(el.clientHeight / 3);
        } else if (above) {
            top = idx * ROW_HEIGHT;
        } else if (below) {
            top = (idx + 1) * ROW_HEIGHT - el.clientHeight;
        }
        el.scrollTop = Math.max(0, top);
        setScrollTop(el.scrollTop);
    };
    const scrollToRef = React.useRef(scrollTo);
    scrollToRef.current = scrollTo;

    React.useImperativeHandle(
        ref,
        () => ({
            reveal: (address) => scrollToRef.current(address, true),
            focus: () => scrollRef.current?.focus(),
        }),
        [],
    );

    // Keep the top address when the number of bytes per row changes.
    const lastLayout = React.useRef({
        bpr,
        top: undefined as bigint | undefined,
    });
    React.useLayoutEffect(() => {
        const last = lastLayout.current;
        if (last.bpr !== bpr && last.top !== undefined && base !== undefined) {
            const nb = clampBase(last.top - BigInt(windowRows / 2) * bpr);
            const idx = Number((alignDown(last.top, bpr) - nb) / bpr);
            setBase(nb);
            const el = scrollRef.current;
            if (el) {
                el.scrollTop = idx * ROW_HEIGHT;
                setScrollTop(el.scrollTop);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bpr]);

    React.useEffect(() => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        const observer = new ResizeObserver(() => setHeight(el.clientHeight));
        observer.observe(el);
        setHeight(el.clientHeight);
        return () => observer.disconnect();
    }, [base === undefined]);

    const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        let top = el.scrollTop;
        const idx = Math.floor(top / ROW_HEIGHT);
        const visible = Math.ceil(el.clientHeight / ROW_HEIGHT);
        if (base !== undefined) {
            let shift = 0n;
            if (idx < EDGE_ROWS && base > 0n) {
                const room = base / bpr;
                shift = -(room < BigInt(windowRows / 2) ? room : BigInt(windowRows / 2));
            } else if (idx > windowRows - EDGE_ROWS - visible && base < maxBase) {
                const room = (maxBase - base) / bpr;
                shift = room < BigInt(windowRows / 2) ? room : BigInt(windowRows / 2);
            }
            if (shift !== 0n) {
                const nb = base + shift * bpr;
                flushSync(() => setBase(nb));
                top -= Number(shift) * ROW_HEIGHT;
                el.scrollTop = top;
            }
        }
        setScrollTop(el.scrollTop);
    };

    const first = Math.floor(scrollTop / ROW_HEIGHT);
    const count = Math.ceil(height / ROW_HEIGHT) + 1;
    const rowAddress = (i: number) => (base === undefined ? 0n : base + BigInt(i) * bpr);
    const topAddress = base === undefined ? undefined : rowAddress(first);
    // Read by the effect above when bytesPerRow changes, so it is
    // updated after it.
    React.useLayoutEffect(() => {
        lastLayout.current = { bpr, top: topAddress };
    });

    // Read what is shown, and a page above and below.
    React.useEffect(() => {
        if (base === undefined) {
            return;
        }
        const page = BigInt(count) * bpr;
        const start = rowAddress(first);
        cache.request(start - page, start + 2n * page, props.canRead, maxAddress);
    });

    React.useEffect(() => {
        if (topAddress !== undefined) {
            props.onTopAddress(topAddress);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [topAddress]);

    // ---- Mouse --------------------------------------------------------

    const dragging = React.useRef(false);
    const hit = (e: React.MouseEvent): { a: bigint; p: Pane } | undefined => {
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
        return el?.dataset.a
            ? {
                  a: BigInt(`0x${el.dataset.a}`),
                  p: el.dataset.p === "t" ? "text" : "hex",
              }
            : undefined;
    };
    /** The hex digit of a group under the mouse, 0 in the text column. */
    const digitAt = (e: React.MouseEvent): number => {
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
        if (!el || el.dataset.p === "t") {
            return 0;
        }
        const rect = el.getBoundingClientRect();
        const digits = 2 * groupSize;
        const d = Math.floor(((e.clientX - rect.left) / rect.width) * digits);
        return Math.min(digits - 1, Math.max(0, d));
    };
    const onMouseDown = (e: React.MouseEvent) => {
        const h = hit(e);
        if (!h) {
            return;
        }
        if (e.button === 2) {
            selectForMenu(h);
            return;
        } else if (e.button !== 0) {
            return;
        }
        const extend = e.shiftKey && selection !== undefined;
        props.onSelection({
            anchor: extend ? selection.anchor : h.a,
            cursor: h.a,
            pane: h.p,
            nibble: extend ? 0 : digitAt(e),
        });
        dragging.current = true;
    };
    /** Right click selects the entry, unless it is in the selection. */
    const selectForMenu = (h: { a: bigint; p: Pane }) => {
        if (selection) {
            const [lo, hi] = selectionRange(selection, groupSize);
            if (h.a >= lo && h.a <= hi) {
                return;
            }
        }
        props.onSelection({
            anchor: h.a,
            cursor: h.a,
            pane: h.p,
            nibble: 0,
        });
    };
    const onContextMenu = (e: React.MouseEvent) => {
        const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
        const h = hit(e);
        if (!cell || !h) {
            return;
        }
        // VS Code passes this to the menu commands, so they act on the
        // entry that was right-clicked whether or not the selection
        // was updated in time.
        cell.setAttribute("data-vscode-context", JSON.stringify({ address: hexString(h.a), pane: h.p }));
        selectForMenu(h);
    };
    const onMouseMove = (e: React.MouseEvent) => {
        if (!dragging.current || !selection || (e.buttons & 1) === 0) {
            dragging.current = false;
            return;
        }
        const h = hit(e);
        if (h && h.p === selection.pane && h.a !== selection.cursor) {
            props.onSelection({ ...selection, cursor: h.a, nibble: 0 });
        }
    };

    // ---- Keyboard -----------------------------------------------------

    const onKeyDown = (e: React.KeyboardEvent) => {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key.toLowerCase() === "c") {
            e.preventDefault();
            props.onCopy();
            return;
        }
        if (e.key === "Enter" && pending.size > 0) {
            e.preventDefault();
            props.onApply();
            return;
        }
        if (e.key === "Escape" && pending.size > 0) {
            e.preventDefault();
            props.onDiscard();
            return;
        }
        let sel = selection;
        if (!sel) {
            if (topAddress === undefined) {
                return;
            }
            sel = {
                anchor: topAddress,
                cursor: topAddress,
                pane: "hex",
                nibble: 0,
            };
        }
        const g = BigInt(groupSize);
        const step = sel.pane === "hex" ? g : 1n;
        const page = BigInt(Math.max(1, count - 2)) * bpr;
        const last = alignDown(maxAddress, step);
        const digits = 2 * groupSize;
        const nibble = nibbleOf(sel);
        const moveTo = (to: bigint, extend: boolean, pane = sel.pane, toNibble = 0) => {
            let c = to < 0n ? 0n : to > last ? last : to;
            if (pane === "hex") {
                c = alignDown(c, g);
            }
            props.onSelection({
                anchor: extend ? sel.anchor : c,
                cursor: c,
                pane,
                nibble: extend || pane !== "hex" ? 0 : toNibble,
            });
            scrollTo(c, false);
        };
        // In the hex column, Left and Right move by digit; with Ctrl or
        // Shift (extending the selection) by group.
        const byDigit = sel.pane === "hex" && !e.shiftKey && !ctrl;
        const groupStart = alignDown(sel.cursor, g);
        const rowStart = alignDown(sel.cursor, bpr);
        const handled = (() => {
            switch (e.key) {
                case "ArrowLeft":
                    if (byDigit && nibble > 0) {
                        moveTo(groupStart, false, "hex", nibble - 1);
                    } else if (byDigit) {
                        if (groupStart >= g) {
                            moveTo(groupStart - g, false, "hex", digits - 1);
                        }
                    } else {
                        moveTo(sel.cursor - step, e.shiftKey);
                    }
                    return true;
                case "ArrowRight":
                    if (byDigit && nibble < digits - 1) {
                        moveTo(groupStart, false, "hex", nibble + 1);
                    } else if (byDigit) {
                        if (groupStart < last) {
                            moveTo(groupStart + g, false, "hex", 0);
                        }
                    } else {
                        moveTo(sel.cursor + step, e.shiftKey);
                    }
                    return true;
                case "ArrowUp":
                    moveTo(sel.cursor - bpr, e.shiftKey, sel.pane, nibble);
                    return true;
                case "ArrowDown":
                    moveTo(sel.cursor + bpr, e.shiftKey, sel.pane, nibble);
                    return true;
                case "PageUp":
                    moveTo(sel.cursor - page, e.shiftKey, sel.pane, nibble);
                    return true;
                case "PageDown":
                    moveTo(sel.cursor + page, e.shiftKey, sel.pane, nibble);
                    return true;
                case "Home":
                    moveTo(rowStart, e.shiftKey);
                    return true;
                case "End":
                    moveTo(rowStart + bpr - step, e.shiftKey, sel.pane, digits - 1);
                    return true;
                case "Tab":
                    moveTo(sel.cursor, false, sel.pane === "hex" ? "text" : "hex");
                    return true;
                case "Escape":
                    moveTo(sel.cursor, false, sel.pane, nibble);
                    return true;
                case "Backspace":
                    backspace(sel);
                    return true;
            }
            if (ctrl || e.altKey || e.key.length !== 1) {
                return false;
            }
            if (sel.pane === "hex" && /^[0-9a-fA-F]$/.test(e.key)) {
                typeNibble(sel, Number.parseInt(e.key, 16));
                return true;
            }
            const code = e.key.charCodeAt(0);
            if (sel.pane === "text" && code >= 0x20 && code < 0x7f) {
                typeByte(sel, code);
                return true;
            }
            return false;
        })();
        if (handled) {
            e.preventDefault();
        }
    };

    const original = (address: bigint) => cache.read(address, 1).values[0];
    const setByte = (address: bigint, value: number | undefined) => {
        const key = address.toString(16);
        const next = new Map(pending);
        if (value === undefined || value === original(address)) {
            next.delete(key);
        } else {
            next.set(key, value);
        }
        props.onPending(next);
    };
    const nibbleByte = (groupAddress: bigint, nibble: number) =>
        groupAddress + BigInt(groupByteOffset(nibble >> 1, groupSize, props.endianness));

    // The digit of the cursor group, 0 if the group size changed.
    const nibbleOf = (sel: Selection) => (sel.nibble < 2 * groupSize ? sel.nibble : 0);

    const typeNibble = (sel: Selection, digit: number) => {
        if (!props.canWrite) {
            props.onEditBlocked();
            return;
        }
        const groupAddress = alignDown(sel.cursor, BigInt(groupSize));
        const address = nibbleByte(groupAddress, nibbleOf(sel));
        const current = pending.get(address.toString(16)) ?? original(address);
        if (current === undefined) {
            return;
        }
        setByte(address, setNibble(current, (nibbleOf(sel) & 1) as 0 | 1, digit));
        let nibble = nibbleOf(sel) + 1;
        let cursor = groupAddress;
        if (nibble >= 2 * groupSize) {
            nibble = 0;
            if (groupAddress + BigInt(groupSize) <= maxAddress) {
                cursor = groupAddress + BigInt(groupSize);
            }
        }
        props.onSelection({ anchor: cursor, cursor, pane: "hex", nibble });
        scrollTo(cursor, false);
    };

    const typeByte = (sel: Selection, value: number) => {
        if (!props.canWrite) {
            props.onEditBlocked();
            return;
        }
        if (original(sel.cursor) === undefined) {
            return;
        }
        setByte(sel.cursor, value);
        const cursor = sel.cursor < maxAddress ? sel.cursor + 1n : sel.cursor;
        props.onSelection({
            anchor: cursor,
            cursor,
            pane: "text",
            nibble: 0,
        });
        scrollTo(cursor, false);
    };

    /**
     * Moves back one digit (hex) or byte (text) and undoes its edit:
     * in hex only that digit gets its original value back.
     */
    const backspace = (sel: Selection) => {
        let cursor = sel.cursor;
        let nibble = nibbleOf(sel) - 1;
        if (sel.pane === "hex") {
            const g = BigInt(groupSize);
            cursor = alignDown(cursor, g);
            if (nibble < 0) {
                if (cursor < g) {
                    return;
                }
                cursor -= g;
                nibble = 2 * groupSize - 1;
            }
            const address = nibbleByte(cursor, nibble);
            const orig = original(address);
            const current = pending.get(address.toString(16));
            if (orig !== undefined && current !== undefined) {
                const digit = nibble & 1 ? orig & 0x0f : orig >> 4;
                setByte(address, setNibble(current, (nibble & 1) as 0 | 1, digit));
            }
        } else {
            if (cursor === 0n) {
                return;
            }
            cursor -= 1n;
            nibble = 0;
            setByte(cursor, undefined);
        }
        props.onSelection({
            anchor: cursor,
            cursor,
            pane: sel.pane,
            nibble,
        });
        scrollTo(cursor, false);
    };

    // ---- Rendering ----------------------------------------------------

    if (base === undefined) {
        return <div className="grid-empty">Enter an address or expression above to show memory.</div>;
    }

    const range = selection && selectionRange(selection, groupSize);
    const rows: React.ReactNode[] = [];
    for (let i = first; i < first + count && i < windowRows; i++) {
        const address = rowAddress(i);
        rows.push(
            <Row
                key={address.toString(16)}
                top={i * ROW_HEIGHT}
                address={address}
                cache={cache}
                cacheVersion={cacheVersion}
                addressSize={props.addressSize}
                groupSize={groupSize}
                endianness={props.endianness}
                bytesPerRow={bytesPerRow}
                pending={pending}
                selLo={range?.[0]}
                selHi={range?.[1]}
                cursor={selection?.cursor}
                pane={selection?.pane}
                nibble={selection?.nibble ?? 0}
            />,
        );
    }

    return (
        <div
            ref={scrollRef}
            className={`grid${props.dimmed ? " dimmed" : ""}`}
            tabIndex={0}
            onScroll={onScroll}
            onKeyDown={onKeyDown}
            onMouseDown={onMouseDown}
            onContextMenu={onContextMenu}
            onMouseMove={onMouseMove}
            onMouseUp={() => (dragging.current = false)}
            data-vscode-context={JSON.stringify({
                webviewSection: "grid",
                preventDefaultContextMenuItems: true,
            })}
        >
            <div
                style={{
                    height: windowRows * ROW_HEIGHT,
                    position: "relative",
                }}
            >
                {rows}
            </div>
        </div>
    );
});

interface RowProps {
    top: number;
    address: bigint;
    cache: MemoryCache;
    cacheVersion: number;
    addressSize: number;
    groupSize: number;
    endianness: Endianness;
    bytesPerRow: number;
    pending: ReadonlyMap<string, number>;
    selLo?: bigint;
    selHi?: bigint;
    cursor?: bigint;
    pane?: Pane;
    nibble: number;
}

const Row = React.memo(function Row(p: RowProps) {
    const view = p.cache.read(p.address, p.bytesPerRow);
    const g = p.groupSize;
    const inSel = (a: bigint) => p.selLo !== undefined && p.selHi !== undefined && a >= p.selLo && a <= p.selHi;
    const groups: React.ReactNode[] = [];
    const chars: React.ReactNode[] = [];
    let error: string | undefined;
    for (let i = 0; i < p.bytesPerRow; i += g) {
        const groupAddress = p.address + BigInt(i);
        const bytes: (number | undefined)[] = [];
        let state = "";
        for (let j = i; j < i + g; j++) {
            const a = p.address + BigInt(j);
            const edited = p.pending.get(a.toString(16));
            const value = edited ?? view.values[j];
            bytes.push(value);
            let cls = "";
            if (edited !== undefined) {
                cls = " pend";
            } else if (view.states[j] === ByteState.Unreadable) {
                cls = " bad";
                error ??= p.cache.error(a);
            } else if (view.states[j] === ByteState.Loading) {
                cls = " load";
            } else if (view.changed[j]) {
                cls = " chg";
            }
            if (!state.includes(cls)) {
                state += cls;
            }
            const isCursor = p.pane === "text" && p.cursor === a;
            chars.push(
                <span
                    key={j}
                    className={`t${cls}${inSel(a) ? " sel" : ""}${isCursor ? " cur" : ""}`}
                    data-a={a.toString(16)}
                    data-p="t"
                >
                    {value === undefined ? (view.states[j] === ByteState.Loading ? " " : "?") : asciiChar(value)}
                </span>,
            );
        }
        const loading = bytes.some((b) => b === undefined) && !state.includes("bad");
        const text = loading ? "··".repeat(g) : formatGroup(bytes, p.endianness);
        const isCursor = p.pane === "hex" && p.cursor !== undefined && alignDown(p.cursor, BigInt(g)) === groupAddress;
        groups.push(
            <span
                key={i}
                className={`g${state}${inSel(groupAddress) ? " sel" : ""}${isCursor ? " cur" : ""}`}
                data-a={groupAddress.toString(16)}
                data-p="h"
            >
                {isCursor ? (
                    <>
                        {text.slice(0, p.nibble)}
                        <span className="caret">{text.charAt(p.nibble)}</span>
                        {text.slice(p.nibble + 1)}
                    </>
                ) : (
                    text
                )}
            </span>,
        );
    }
    return (
        <div className="row" style={{ top: p.top }} title={error}>
            <span className="addr">{formatAddress(p.address, p.addressSize)}</span>
            <span className="hex">{groups}</span>
            <span className="text">{chars}</span>
        </div>
    );
});

/** The header with the offset of each group. */
export function GridHeader(props: { addressSize: number; groupSize: number; bytesPerRow: number }) {
    const groups: React.ReactNode[] = [];
    for (let i = 0; i < props.bytesPerRow; i += props.groupSize) {
        groups.push(
            <span key={i} className="g">
                {formatHex(i, 2).padEnd(props.groupSize * 2)}
            </span>,
        );
    }
    return (
        <div className="grid-header">
            <span className="addr">{"Address".padEnd(props.addressSize * 2)}</span>
            <span className="hex">{groups}</span>
            <span className="text">Text</span>
        </div>
    );
}
