import { test } from "node:test";
import assert from "node:assert/strict";
import { contextChoices, describeContextScope, parseContextList, pickedValues, scopeMenuItems } from "@/contextChoices";

const CONTEXTS = [
    { id: "core-0", name: "board.cpu0" },
    { id: "core-1", name: "board.cpu1" },
];

// The selected call-stack context comes first. Checked entries keep how they
// were written (ID or name), and those the session does not have stay listed.
test("contextChoices checks entries by ID or name and keeps unknown ones", () => {
    const choices = contextChoices(CONTEXTS, ["board.cpu1", "gone"], "core-1");
    assert.deepEqual(choices, [
        {
            label: "board.cpu1",
            description: "Selected call-stack context",
            detail: "core-1",
            value: "board.cpu1",
            picked: true,
        },
        { label: "board.cpu0", description: "core-0", value: "core-0", picked: false },
        { label: "gone", description: "Not available in this session", value: "gone", picked: true },
    ]);
    assert.deepEqual(pickedValues(choices.filter((c) => c.picked)), ["board.cpu1", "gone"]);
});

// An ID wins over a context whose name is the same text.
test("contextChoices matches IDs before names", () => {
    const contexts = [...CONTEXTS, { id: "other", name: "core-0" }];
    assert.deepEqual(
        contextChoices(contexts, ["core-0"]).map((c) => [c.label, c.picked]),
        [
            ["board.cpu0", true],
            ["board.cpu1", false],
            ["core-0", false],
        ],
    );
});

test("parseContextList and describeContextScope", () => {
    assert.deepEqual(parseContextList(" cpu0, ,cpu1,cpu0 "), ["cpu0", "cpu1"]);
    assert.equal(describeContextScope({}), "all contexts");
    assert.equal(describeContextScope({ contexts: ["cpu0", "cpu1"] }), "cpu0, cpu1");
    assert.equal(describeContextScope({ contextQuery: "**/HasState=true" }), "contexts matching **/HasState=true");
});

// The menu starts on the item for the current scope. Another scope than all
// or the selected context gets an item of its own at the top.
test("scopeMenuItems offers the current scope, all, the selected context, pick and query", () => {
    const menu = (scope: Parameters<typeof scopeMenuItems>[0], selectedId?: string) =>
        scopeMenuItems(scope, CONTEXTS, selectedId).map((item) => [item.label, item.active ?? false]);
    assert.deepEqual(menu({ contexts: [] }, "core-1"), [
        ["$(globe) All contexts", true],
        ["$(debug-stackframe) board.cpu1", false],
        ["$(checklist) Pick Contexts...", false],
        ["$(filter) Context Query...", false],
    ]);
    assert.deepEqual(menu({ contexts: ["core-1"] }, "core-1").slice(0, 2), [
        ["$(globe) All contexts", false],
        ["$(debug-stackframe) board.cpu1", true],
    ]);
    assert.deepEqual(menu({ contexts: ["core-0", "gone"] }).slice(0, 2), [
        ["$(check) board.cpu0, gone", true],
        ["$(globe) All contexts", false],
    ]);
    const [current] = scopeMenuItems({ contextQuery: "HasState=true" }, CONTEXTS);
    assert.equal(current.label, "$(check) Contexts matching HasState=true");
    assert.deepEqual(current.action, { scope: { contextQuery: "HasState=true" } });
});
