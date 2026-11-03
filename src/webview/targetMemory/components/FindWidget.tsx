import * as React from "react";
import {
    MAX_ADDRESS,
    formatAddress,
    hexString,
    parseAddress,
    type Endianness,
} from "../../../shared/targetMemory/format";
import {
    INT_SIZES,
    encodeNeedle,
    type EncodeResult,
    type FindFormat,
    type IntSize,
} from "../../../shared/targetMemory/needle";
import { DEFAULT_SETTINGS, type FindSettings } from "../../../shared/targetMemory/protocol";
import type { SearchDirection } from "../../../shared/targetMemory/search";
import { IconButton, Segmented } from "./controls";

export type FindStatus =
    | { kind: "idle" }
    | {
          kind: "searching";
          start: bigint;
          end: bigint;
          direction: SearchDirection;
          address?: bigint;
          startedAt: number;
          wrapped: boolean;
      }
    | { kind: "found"; address: bigint; wrapped: boolean }
    | { kind: "notFound"; message?: string }
    | { kind: "cancelled" }
    | { kind: "error"; message: string };

export interface FindRequest {
    direction: SearchDirection;
    needle: Uint8Array;
    alignment: number;
    rangeStart: bigint;
    rangeEnd: bigint;
}

interface FindWidgetProps {
    query: string;
    onQuery(query: string): void;
    settings: FindSettings;
    onSettings(settings: FindSettings): void;
    status: FindStatus;
    /** Why memory cannot be searched now, if so. */
    disabledReason?: string;
    /** Incremented to focus the query input. */
    focusToken: number;
    /** Where the next search starts: the selection or the top of the view. */
    cursor: bigint | undefined;
    onFind(request: FindRequest): void;
    onCancel(): void;
    onClose(): void;
}

const FORMATS: { value: FindFormat; label: string; title: string }[] = [
    {
        value: "hex",
        label: "Hex",
        title: 'Hex numbers separated by spaces. Each number is stored in the selected byte order, so in little endian "12345678" is the bytes 78 56 34 12. Write single bytes, such as "de ad be ef", to find a byte sequence.',
    },
    { value: "text", label: "Text", title: "ASCII text" },
    {
        value: "int",
        label: "Integer",
        title: "A decimal or 0x hex integer, negative values in two's complement",
    },
];

const ALIGNMENTS = [1, 2, 4, 8, 16];

