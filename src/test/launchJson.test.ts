import { test } from "node:test";
import assert from "node:assert/strict";
import { Edit, applyEdits } from "jsonc-parser";
import {
    addConfiguration,
    detectFormatting,
    duplicateConfiguration,
    readConfigurations,
    removeConfiguration,
    removeConfigurations,
    setValue,
    setPathMapRules,
    setNamedConfigurationValue,
    uniqueName,
} from "@/launchSettings/launchJson";

const LAUNCH = `{
    // Comment at the top.
    "version": "0.2.0",
    "configurations": [
        {
            "type": "cppdbg",
            "request": "launch",
            "name": "Native",
        },
        {
            // The Simics target.
            "type": "simics-target-debug",
            "request": "attach",
            "name": "Target",
            "host": "localhost", // Host comment.
            "pathMap": [
                { "source": "/build/src", "destination": "\${workspaceFolder}" }
            ]
        },
        {
            "type": "simics-target-debug",
            "request": "attach",
            "name": "Second"
        }
    ],
    "compounds": [{ "name": "Both", "configurations": ["Native", "Target"] }]
}
`;

const SECOND = `,
        {
            "type": "simics-target-debug",
            "request": "attach",
            "name": "Second"
        }`;

const FMT = detectFormatting(LAUNCH);

test("saving symbol files preserves all runtime fields and other configuration content", () => {
    const files = [
        { path: "/agent/firmware.elf", context: "cpu0", address: "-4096" },
        {
            path: "/agent/kernel.elf",
            context: "",
            contextQuery: "/server/**/HasState=true",
            address: "18446744073709551600",
            absolute: true,
        },
    ];
    const saved = apply(LAUNCH, setNamedConfigurationValue(LAUNCH, "Target", "symbolFiles", files));
    assert.deepEqual(values(saved, 1).symbolFiles, files);
    const { symbolFiles, ...unchanged } = values(saved, 1);
    assert.deepEqual(unchanged, values(LAUNCH, 1));
    assert.deepEqual(values(saved, 2), values(LAUNCH, 2));
    assert.ok(saved.includes("// Host comment."));
    assert.ok(saved.includes("// The Simics target."));
    assert.ok(saved.includes('"type": "cppdbg"'));
    assert.ok(saved.includes('"compounds"'));
});

test("saving symbol files replaces the list including removals and empty lists", () => {
    const first = apply(
        LAUNCH,
        setNamedConfigurationValue(LAUNCH, "Target", "symbolFiles", [{ path: "/old.elf" }, { path: "/keep.elf" }]),
    );
    const replacement = [{ path: "/keep.elf", context: "cpu1" }];
    const saved = apply(first, setNamedConfigurationValue(first, "Target", "symbolFiles", replacement));
    assert.deepEqual(values(saved, 1).symbolFiles, replacement);
    const cleared = apply(saved, setNamedConfigurationValue(saved, "Target", "symbolFiles", []));
    assert.deepEqual(values(cleared, 1).symbolFiles, []);
});

test("saving symbol files refuses missing, duplicate, and invalid configurations", () => {
    for (const [text, name] of [
        [LAUNCH, "Missing"],
        [LAUNCH, "Native"],
        [LAUNCH.replace('"name": "Second"', '"name": "Target"'), "Target"],
        ["{ invalid", "Target"],
    ]) {
        assert.throws(() => setNamedConfigurationValue(text, name, "symbolFiles", []));
    }
});

