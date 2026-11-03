import { test } from "node:test";
import assert from "node:assert/strict";
import { TypeClass, ValueProperties, formatExpressionValue } from "../tcf/services/expressions";

function format(bytes: number[], properties: ValueProperties): string {
    return formatExpressionValue({ bytes: Buffer.from(bytes), properties });
}

// Cardinal, Integer and Enumeration values up to 64 bits, in both byte
// orders, including the 64-bit limits.
test("formatExpressionValue shows integers in decimal", () => {
    assert.equal(format([0xff, 0xff], { Class: TypeClass.Cardinal }), "65535");
    assert.equal(format([0xff, 0xff], { Class: TypeClass.Integer }), "-1");
    assert.equal(format([0xfe, 0xff], { Class: TypeClass.Integer }), "-2");
    assert.equal(format([0xff, 0xfe], { Class: TypeClass.Integer, BigEndian: true }), "-2");
    assert.equal(format([0x03], { Class: TypeClass.Enumeration }), "3");
    assert.equal(format([0, 0, 0, 0, 0, 0, 0, 0x80], { Class: TypeClass.Integer }), "-9223372036854775808");
    assert.equal(
        format([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], {
            Class: TypeClass.Cardinal,
        }),
        "18446744073709551615",
    );
});

// 128-bit integers are not converted to decimal.
test("formatExpressionValue shows integers wider than 64 bits in hex", () => {
    const bytes = Array.from({ length: 16 }, (_, i) => i);
    assert.equal(format(bytes, { Class: TypeClass.Integer }), "0xf0e0d0c0b0a09080706050403020100");
});

// 4 and 8 byte reals in both byte orders. Other sizes, like an 80-bit
// long double, are shown as hex.
test("formatExpressionValue shows floating point numbers", () => {
    const f32 = Buffer.alloc(4);
    f32.writeFloatLE(0.25);
    assert.equal(
        formatExpressionValue({
            bytes: f32,
            properties: { Class: TypeClass.Real },
        }),
        "0.25",
    );
    const f64 = Buffer.alloc(8);
    f64.writeDoubleBE(-1.5);
    assert.equal(
        formatExpressionValue({
            bytes: f64,
            properties: { Class: TypeClass.Real, BigEndian: true },
        }),
        "-1.5",
    );
    assert.equal(format([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], { Class: TypeClass.Real }), "0x1");
});

// Pointers, structs and unknown classes: hex without leading zeros.
test("formatExpressionValue shows other values in short hex", () => {
    assert.equal(format([0x00, 0x10, 0, 0, 0, 0, 0, 0], { Class: TypeClass.Pointer }), "0x1000");
    assert.equal(format([0, 0, 0, 0], { Class: TypeClass.Pointer }), "0x0");
    assert.equal(format([0x12, 0x34], { Class: TypeClass.Pointer, BigEndian: true }), "0x1234");
    assert.equal(format([0x01, 0x02], { Class: TypeClass.Composite }), "0x201");
    assert.equal(format([0x0a], {}), "0xa");
});

// A value with no bytes gives an empty string, not "0x".
test("formatExpressionValue shows an empty value as an empty string", () => {
    assert.equal(format([], { Class: TypeClass.Integer }), "");
});