/** Search box like the VS Code find widget, at the top right of the view. */
export function FindWidget(props: FindWidgetProps) {
    const { settings: f, status } = props;
    const inputRef = React.useRef<HTMLInputElement>(null);
    const [showRange, setShowRange] = React.useState(false);

    React.useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [props.focusToken]);

    const update = (change: Partial<FindSettings>) => props.onSettings({ ...f, ...change });

    const encoded: EncodeResult = props.query
        ? encodeNeedle(props.query, f.format, {
              endianness: f.endianness,
              intSize: f.intSize,
          })
        : { ok: false, error: "" };
    const rangeStart = parseAddress(f.rangeStart);
    const rangeEnd = parseAddress(f.rangeEnd);
    let error = encoded.ok ? undefined : encoded.error;
    if (rangeStart === undefined) {
        error = `The start address ${f.rangeStart} is not valid`;
    } else if (rangeEnd === undefined) {
        error = `The end address ${f.rangeEnd} is not valid`;
    } else if (rangeEnd < rangeStart) {
        error = "The end address is below the start address";
    }
    const canFind = encoded.ok && error === undefined && props.disabledReason === undefined;
    const searching = status.kind === "searching";

    const cursor = props.cursor;
    const outside =
        cursor !== undefined &&
        rangeStart !== undefined &&
        rangeEnd !== undefined &&
        (cursor < rangeStart || cursor > rangeEnd);
    // Moving one end of the range past the other also moves that one, by
    // the default range size.
    const span = BigInt(DEFAULT_SETTINGS.find.rangeEnd);
    const startAtCursor = () => {
        if (cursor === undefined) {
            return;
        }
        const change: Partial<FindSettings> = { rangeStart: hexString(cursor) };
        if (rangeEnd === undefined || rangeEnd < cursor) {
            const end = cursor + span;
            change.rangeEnd = hexString(end < MAX_ADDRESS ? end : MAX_ADDRESS);
        }
        update(change);
        setShowRange(true);
    };
    const endAtCursor = () => {
        if (cursor === undefined) {
            return;
        }
        const change: Partial<FindSettings> = { rangeEnd: hexString(cursor) };
        if (rangeStart === undefined || rangeStart > cursor) {
            change.rangeStart = hexString(cursor > span ? cursor - span : 0n);
        }
        update(change);
    };

    const find = (direction: SearchDirection) => {
        if (canFind && encoded.ok && rangeStart !== undefined && rangeEnd !== undefined) {
            props.onFind({
                direction,
                needle: encoded.bytes,
                alignment: f.alignment,
                rangeStart,
                rangeEnd,
            });
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            find(e.shiftKey ? "backward" : "forward");
        } else if (e.key === "Escape") {
            e.preventDefault();
            if (searching) {
                props.onCancel();
            } else {
                props.onClose();
            }
        }
    };

    const placeholder = {
        hex: "Find hex (e.g. de ad be ef)",
        text: "Find text",
        int: `Find ${f.intSize * 8}-bit integer`,
    }[f.format];

    return (
        <div className="find" onKeyDown={onKeyDown}>
            <div className="find-row">
                <input
                    ref={inputRef}
                    className={`find-input${props.query && error ? " invalid" : ""}`}
                    value={props.query}
                    placeholder={placeholder}
                    title={FORMATS.find((x) => x.value === f.format)?.title}
                    spellCheck={false}
                    onChange={(e) => props.onQuery(e.target.value)}
                />
                <select
                    value={f.format}
                    title="What to find"
                    onChange={(e) => update({ format: e.target.value as FindFormat })}
                >
                    {FORMATS.map((x) => (
                        <option key={x.value} value={x.value} title={x.title}>
                            {x.label}
                        </option>
                    ))}
                </select>
                {f.format === "int" && (
                    <select
                        value={f.intSize}
                        title="Integer size, also sets the alignment"
                        onChange={(e) => {
                            const intSize = Number(e.target.value) as IntSize;
                            update({ intSize, alignment: intSize });
                        }}
                    >
                        {INT_SIZES.map((n) => (
                            <option key={n} value={n}>
                                {n * 8}-bit
                            </option>
                        ))}
                    </select>
                )}
                {f.format !== "text" && (
                    <Segmented<Endianness>
                        value={f.endianness}
                        options={[
                            {
                                value: "little",
                                label: "LE",
                                title: "Little endian",
                            },
                            { value: "big", label: "BE", title: "Big endian" },
                        ]}
                        onChange={(endianness) => update({ endianness })}
                    />
                )}
                <select
                    value={f.alignment}
                    title="Only find matches at addresses that are a multiple of this"
                    onChange={(e) => update({ alignment: Number(e.target.value) })}
                >
                    {ALIGNMENTS.map((n) => (
                        <option key={n} value={n}>
                            {n === 1 ? "Any address" : `Aligned ${n}`}
                        </option>
                    ))}
                </select>
                <IconButton
                    icon="arrow-up"
                    title="Previous match (Shift+Enter)"
                    disabled={!canFind}
                    onClick={() => find("backward")}
                />
                <IconButton
                    icon="arrow-down"
                    title="Next match (Enter)"
                    disabled={!canFind}
                    onClick={() => find("forward")}
                />
                <IconButton
                    icon="settings"
                    title="Search range"
                    checked={showRange}
                    onClick={() => setShowRange(!showRange)}
                />
                <IconButton icon="close" title="Close (Escape)" onClick={props.onClose} />
            </div>
            {showRange && (
                <div className="find-row">
                    <label>
                        From
                        <input
                            className="range-input"
                            value={f.rangeStart}
                            spellCheck={false}
                            onChange={(e) => update({ rangeStart: e.target.value })}
                        />
                    </label>
                    <IconButton
                        icon="target"
                        title="Start the range at the cursor"
                        disabled={cursor === undefined}
                        onClick={startAtCursor}
                    />
                    <label>
                        To
                        <input
                            className="range-input"
                            value={f.rangeEnd}
                            spellCheck={false}
                            onChange={(e) => update({ rangeEnd: e.target.value })}
                        />
                    </label>
                    <IconButton
                        icon="target"
                        title="End the range at the cursor"
                        disabled={cursor === undefined}
                        onClick={endAtCursor}
                    />
                    <IconButton
                        icon="discard"
                        title="Default range: the low 1 TiB"
                        onClick={() =>
                            update({
                                rangeStart: DEFAULT_SETTINGS.find.rangeStart,
                                rangeEnd: DEFAULT_SETTINGS.find.rangeEnd,
                            })
                        }
                    />
                </div>
            )}
            <FindStatusLine
                status={status}
                error={props.query ? error : undefined}
                disabledReason={props.disabledReason}
                onCancel={props.onCancel}
            />
            {outside && !searching && (
                <div className="find-status">
                    <span>The cursor 0x{formatAddress(cursor)} is outside the search range.</span>
                    <button className="link" onClick={startAtCursor}>
                        Search from the cursor
                    </button>
                </div>
            )}
        </div>
    );
}

function FindStatusLine(props: { status: FindStatus; error?: string; disabledReason?: string; onCancel(): void }) {
    const { status } = props;
    // Re-render a running search every second for its rate.
    const [, tick] = React.useState(0);
    React.useEffect(() => {
        if (status.kind !== "searching") {
            return;
        }
        const timer = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(timer);
    }, [status.kind]);

    if (status.kind === "searching") {
        const total = Number(status.end - status.start + 1n);
        const at = status.address;
        const done =
            at === undefined ? 0 : Number(status.direction === "forward" ? at - status.start : status.end - at);
        const seconds = (Date.now() - status.startedAt) / 1000;
        const rate = seconds > 0.5 ? done / seconds / 1e6 : undefined;
        return (
            <div className="find-status">
                <i className="codicon codicon-loading codicon-modifier-spin" />
                <span>
                    {status.wrapped ? "Wrapped, searching" : "Searching"}
                    {at !== undefined && ` 0x${formatAddress(at)}`}
                    {total > 0 && ` (${Math.min(100, (100 * done) / total).toFixed(1)}%)`}
                    {rate !== undefined && `, ${rate.toFixed(1)} MB/s`}
                </span>
                <button className="link" onClick={props.onCancel}>
                    Cancel
                </button>
            </div>
        );
    }
    let text: string | undefined;
    let cls = "";
    if (props.disabledReason) {
        text = props.disabledReason;
    } else if (props.error) {
        text = props.error;
        cls = " error";
    } else if (status.kind === "found") {
        text = `Found at 0x${formatAddress(status.address)}${status.wrapped ? ", wrapped around" : ""}`;
    } else if (status.kind === "notFound") {
        text = `Not found${status.message ? `. ${status.message}` : ""}`;
    } else if (status.kind === "cancelled") {
        text = "Search cancelled";
    } else if (status.kind === "error") {
        text = status.message;
        cls = " error";
    }
    return text ? <div className={`find-status${cls}`}>{text}</div> : null;
}