test("the editing keys button writes and removes a nested attribute", () => {
    const path = ["consoles", "simicsCli", "editingKeys"];
    const off = apply(LAUNCH, setNamedConfigurationValue(LAUNCH, "Target", path, false));
    assert.deepEqual(values(off, 1).consoles, { simicsCli: { editingKeys: false } });
    const on = apply(off, setNamedConfigurationValue(off, "Target", path, undefined));
    assert.deepEqual(values(on, 1), values(LAUNCH, 1));
    const withOpen = apply(LAUNCH, setValue(LAUNCH, 1, ["consoles", "simicsCli", "open"], false, FMT));
    const both = apply(withOpen, setNamedConfigurationValue(withOpen, "Target", path, false));
    const back = apply(both, setNamedConfigurationValue(both, "Target", path, undefined));
    assert.deepEqual(values(back, 1).consoles, { simicsCli: { open: false } });
});

test("saving session rules replaces only the named TCF pathMap", () => {
    const rules = [
        { source: "/second", destination: "${workspaceFolder}/second" },
        { source: "/first", destination: "/host/first" },
    ];
    const saved = apply(LAUNCH, setPathMapRules(LAUNCH, "Target", rules));
    assert.deepEqual(values(saved, 1).pathMap, rules);
    assert.equal(values(saved, 1).host, "localhost");
    assert.ok(saved.includes("// Host comment."));
    assert.ok(saved.includes("// The Simics target."));
    assert.deepEqual(values(saved, 2), values(LAUNCH, 2));
    assert.ok(saved.includes('"type": "cppdbg"'));
    assert.ok(saved.includes('"compounds"'));
});

test("saving and appending scoped rules preserve their scope fields", () => {
    const rules = [
        { source: "/build", destination: "/cpu0", context: "cpu0" },
        {
            source: "/build",
            destination: "/workers",
            contextQuery: "/server/**/HasState=true",
        },
    ];
    const saved = apply(LAUNCH, setPathMapRules(LAUNCH, "Target", rules));
    assert.deepEqual(values(saved, 1).pathMap, rules);
    const appended = apply(saved, setPathMapRules(saved, "Target", [rules[0]], true));
    assert.deepEqual(values(appended, 1).pathMap, [...rules, rules[0]]);
});

test("saving removals writes an empty path map", () => {
    const saved = apply(LAUNCH, setPathMapRules(LAUNCH, "Target", []));
    assert.deepEqual(values(saved, 1).pathMap, []);
});

test("saving a new path map and appending a located rule both work", () => {
    const rule = { source: "/build", destination: "/host" };
    const added = apply(LAUNCH, setPathMapRules(LAUNCH, "Second", [rule]));
    assert.deepEqual(values(added, 2).pathMap, [rule]);
    const appended = apply(LAUNCH, setPathMapRules(LAUNCH, "Target", [rule], true));
    assert.deepEqual(values(appended, 1).pathMap, [{ source: "/build/src", destination: "${workspaceFolder}" }, rule]);
});

test("saving rejects missing, ambiguous, or malformed configurations", () => {
    assert.throws(() => setPathMapRules(LAUNCH, "Missing", []), /Expected one TCF configuration/);
    const duplicate = LAUNCH.replace('"name": "Second"', '"name": "Target"');
    assert.throws(() => setPathMapRules(duplicate, "Target", []), /unique name/);
    assert.throws(() => setPathMapRules("{ invalid", "Target", []));
});

test("appending a located source keeps comments in existing rules", () => {
    const commented = LAUNCH.replace(
        '{ "source": "/build/src"',
        '// Existing mapping.\n                { "source": "/build/src"',
    );
    const saved = apply(
        commented,
        setPathMapRules(commented, "Target", [{ source: "/new", destination: "/local" }], true),
    );
    assert.ok(saved.includes("// Existing mapping."));
});

function apply(text: string, edits: Edit[]): string {
    return applyEdits(text, edits);
}

function values(text: string, index: number): Record<string, unknown> {
    const result = readConfigurations(text);
    const config = result.configurations?.find((c) => c.index === index);
    assert.ok(config, `no simics-target-debug configuration at ${index}`);
    return config.values;
}

