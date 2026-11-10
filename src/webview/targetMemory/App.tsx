import * as React from "react";
import {
    alignDown,
    autoBytesPerRow,
    formatAddress,
    formatGroup,
    asciiChar,
    hexString,
} from "@/shared/targetMemory/format";
import {
    DEFAULT_SETTINGS,
    type ContextMenuCommand,
    type MenuTarget,
    type MemoryTarget,
    type PanelSettings,
    type TargetState,
    type ToWebview,
} from "@/shared/targetMemory/protocol";
import { MemoryCache } from "./memoryCache";
import { onMessage, post } from "./vscode";
import { GridHeader, MemoryGrid, selectionRange, type GridHandle, type Selection } from "./components/MemoryGrid";
import { FindWidget, type FindRequest, type FindStatus } from "./components/FindWidget";
import { Toolbar } from "./components/Toolbar";
import { Inspector } from "./components/controls";

/** Largest selection that is copied. */
const MAX_COPY = 0x10000;

/** The find request that is running, to continue it after wrapping. */
interface ActiveFind extends FindRequest {
    /** ID of the find request sent last, replies to others are stale. */
    id: number;
    /** Where the search started, the wrapped search ends there. */
    origin: bigint;
    wrapped: boolean;
    /** Why a part of the range could not be searched, if so. */
    message?: string;
}

