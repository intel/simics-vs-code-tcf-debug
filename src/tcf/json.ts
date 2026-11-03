/*
 * TCF agents send 64-bit integers (addresses, PCs) as plain JSON numbers,
 * which lose precision with JSON.parse. Integers outside the safe range are
 * returned as bigint using the JSON.parse source text access (V8 >= 11.4).
 */

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

const INTEGER = /^-?\d+$/;

const reviver: Reviver = (_key, value, context) => {
    if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && INTEGER.test(context.source)) {
        return BigInt(context.source);
    }
    return value;
};

export function parseJson(text: string): unknown {
    return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
}

export function toBigInt(value: unknown): bigint | undefined {
    if (typeof value === "bigint") {
        return value;
    }
    if (typeof value === "number" && Number.isInteger(value)) {
        return BigInt(value);
    }
    return undefined;
}
