/*
 * Encoding of a Target Memory search query into the bytes to find. Shared by
 * the find widget, which validates the input while typing, and the tests.
 */

import type { Endianness } from "./format";

export type FindFormat = "hex" | "text" | "int";

export const INT_SIZES = [1, 2, 4, 8] as const;
export type IntSize = (typeof INT_SIZES)[number];

/** Longest needle that can be searched for. */
export const MAX_NEEDLE_LENGTH = 4096;

export type EncodeResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

export interface EncodeOptions {
    endianness: Endianness;
    /** Size of the integer, for the "int" format. */
    intSize: IntSize;
}

export function encodeNeedle(query: string, format: FindFormat, options: EncodeOptions): EncodeResult {
    const result = encode(query, format, options);
    if (result.ok && result.bytes.length > MAX_NEEDLE_LENGTH) {
        return {
            ok: false,
            error: `At most ${MAX_NEEDLE_LENGTH} bytes can be searched for`,
        };
    }
    return result;
}

function encode(query: string, format: FindFormat, options: EncodeOptions): EncodeResult {
    switch (format) {
        case "hex":
            return encodeHex(query, options.endianness);
        case "text":
            return encodeText(query);
        case "int":
            return encodeInt(query, options.intSize, options.endianness);
    }
}

/**
 * Whitespace separated hex groups, each optionally "0x"-prefixed. A group is
 * a number in the given byte order, like the groups shown in the view, so
 * "12345678" is the bytes 78 56 34 12 in little endian. Single byte groups,
 * such as "de ad be ef", are a byte sequence in either byte order.
 */
function encodeHex(query: string, endianness: Endianness): EncodeResult {
    const groups = query.split(/\s+/).filter((g) => g.length > 0);
    if (groups.length === 0) {
        return { ok: false, error: "Enter hex bytes to find" };
    }
    const bytes: number[] = [];
    for (const group of groups) {
        if (!/^(0[xX])?[0-9a-fA-F]+$/.test(group)) {
            return { ok: false, error: `"${group}" is not a hex number` };
        }
        const digits = group.replace(/^0[xX]/, "");
        // Guessing whether "abc" means 0a bc or ab 0c would make a miss
        // impossible to interpret.
        if (digits.length % 2 !== 0) {
            return {
                ok: false,
                error: `"${group}" needs an even number of digits, two per byte`,
            };
        }
        const groupBytes: number[] = [];
        for (let i = 0; i < digits.length; i += 2) {
            groupBytes.push(Number.parseInt(digits.slice(i, i + 2), 16));
        }
        if (endianness === "little") {
            groupBytes.reverse();
        }
        bytes.push(...groupBytes);
    }
    return { ok: true, bytes: Uint8Array.from(bytes) };
}

/** ASCII text, one byte per character. */
function encodeText(query: string): EncodeResult {
    if (query.length === 0) {
        return { ok: false, error: "Enter text to find" };
    }
    const bytes = new Uint8Array(query.length);
    for (let i = 0; i < query.length; i++) {
        const code = query.charCodeAt(i);
        if (code > 0x7f) {
            return {
                ok: false,
                error: "Only ASCII text is supported, use hex for other bytes",
            };
        }
        bytes[i] = code;
    }
    return { ok: true, bytes };
}

/**
 * A decimal or "0x" hex integer of `size` bytes. Negative values are stored
 * in two's complement.
 */
function encodeInt(query: string, size: IntSize, endianness: Endianness): EncodeResult {
    const text = query.trim().replace(/_/g, "");
    const m = /^([+-]?)(0[xX][0-9a-fA-F]+|[0-9]+)$/.exec(text);
    if (!m) {
        return {
            ok: false,
            error: text ? `"${text}" is not an integer` : "Enter an integer to find",
        };
    }
    const bits = BigInt(size * 8);
    const magnitude = BigInt(m[2]);
    const value = m[1] === "-" ? -magnitude : magnitude;
    const min = -(1n << (bits - 1n));
    const max = (1n << bits) - 1n;
    if (value < min || value > max) {
        return {
            ok: false,
            error: `${text} does not fit in ${size * 8} bits`,
        };
    }
    let unsigned = BigInt.asUintN(size * 8, value);
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        bytes[endianness === "little" ? i : size - 1 - i] = Number(unsigned & 0xffn);
        unsigned >>= 8n;
    }
    return { ok: true, bytes };
}
