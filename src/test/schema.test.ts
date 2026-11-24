import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
    agentAddress,
    fieldPath,
    fieldsFromSchema,
    labelFor,
    launchFields,
    launchTemplate,
    parseInput,
    valueAtPath,
} from "@/launchSettings/schema";
import { DEFAULT_TRACE_SILENCE } from "@/tcf/traceSilence";

// The bundled test runs from out/test.
const PACKAGE_JSON: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));

// The form shows the attributes of the real package.json, in its order, then
// the Advanced fold-down with VS Code's Debug Console option.
test("launchFields reads the simics-target-debug attributes from package.json", () => {
    const fields = launchFields(PACKAGE_JSON, "simics-target-debug");
    assert.deepEqual(
        fields.map((f) => [f.key, f.kind, f.group, f.label]),
        [
            ["host", "string", undefined, "Host"],
            ["port", "number", undefined, "Port"],
            ["symbolFiles", "objectList", undefined, "Symbol Files"],
            ["pathMap", "objectList", undefined, "Path Map"],
            ["connectTimeout", "number", "advanced", "Connect Timeout"],
            ["internalConsoleOptions", "enum", "advanced", "Debug Console"],
        ],
    );
    assert.deepEqual(fields.map(fieldPath)[0], ["host"]);
    const host = fields[0];
    assert.equal(host.label, "Host");
    assert.equal(host.default, "localhost");
    assert.match(String(host.description), /TCF agent/);
    const pathMap = fields.find((f) => f.key === "pathMap");
    assert.deepEqual(
        pathMap?.columns?.map((c) => [c.key, c.kind, c.required, c.browse]),
        [
            ["source", "string", true, undefined],
            ["destination", "string", true, "fileOrFolder"],
            ["context", "string", undefined, undefined],
            ["contextQuery", "string", undefined, undefined],
        ],
    );
    const symbolFiles = fields.find((f) => f.key === "symbolFiles");
    assert.deepEqual(
        symbolFiles?.columns?.map((c) => [c.key, c.kind, c.browse]),
        [
            ["path", "string", "file"],
            ["context", "string", undefined],
            ["contextQuery", "string", undefined],
            ["address", "stringOrInteger", undefined],
            ["absolute", "boolean", undefined],
        ],
    );
});

// The session uses DEFAULT_TRACE_SILENCE when it gets no setting, and the
// Settings editor shows the default in package.json: they must be the same.
// The pathMap default is only a completion template, the form must not show
// it as if it applied.
test("list defaults in package.json are the ones that apply", () => {
    const categories = (PACKAGE_JSON as { contributes: { configuration: { properties: Record<string, unknown> }[] } })
        .contributes.configuration;
    const key = "simics-target-debug.tcfTrace.silence";
    const silence = categories.find((c) => key in c.properties)?.properties[key] as { default?: unknown };
    assert.deepEqual(silence.default, DEFAULT_TRACE_SILENCE);
    const fields = launchFields(PACKAGE_JSON, "simics-target-debug");
    assert.equal(fields.find((f) => f.key === "pathMap")?.default, undefined);
});

// A new attribute in package.json must get a real input, not the
// "edit in launch.json" fallback. Fails if a new attribute needs UI work.
test("every simics-target-debug attribute has a supported field kind", () => {
    for (const f of launchFields(PACKAGE_JSON, "simics-target-debug")) {
        assert.notEqual(f.kind, "unsupported", f.key);
        for (const c of f.columns ?? []) {
            assert.notEqual(c.kind, "unsupported", `${f.key}.${c.key}`);
        }
    }
});

// New configurations start from the first initial configuration.
test("launchTemplate uses the initial configuration", () => {
    assert.deepEqual(launchTemplate(PACKAGE_JSON, "simics-target-debug"), {
        type: "simics-target-debug",
        request: "attach",
        name: "Attach to TCF agent",
        host: "localhost",
        port: 1534,
    });
    assert.deepEqual(launchTemplate({}, "x"), {
        type: "x",
        request: "attach",
        name: "x",
    });
});

// Unknown debug types and odd package.json content give no fields.
test("launchFields copes with missing attributes", () => {
    assert.deepEqual(launchFields(PACKAGE_JSON, "no-such-type"), []);
    assert.deepEqual(launchFields(undefined, "simics-target-debug"), []);
    assert.deepEqual(launchFields({ contributes: { debuggers: [{ type: "x" }] } }, "x"), []);
});

