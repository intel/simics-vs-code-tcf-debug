/*
 * Formatting helpers of the Target Memory view, shared by the extension and
 * the webview. No vscode or DOM imports, so they can be unit tested.
 */

export type Endianness = "little" | "big";

export const GROUP_SIZES = [1, 2, 4, 8] as const;
export type GroupSize = (typeof GROUP_SIZES)[number];

/** Bytes per row, 0 means as many as fit the width of the view. */
export const BYTES_PER_ROW_OPTIONS = [0, 8, 16, 32, 64] as const;
export type BytesPerRow = (typeof BYTES_PER_ROW_OPTIONS)[number];

export const MAX_ADDRESS = (1n << 64n) - 1n;

/**
 * Parses "0x"-prefixed hex or plain decimal, like C. Returns undefined for
 * other input or values above `max`.
 */
export function parseAddress(text: string, max: bigint = MAX_ADDRESS): bigint | undefined {
    const t = text.trim().replace(/_/g, "");
    if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(t)) {
        return undefined;
    }
    const value = BigInt(t);
    return value <= max ? value : undefined;
}

/** Uppercase hex without prefix, zero padded to `digits`. */
export function formatHex(value: bigint | number, digits: number): string {
    return value.toString(16).toUpperCase().padStart(digits, "0");
}

/** An address as sent in messages: "0x" and lowercase hex. */
export function hexString(value: bigint): string {
    return `0x${value.toString(16)}`;
}

export function formatAddress(address: bigint, addressSize = 8): string {
    return formatHex(address, addressSize * 2);
}

export function alignDown(value: bigint, alignment: bigint): bigint {
    return value - (value % alignment);
}

export function alignUp(value: bigint, alignment: bigint): bigint {
    const rest = value % alignment;
    return rest === 0n ? value : value + alignment - rest;
}

/**
 * Offset within a group of the byte shown at display position `index`
 * (0 = leftmost). Groups are shown as numbers, so in little endian the
 * leftmost byte is the last one in memory.
 */
export function groupByteOffset(index: number, groupSize: number, endianness: Endianness): number {
    return endianness === "little" ? groupSize - 1 - index : index;
}

/**
 * The hex digits of a group as shown: a number in the given byte order.
 * Bytes that are unknown (undefined) are shown as "??".
 */
export function formatGroup(bytes: readonly (number | undefined)[], endianness: Endianness): string {
    let text = "";
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[groupByteOffset(i, bytes.length, endianness)];
        text += b === undefined ? "??" : formatHex(b, 2);
    }
    return text;
}

/** Printable ASCII is shown as is, other bytes as ".". */
export function asciiChar(byte: number): string {
    return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
}

/**
 * The most bytes per row (a power of two, at most 64) that fit in `width`
 * characters: address, hex groups with a space between them, and text, with
 * two characters between the columns and one at each side.
 */
export function autoBytesPerRow(width: number, addressSize: number, groupSize: number): number {
    for (let n = 64; n > groupSize; n /= 2) {
        const groups = n / groupSize;
        const chars = 1 + addressSize * 2 + 2 + n * 2 + groups - 1 + 2 + n + 1;
        if (chars <= width) {
            return n;
        }
    }
    return groupSize;
}

/**
 * The address in a value from the debugger, such as "0x1000",
 * "(char *) 0x1000 \"abc\"" or "4096": the first hex number, else a leading
 * decimal number.
 */
export function addressFromValue(value: string): bigint | undefined {
    const hex = /\b0[xX][0-9a-fA-F]+\b/.exec(value);
    if (hex) {
        return parseAddress(hex[0]);
    }
    const dec = /^\s*([0-9]+)\b/.exec(value);
    return dec ? parseAddress(dec[1]) : undefined;
}

/**
 * Replaces one hex digit of a byte: digit 0 is the high nibble, 1 the low.
 */
export function setNibble(byte: number, digit: 0 | 1, value: number): number {
    return digit === 0 ? ((value & 0x0f) << 4) | (byte & 0x0f) : (byte & 0xf0) | (value & 0x0f);
}

export interface InspectorEntry {
    label: string;
    value: string;
}

/**
 * The values starting at the first byte of `bytes`, like the data inspector
 * of the VS Code hex editor. Types longer than the known bytes are "-".
 */
export function inspectBytes(bytes: readonly number[], endianness: Endianness): InspectorEntry[] {
    const little = endianness === "little";
    const view = new DataView(Uint8Array.from(bytes.slice(0, 8)).buffer);
    const has = (n: number) => bytes.length >= n;
    const na = "-";
    const int = (n: 1 | 2 | 4 | 8, signed: boolean): string => {
        if (!has(n)) {
            return na;
        }
        switch (n) {
            case 1:
                return String(signed ? view.getInt8(0) : view.getUint8(0));
            case 2:
                return String(signed ? view.getInt16(0, little) : view.getUint16(0, little));
            case 4:
                return String(signed ? view.getInt32(0, little) : view.getUint32(0, little));
            case 8:
                return String(signed ? view.getBigInt64(0, little) : view.getBigUint64(0, little));
        }
    };
    return [
        {
            label: "binary",
            value: has(1) ? bytes[0].toString(2).padStart(8, "0") : na,
        },
        { label: "int8", value: int(1, true) },
        { label: "uint8", value: int(1, false) },
        { label: "int16", value: int(2, true) },
        { label: "uint16", value: int(2, false) },
        { label: "int32", value: int(4, true) },
        { label: "uint32", value: int(4, false) },
        { label: "int64", value: int(8, true) },
        { label: "uint64", value: int(8, false) },
        {
            label: "float32",
            value: has(4) ? String(view.getFloat32(0, little)) : na,
        },
        {
            label: "float64",
            value: has(8) ? String(view.getFloat64(0, little)) : na,
        },
    ];
}