export function App() {
    const cache = React.useMemo(() => new MemoryCache(post), []);
    const cacheVersion = React.useSyncExternalStore(cache.subscribe, cache.getVersion);
    const [settings, setSettings] = React.useState(DEFAULT_SETTINGS);
    const [state, setState] = React.useState<TargetState>();
    const [selection, setSelection] = React.useState<Selection>();
    const [pending, setPending] = React.useState(new Map<string, number>());
    const [writeError, setWriteError] = React.useState<string>();
    const [notice, setNotice] = React.useState<string>();
    const [gotoError, setGotoError] = React.useState<string>();
    const [addressFocus, setAddressFocus] = React.useState(0);
    const [findOpen, setFindOpen] = React.useState(false);
    const [findFocus, setFindFocus] = React.useState(0);
    const [findQuery, setFindQuery] = React.useState("");
    const [findStatus, setFindStatus] = React.useState<FindStatus>({
        kind: "idle",
    });
    const [width, setWidth] = React.useState(0);
    const [charWidth, setCharWidth] = React.useState(8);

    const gridRef = React.useRef<GridHandle>(null);
    const mainRef = React.useRef<HTMLDivElement>(null);
    const measureRef = React.useRef<HTMLSpanElement>(null);
    const topAddress = React.useRef<bigint>(undefined);
    const activeFind = React.useRef<ActiveFind>(undefined);
    const lastFindId = React.useRef(0);

    const addressSize = state?.addressSize ?? 8;
    const maxAddress = (1n << BigInt(addressSize * 8)) - 1n;
    const groupSize = settings.groupSize;
    const bytesPerRow =
        settings.bytesPerRow === 0
            ? autoBytesPerRow(Math.floor(width / charWidth), addressSize, groupSize)
            : Math.max(settings.bytesPerRow, groupSize);

    // The latest values, for the message handler that is installed once.
    const latest = React.useRef({
        state,
        selection,
        pending,
        settings,
        groupSize,
    });
    latest.current = { state, selection, pending, settings, groupSize };

    const changeSettings = (change: Partial<PanelSettings>) => {
        const next = { ...latest.current.settings, ...change };
        if (next.groupSize !== latest.current.settings.groupSize) {
            // A digit position in the old group size means nothing in the new.
            setSelection(
                (sel) =>
                    sel && {
                        ...sel,
                        cursor: sel.pane === "hex" ? alignDown(sel.cursor, BigInt(next.groupSize)) : sel.cursor,
                        nibble: 0,
                    },
            );
        }
        setSettings(next);
        post({ type: "settings", settings: next });
    };

    const select = (address: bigint, length = 1) => {
        const g = BigInt(latest.current.groupSize);
        const pane = latest.current.selection?.pane ?? "hex";
        const last = address + BigInt(Math.max(1, length)) - 1n;
        setSelection({
            anchor: address,
            cursor: pane === "hex" && length <= 1 ? alignDown(address, g) : last,
            pane,
            nibble: 0,
        });
        gridRef.current?.reveal(address);
    };

    /** The bytes of a range with the pending edits, undefined if unknown. */
    const bytesAt = (address: bigint, count: number, edits = latest.current.pending): (number | undefined)[] =>
        cache.read(address, count).values.map((v, i) => edits.get((address + BigInt(i)).toString(16)) ?? v);

    const copy = (kind: "hex" | "text" | "address" | "auto", sel = latest.current.selection) => {
        const g = latest.current.groupSize;
        if (!sel) {
            return;
        }
        const [lo, hi] = selectionRange(sel, g);
        if (kind === "address") {
            post({ type: "copy", text: hexString(lo) });
            return;
        }
        const count = Number(hi - lo + 1n);
        if (count > MAX_COPY) {
            setNotice(`At most ${MAX_COPY} bytes can be copied.`);
            return;
        }
        const bytes = bytesAt(lo, count);
        const asText = kind === "text" || (kind === "auto" && sel.pane === "text");
        let text: string;
        if (asText) {
            text = bytes.map((b) => (b === undefined ? "?" : asciiChar(b))).join("");
        } else {
            // Groups as shown, but only whole groups: a partial group has no
            // order.
            const groups: string[] = [];
            const step = sel.pane === "hex" ? g : 1;
            for (let i = 0; i < count; i += step) {
                groups.push(formatGroup(bytes.slice(i, i + step), latest.current.settings.endianness));
            }
            text = groups.join(" ");
        }
        post({ type: "copy", text });
    };

    const openFind = () => {
        setFindOpen(true);
        setFindFocus((n) => n + 1);
    };

    /**
     * The selection a menu command acts on: the right-clicked entry, or the
     * selection if the entry is in it.
     */
    const menuSelection = (target: MenuTarget | undefined) => {
        const { selection: sel, groupSize: g } = latest.current;
        if (!target) {
            return sel;
        }
        const address = BigInt(target.address);
        if (sel) {
            const [lo, hi] = selectionRange(sel, g);
            if (address >= lo && address <= hi) {
                return sel;
            }
        }
        const clicked: Selection = {
            anchor: address,
            cursor: address,
            pane: target.pane,
            nibble: 0,
        };
        setSelection(clicked);
        return clicked;
    };

    const runCommand = (command: ContextMenuCommand, target?: MenuTarget) => {
        switch (command) {
            case "copy":
                copy("hex", menuSelection(target));
                break;
            case "copyText":
                copy("text", menuSelection(target));
                break;
            case "copyAddress":
                copy("address", menuSelection(target));
                break;
            case "goto":
                setAddressFocus((n) => n + 1);
                break;
            case "find":
                openFind();
                break;
            case "refresh":
                post({ type: "refresh" });
                break;
        }
    };

    const sendFind = (f: ActiveFind, start: bigint, end: bigint) => {
        const id = ++lastFindId.current;
        activeFind.current = { ...f, id };
        setFindStatus({
            kind: "searching",
            start,
            end,
            direction: f.direction,
            startedAt: Date.now(),
            wrapped: f.wrapped,
        });
        post({
            type: "find",
            id,
            epoch: latest.current.state?.epoch ?? 0,
            needle: Array.from(f.needle),
            alignment: f.alignment,
            start: hexString(start),
            end: hexString(end),
            direction: f.direction,
        });
    };

    /** Searches [start, end], or goes on if no match fits in it. */
    const searchPart = (f: ActiveFind, start: bigint, end: bigint) => {
        if (start >= 0n && end - start + 1n >= BigInt(f.needle.length)) {
            sendFind(f, start, end);
        } else {
            notFound(f);
        }
    };

    /**
     * Where a search starts: the start of the selection, not group aligned
     * since a match selected by the last search may start inside a group,
     * or the top of the view.
     */
    const findCursor = (sel = latest.current.selection) =>
        sel ? (sel.anchor < sel.cursor ? sel.anchor : sel.cursor) : topAddress.current;

    /** Searches from the selection (or the top of the view) on. */
    const startFind = (request: FindRequest) => {
        const sel = latest.current.selection;
        const n = BigInt(request.needle.length);
        const from = findCursor(sel);
        const forward = request.direction === "forward";
        // The first address a match may start at (forward) or the last.
        // Below 0 when searching backward from address 0.
        const origin =
            from === undefined
                ? forward
                    ? request.rangeStart
                    : request.rangeEnd
                : forward
                  ? from + (sel ? 1n : 0n)
                  : from - 1n;
        const f: ActiveFind = { ...request, id: 0, origin, wrapped: false };
        if (forward) {
            searchPart(f, origin > f.rangeStart ? origin : f.rangeStart, f.rangeEnd);
        } else {
            const end = origin + n - 1n;
            searchPart(f, f.rangeStart, end < f.rangeEnd ? end : f.rangeEnd);
        }
    };

    /**
     * Nothing found up to the end of the range: search from the other end
     * up to where the search started, once.
     */
    const notFound = (f: ActiveFind, message?: string) => {
        const n = BigInt(f.needle.length);
        const next: ActiveFind = {
            ...f,
            wrapped: true,
            message: f.message ?? message,
        };
        if (!f.wrapped) {
            if (f.direction === "forward") {
                const end = f.origin + n - 2n;
                if (f.origin > f.rangeStart) {
                    sendFind(next, f.rangeStart, end < f.rangeEnd ? end : f.rangeEnd);
                    return;
                }
            } else {
                const start = f.origin + 1n;
                if (start <= f.rangeEnd) {
                    sendFind(next, start > f.rangeStart ? start : f.rangeStart, f.rangeEnd);
                    return;
                }
            }
        }
        activeFind.current = undefined;
        setFindStatus({ kind: "notFound", message: next.message });
    };

    const handleMessage = (m: ToWebview) => {
        switch (m.type) {
            case "init":
                setSettings(m.settings);
                if (m.address !== undefined && topAddress.current === undefined) {
                    gridRef.current?.reveal(BigInt(m.address));
                }
                break;
            case "state": {
                const old = latest.current.state;
                if (old?.epoch !== m.state.epoch) {
                    cache.reset(m.state.epoch);
                    setPending(new Map());
                    setWriteError(undefined);
                }
                setState(m.state);
                break;
            }
            case "refresh":
                if (m.epoch === latest.current.state?.epoch) {
                    cache.invalidate();
                }
                break;
            case "data":
            case "readError":
                cache.handle(m);
                break;
            case "reveal":
                select(BigInt(m.address), m.length);
                gridRef.current?.focus();
                break;
            case "gotoError":
                setGotoError(m.message);
                break;
            case "findProgress":
                if (m.id === activeFind.current?.id) {
                    setFindStatus((s) => (s.kind === "searching" ? { ...s, address: BigInt(m.address) } : s));
                }
                break;
            case "findResult": {
                const f = activeFind.current;
                if (m.id !== f?.id) {
                    break;
                }
                if (m.outcome === "notFound") {
                    notFound(f, m.message);
                    break;
                }
                activeFind.current = undefined;
                if (m.outcome === "found" && m.address !== undefined) {
                    const address = BigInt(m.address);
                    setFindStatus({
                        kind: "found",
                        address,
                        wrapped: f.wrapped,
                    });
                    select(address, m.length);
                } else {
                    setFindStatus(
                        m.outcome === "cancelled"
                            ? { kind: "cancelled" }
                            : {
                                  kind: "error",
                                  message: m.message ?? "Search failed",
                              },
                    );
                }
                break;
            }
            case "writeResult":
                if (m.ok) {
                    setPending(new Map());
                    setWriteError(undefined);
                } else {
                    setWriteError(m.message ?? "Writing failed");
                }
                break;
            case "command":
                runCommand(m.command, m.target);
                break;
        }
    };
    const handleRef = React.useRef(handleMessage);
    handleRef.current = handleMessage;

    React.useEffect(() => {
        const off = onMessage((m) => handleRef.current(m));
        post({ type: "ready" });
        return off;
    }, []);

    React.useLayoutEffect(() => {
        const main = mainRef.current;
        const measure = measureRef.current;
        if (!main || !measure) {
            return;
        }
        setCharWidth(measure.getBoundingClientRect().width / 100 || 8);
        const observer = new ResizeObserver(() =>
            // Leave room for the scroll bar.
            setWidth(Math.max(0, main.clientWidth - 16)),
        );
        observer.observe(main);
        return () => observer.disconnect();
    }, []);

    const positionTimer = React.useRef<number>(undefined);
    const onTopAddress = React.useCallback((address: bigint) => {
        topAddress.current = address;
        window.clearTimeout(positionTimer.current);
        positionTimer.current = window.setTimeout(() => post({ type: "position", address: hexString(address) }), 500);
    }, []);

    const apply = () => {
        const writes: { address: string; bytes: number[] }[] = [];
        const addresses = [...pending.keys()].map((k) => BigInt(`0x${k}`)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        let next = -1n;
        for (const a of addresses) {
            const value = pending.get(a.toString(16))!;
            if (a === next && writes.length > 0) {
                writes[writes.length - 1].bytes.push(value);
            } else {
                writes.push({ address: hexString(a), bytes: [value] });
            }
            next = a + 1n;
        }
        if (writes.length > 0 && state) {
            post({ type: "write", epoch: state.epoch, writes });
        }
    };
    const discard = () => {
        setPending(new Map());
        setWriteError(undefined);
    };

    // The data inspector shows the known bytes at the cursor.
    let inspected: number[] = [];
    if (selection && settings.inspector) {
        const start = selection.pane === "hex" ? alignDown(selection.cursor, BigInt(groupSize)) : selection.cursor;
        for (const b of bytesAt(start, 8, pending)) {
            if (b === undefined) {
                break;
            }
            inspected.push(b);
        }
    }

    const running = state?.running ?? false;
    const canRead = state?.canRead ?? false;
    const overlay = state?.notice ?? (state === undefined ? "Connecting..." : undefined);
    const findDisabled = !canRead
        ? running
            ? "Memory cannot be searched while the target is running."
            : "There is no memory to search."
        : undefined;
    const selectionText = (() => {
        if (!selection) {
            return undefined;
        }
        const [lo, hi] = selectionRange(selection, groupSize);
        const n = hi - lo + 1n;
        return n === 1n
            ? `0x${formatAddress(lo, addressSize)}`
            : `0x${formatAddress(lo, addressSize)}-0x${formatAddress(hi, addressSize)} (${n} bytes)`;
    })();

    return (
        <div className="app">
            <Toolbar
                state={state}
                settings={settings}
                onSettings={changeSettings}
                onTarget={(target: MemoryTarget) => post({ type: "setTarget", target })}
                onGoto={(expression) => {
                    setGotoError(undefined);
                    post({ type: "goto", expression });
                }}
                gotoError={gotoError}
                onGotoEdit={() => setGotoError(undefined)}
                focusToken={addressFocus}
                findOpen={findOpen}
                onToggleFind={() => (findOpen ? setFindOpen(false) : openFind())}
                onRefresh={() => post({ type: "refresh" })}
            />
            {(pending.size > 0 || writeError) && (
                <div className="edit-bar">
                    <i className="codicon codicon-edit" />
                    <span>
                        {pending.size} byte{pending.size === 1 ? "" : "s"} modified
                    </span>
                    {writeError && <span className="error">{writeError}</span>}
                    <span className="toolbar-spacer" />
                    <button
                        className="primary"
                        onClick={apply}
                        disabled={pending.size === 0 || !state?.canWrite}
                        title="Write the changes to memory (Enter)"
                    >
                        Apply
                    </button>
                    <button className="secondary" onClick={discard} title="Undo the changes (Escape)">
                        Discard
                    </button>
                </div>
            )}
            {running && !canRead && !overlay && (
                <div className="banner">
                    <i className="codicon codicon-debug-start" />
                    The target is running. The memory shown is from when it last stopped.
                </div>
            )}
            {notice && (
                <div className="banner" onClick={() => setNotice(undefined)}>
                    <i className="codicon codicon-info" />
                    {notice}
                </div>
            )}
            <div className="content">
                <div className="main" ref={mainRef}>
                    <span ref={measureRef} className="measure">
                        {"0".repeat(100)}
                    </span>
                    <GridHeader addressSize={addressSize} groupSize={groupSize} bytesPerRow={bytesPerRow} />
                    <MemoryGrid
                        ref={gridRef}
                        cache={cache}
                        cacheVersion={cacheVersion}
                        maxAddress={maxAddress}
                        addressSize={addressSize}
                        groupSize={groupSize}
                        endianness={settings.endianness}
                        bytesPerRow={bytesPerRow}
                        canRead={canRead}
                        canWrite={state?.canWrite ?? false}
                        dimmed={running && !canRead}
                        selection={selection}
                        onSelection={(s) => {
                            setSelection(s);
                            setNotice(undefined);
                        }}
                        pending={pending}
                        onPending={setPending}
                        onApply={apply}
                        onDiscard={discard}
                        onEditBlocked={() =>
                            setNotice(
                                running
                                    ? "Memory cannot be changed while the target is running."
                                    : "Memory cannot be changed now.",
                            )
                        }
                        onTopAddress={onTopAddress}
                        onCopy={() => copy("auto")}
                    />
                    {overlay && <div className="overlay">{overlay}</div>}
                    {findOpen && (
                        <FindWidget
                            query={findQuery}
                            onQuery={setFindQuery}
                            settings={settings.find}
                            onSettings={(find) => changeSettings({ find })}
                            status={findStatus}
                            disabledReason={findDisabled}
                            focusToken={findFocus}
                            cursor={findCursor(selection)}
                            onFind={startFind}
                            onCancel={() => post({ type: "cancelFind" })}
                            onClose={() => {
                                if (findStatus.kind === "searching") {
                                    post({ type: "cancelFind" });
                                }
                                setFindOpen(false);
                                gridRef.current?.focus();
                            }}
                        />
                    )}
                </div>
                {settings.inspector && (
                    <Inspector
                        address={
                            selection &&
                            (selection.pane === "hex"
                                ? alignDown(selection.cursor, BigInt(groupSize))
                                : selection.cursor)
                        }
                        addressSize={addressSize}
                        bytes={inspected}
                        endianness={settings.endianness}
                    />
                )}
            </div>
            <div className="status-bar">
                <span
                    className={`state-dot ${state?.contextId === undefined ? "none" : running ? "running" : "suspended"}`}
                />
                <span title={state?.contextId}>
                    {state?.target.kind === "physical"
                        ? `Physical: ${state.contextLabel ?? state.target.contextId}`
                        : state?.contextLabel
                          ? `Thread: ${state.contextLabel}`
                          : "No thread"}
                    {state?.contextId !== undefined && (running ? " (running)" : " (suspended)")}
                </span>
                <span className="toolbar-spacer" />
                {selectionText && <span>{selectionText}</span>}
                <span className="legend chg" title="Changed when the target last stopped">
                    changed
                </span>
                <span className="legend pend" title="Modified, not written yet">
                    modified
                </span>
            </div>
        </div>
    );
}