// Only simics-target-debug configurations are listed, with their position in the
// whole list, so edits can find them again.
test("readConfigurations lists the simics-target-debug configurations", () => {
    const result = readConfigurations(LAUNCH);
    assert.equal(result.error, undefined);
    assert.deepEqual(
        result.configurations?.map((c) => [c.index, c.name]),
        [
            [1, "Target"],
            [2, "Second"],
        ],
    );
    assert.deepEqual(values(LAUNCH, 1), {
        type: "simics-target-debug",
        request: "attach",
        name: "Target",
        host: "localhost",
        pathMap: [{ source: "/build/src", destination: "${workspaceFolder}" }],
    });
});

// An empty file or a file without "configurations" has no configurations,
// and a configuration without a name gets an empty name.
test("readConfigurations accepts files without configurations", () => {
    assert.deepEqual(readConfigurations(""), { configurations: [] });
    assert.deepEqual(readConfigurations('{ "version": "0.2.0" }'), {
        configurations: [],
    });
    assert.deepEqual(readConfigurations('{ "configurations": [{ "type": "simics-target-debug" }] }'), {
        configurations: [{ index: 0, name: "", values: { type: "simics-target-debug" } }],
    });
});

// Broken files give a message for the user instead of configurations.
test("readConfigurations reports files it cannot read", () => {
    assert.deepEqual(readConfigurations('{\n  "configurations": [\n  }'), {
        error: "ValueExpected on line 3",
    });
    assert.deepEqual(readConfigurations("[]"), {
        error: "launch.json must contain a JSON object",
    });
    assert.deepEqual(readConfigurations('{ "configurations": {} }'), {
        error: '"configurations" must be a list',
    });
});

// Changing a value replaces only that value, everything else is kept.
test("setValue changes one value and keeps the rest of the file", () => {
    const result = apply(LAUNCH, setValue(LAUNCH, 1, ["host"], "simics-host", FMT));
    assert.equal(result, LAUNCH.replace('"host": "localhost"', '"host": "simics-host"'));
});

// A new attribute is added at the end of the configuration.
test("setValue adds a missing attribute", () => {
    const result = apply(LAUNCH, setValue(LAUNCH, 1, ["port"], 1534, FMT));
    assert.equal(values(result, 1).port, 1534);
    assert.equal(result.replace(',\n            "port": 1534', ""), LAUNCH);
});

// Removing an attribute also removes a // comment on its line, otherwise
// the comment would move to the line before.
test("setValue with undefined removes an attribute and its comment", () => {
    const result = apply(LAUNCH, setValue(LAUNCH, 1, ["host"], undefined, FMT));
    assert.equal(result, LAUNCH.replace('\n            "host": "localhost", // Host comment.', ""));
    const last =
        '{\n  "configurations": [\n    {\n      "type": "simics-target-debug",\n' +
        '      "host": "h" // c\n    }\n  ]\n}\n';
    assert.equal(
        apply(last, setValue(last, 0, ["host"], undefined, FMT)),
        '{\n  "configurations": [\n    {\n      "type": "simics-target-debug"\n' + "    }\n  ]\n}\n",
    );
    assert.deepEqual(setValue(LAUNCH, 1, ["port"], undefined, FMT), []);
});

// Rows of lists like pathMap can be changed, added and removed one by one.
test("setValue edits rows of a list", () => {
    const changed = apply(LAUNCH, setValue(LAUNCH, 1, ["pathMap", 0, "destination"], "/ws", FMT));
    assert.equal(changed, LAUNCH.replace("${workspaceFolder}", "/ws"));

    const added = apply(LAUNCH, setValue(LAUNCH, 1, ["pathMap", -1], { source: "/a", destination: "/b" }, FMT));
    assert.deepEqual(values(added, 1).pathMap, [
        { source: "/build/src", destination: "${workspaceFolder}" },
        { source: "/a", destination: "/b" },
    ]);
    assert.ok(added.includes("// Host comment."));

    const removed = apply(LAUNCH, setValue(LAUNCH, 1, ["pathMap", 0], undefined, FMT));
    assert.deepEqual(values(removed, 1).pathMap, []);
});