// VS Code adds its general attributes to packageJSON at run time. All are
// hidden, except Debug Console, which gets an explained field.
test("launchFields handles the attributes VS Code adds", () => {
    const pkg = {
        contributes: {
            debuggers: [
                {
                    type: "x",
                    configurationAttributes: {
                        attach: {
                            properties: {
                                host: { type: "string" },
                                type: { enum: ["x"] },
                                request: { enum: ["attach"] },
                                name: { type: "string" },
                                debugServer: { type: "number" },
                                preLaunchTask: {
                                    anyOf: [{ type: "string" }, { type: "object" }],
                                },
                                postDebugTask: {
                                    anyOf: [{ type: "string" }, { type: "object" }],
                                },
                                presentation: { type: "object" },
                                internalConsoleOptions: { enum: ["neverOpen"] },
                                suppressMultipleSessionWarning: {
                                    type: "boolean",
                                },
                            },
                        },
                    },
                },
            ],
        },
    };
    const fields = launchFields(pkg, "x");
    assert.deepEqual(
        fields.map((f) => [f.key, f.kind]),
        [
            ["host", "string"],
            ["internalConsoleOptions", "enum"],
        ],
    );
    const debugConsole = fields[1];
    assert.ok(debugConsole.description);
    assert.deepEqual(debugConsole.valueLabels, ["Never", "When each session starts", "When the first session starts"]);
});

// Each JSON schema type maps to one kind of input. Lists of anything but
// simple objects, and unknown types, cannot be edited in the form.
test("fieldsFromSchema picks a field kind per schema type", () => {
    const fields = fieldsFromSchema({
        s: { type: "string" },
        e: { type: "string", enum: ["a", "b"] },
        n: { type: "number" },
        i: { type: "integer" },
        b: { type: "boolean" },
        si: { type: ["integer", "string"] },
        ns: { type: ["string", "null"] },
        strings: { type: "array", items: { type: "string" } },
        nested: {
            type: "array",
            items: { type: "object", properties: { o: { type: "object" } } },
        },
        o: { type: "object" },
        none: {},
    });
    assert.deepEqual(
        fields.map((f) => [f.key, f.kind]),
        [
            ["s", "string"],
            ["e", "enum"],
            ["n", "number"],
            ["i", "integer"],
            ["b", "boolean"],
            ["si", "stringOrInteger"],
            ["ns", "string"],
            ["strings", "unsupported"],
            ["nested", "unsupported"],
            ["o", "unsupported"],
            ["none", "unsupported"],
        ],
    );
    assert.deepEqual(fields[1].values, ["a", "b"]);
});

// Required keys are marked, markdownDescription is used if there is no
// plain description.
test("fieldsFromSchema reads required keys and descriptions", () => {
    const [a, b] = fieldsFromSchema(
        {
            a: { type: "string", description: "plain" },
            b: { type: "string", markdownDescription: "*md*" },
        },
        ["a"],
    );
    assert.equal(a.required, true);
    assert.equal(a.description, "plain");
    assert.equal(b.required, undefined);
    assert.equal(b.description, "*md*");
});

test("valueAtPath finds values inside objects and lists", () => {
    const values = { consoles: { simicsCli: { open: false } }, pathMap: [{ source: "/a" }], host: "h" };
    assert.equal(valueAtPath(values, ["consoles", "simicsCli", "open"]), false);
    assert.equal(valueAtPath(values, ["pathMap", 0, "source"]), "/a");
    assert.equal(valueAtPath(values, ["host", "x"]), undefined);
    assert.equal(valueAtPath(values, ["consoles", "missing", "open"]), undefined);
});

// Labels look like the Settings editor: words split at capitals, known
// abbreviations in capitals.
test("labelFor turns attribute names into labels", () => {
    assert.equal(labelFor("host"), "Host");
    assert.equal(labelFor("connectTimeout"), "Connect Timeout");
    assert.equal(labelFor("traceTcf"), "Trace TCF");
    assert.equal(labelFor("contextQuery"), "Context Query");
    assert.equal(labelFor("symbol_files"), "Symbol Files");
});

// An empty text removes the attribute so the default applies. Numbers are
// checked, and "address" style fields keep hex as text.
test("parseInput converts typed text to values", () => {
    assert.deepEqual(parseInput("string", "  "), { remove: true });
    assert.deepEqual(parseInput("string", " a b "), { value: " a b " });
    assert.deepEqual(parseInput("number", "1.5"), { value: 1.5 });
    assert.deepEqual(parseInput("number", "x"), { error: "Enter a number" });
    assert.deepEqual(parseInput("integer", "42"), { value: 42 });
    assert.deepEqual(parseInput("integer", "1.5"), {
        error: "Enter a whole number",
    });
    assert.deepEqual(parseInput("stringOrInteger", "4096"), { value: 4096 });
    assert.deepEqual(parseInput("stringOrInteger", "0x1000"), {
        value: "0x1000",
    });
    assert.deepEqual(parseInput("stringOrInteger", "99999999999999999999"), {
        value: "99999999999999999999",
    });
});

// The form's start button is only blocked for configurations on an agent that
// already has a session, so the address must match the debug session's defaults.
test("agentAddress defaults to the debug session's host and port", () => {
    assert.equal(agentAddress({}), "localhost:1534");
    assert.equal(agentAddress({ host: "simhost", port: 1600 }), "simhost:1600");
    assert.notEqual(agentAddress({ port: 1534 }), agentAddress({ port: 1535 }));
});