// Setting a row of a list that does not exist yet creates the list.
test("setValue creates missing lists and objects", () => {
    const result = apply(LAUNCH, setValue(LAUNCH, 2, ["pathMap", 0, "source"], "/x", FMT));
    assert.deepEqual(values(result, 2).pathMap, [{ source: "/x" }]);
});

// Removing the last attribute of an object removes the object too, but
// not a list or an object that has other attributes.
test("setValue removes objects left empty", () => {
    const open = ["consoles", "simicsCli", "open"];
    const one = apply(LAUNCH, setValue(LAUNCH, 2, open, false, FMT));
    assert.deepEqual(values(one, 2).consoles, { simicsCli: { open: false } });
    assert.equal(apply(one, setValue(one, 2, open, undefined, FMT)), LAUNCH);

    const two = apply(one, setValue(one, 2, ["consoles", "simicsCli", "historySessions"], 0, FMT));
    const back = apply(two, setValue(two, 2, open, undefined, FMT));
    assert.deepEqual(values(back, 2).consoles, { simicsCli: { historySessions: 0 } });
});

// Edits must never touch other debug types, positions that do not exist,
// or a file that cannot be read.
test("edits refuse other configurations and broken files", () => {
    assert.throws(() => setValue(LAUNCH, 0, ["name"], "x", FMT), /no simics-target-debug configuration at position 0/);
    assert.throws(() => setValue(LAUNCH, 9, ["name"], "x", FMT), /no simics-target-debug configuration at position 9/);
    assert.throws(() => setValue(LAUNCH, 1, [], "x", FMT), /No attribute/);
    assert.throws(() => removeConfiguration(LAUNCH, 0, FMT), /position 0/);
    assert.throws(() => duplicateConfiguration(LAUNCH, 0, FMT), /position 0/);
    assert.throws(() => setValue('{ "configurations": [', 0, ["name"], "x", FMT), /Cannot change launch.json: /);
    assert.throws(() => addConfiguration("{", { name: "x" }, FMT), /Cannot change launch.json: /);
});

// A new configuration goes last, gets type simics-target-debug first, and a name
// that is not used by any configuration, also of other types.
test("addConfiguration appends a configuration with a unique name", () => {
    const { edits, index } = addConfiguration(
        LAUNCH,
        { type: "other", request: "attach", name: "Native", port: 1534 },
        FMT,
    );
    const result = apply(LAUNCH, edits);
    assert.equal(index, 3);
    assert.deepEqual(values(result, 3), {
        type: "simics-target-debug",
        request: "attach",
        name: "Native (2)",
        port: 1534,
    });
    assert.deepEqual(Object.keys(values(result, 3))[0], "type");
    const end = LAUNCH.indexOf("\n    ],");
    assert.equal(result.slice(0, end), LAUNCH.slice(0, end));
});

// An empty file gets a complete launch.json, a file without a list gets one.
test("addConfiguration creates the file content or the list", () => {
    const empty = addConfiguration("", { request: "attach", name: "New" }, FMT);
    assert.equal(empty.index, 0);
    assert.equal(
        apply("", empty.edits),
        '{\n    "version": "0.2.0",\n    "configurations": [\n        {\n' +
            '            "type": "simics-target-debug",\n' +
            '            "request": "attach",\n' +
            '            "name": "New"\n        }\n    ]\n}\n',
    );
    const noList = '{\n    "version": "0.2.0"\n}\n';
    const added = addConfiguration(noList, { name: "New" }, FMT);
    assert.equal(added.index, 0);
    assert.deepEqual(values(apply(noList, added.edits), 0), {
        type: "simics-target-debug",
        name: "New",
    });
});

// The copy goes right after the original, with a unique name.
test("duplicateConfiguration inserts a copy after the original", () => {
    const { edits, index } = duplicateConfiguration(LAUNCH, 1, FMT);
    const result = apply(LAUNCH, edits);
    assert.equal(index, 2);
    assert.deepEqual(values(result, 2), {
        ...values(LAUNCH, 1),
        name: "Target (2)",
    });
    assert.equal(values(result, 3).name, "Second");
    assert.ok(result.includes("// The Simics target."));

    const last = duplicateConfiguration(LAUNCH, 2, FMT);
    assert.equal(last.index, 3);
    assert.equal(values(apply(LAUNCH, last.edits), 3).name, "Second (2)");
});

// Removing a configuration removes exactly its block and the comma.
test("removeConfiguration removes one configuration", () => {
    const start = LAUNCH.indexOf("        {\n            // The Simics");
    const end = LAUNCH.indexOf(SECOND.slice(2), start);
    assert.equal(apply(LAUNCH, removeConfiguration(LAUNCH, 1, FMT)), LAUNCH.slice(0, start) + LAUNCH.slice(end));
    assert.equal(apply(LAUNCH, removeConfiguration(LAUNCH, 2, FMT)), LAUNCH.replace(SECOND, ""));
});

// Removing several configurations gives one edit, other types are kept.
test("removeConfigurations removes several configurations", () => {
    const edits = removeConfigurations(LAUNCH, [1, 2], FMT);
    assert.equal(edits.length, 1);
    const result = apply(LAUNCH, edits);
    assert.deepEqual(readConfigurations(result), { configurations: [] });
    assert.ok(result.includes('"name": "Native"'));
    assert.ok(result.includes('"compounds"'));
    const withoutSecond = apply(LAUNCH, removeConfiguration(LAUNCH, 2, FMT));
    assert.equal(result, apply(withoutSecond, removeConfiguration(withoutSecond, 1, FMT)));
    assert.deepEqual(removeConfigurations(LAUNCH, [], FMT), []);
    assert.throws(() => removeConfigurations(LAUNCH, [0, 1], FMT), /position 0/);
});

// Edits keep Windows line endings in a file that uses them.
test("edits keep CRLF line endings", () => {
    const crlf = LAUNCH.replace(/\n/g, "\r\n");
    const fmt = detectFormatting(crlf);
    const result = apply(crlf, setValue(crlf, 1, ["port"], 1534, fmt));
    assert.ok(result.includes(',\r\n            "port": 1534'));
    assert.doesNotMatch(result, /[^\r]\n/);
});

// Names get " (2)", " (3)", ... until they are unique.
test("uniqueName adds a number to names that are taken", () => {
    assert.equal(uniqueName("A", []), "A");
    assert.equal(uniqueName("A", ["A"]), "A (2)");
    assert.equal(uniqueName("A", ["A", "A (2)", "A (3)"]), "A (4)");
    assert.equal(uniqueName("A", ["A (2)"]), "A");
});

// Indentation comes from lines with JSON content, not from comment lines.
test("detectFormatting finds indentation and line endings", () => {
    assert.deepEqual(detectFormatting('{\n\t"a": 1\n}'), {
        insertSpaces: false,
        tabSize: 4,
        eol: "\n",
    });
    assert.deepEqual(detectFormatting('{\r\n  "a": {\r\n    "b": 1\r\n  }\r\n}'), {
        insertSpaces: true,
        tabSize: 2,
        eol: "\r\n",
    });
    assert.deepEqual(detectFormatting(LAUNCH), {
        insertSpaces: true,
        tabSize: 4,
        eol: "\n",
    });
    assert.deepEqual(detectFormatting('/*\n * x\n */\n{\n    "a": 1\n}'), {
        insertSpaces: true,
        tabSize: 4,
        eol: "\n",
    });
    assert.deepEqual(detectFormatting(""), {
        insertSpaces: true,
        tabSize: 4,
        eol: "\n",
    });
});
