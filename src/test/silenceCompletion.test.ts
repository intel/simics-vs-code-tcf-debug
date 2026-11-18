import { test } from "node:test";
import assert from "node:assert/strict";
import { TRACE_SERVICES, silenceRuleCompletions } from "@/silenceCompletion";

/** The completions at the one "|" in `text`, which marks the cursor, with the part they replace. */
function at(text: string): { replaces: string; values: string[] } | undefined {
    const parts = text.split("|");
    assert.equal(parts.length, 2, `one "|" must mark the cursor in ${text}`);
    const [before, after] = parts;
    const offset = before.length;
    const source = before + after;
    const found = silenceRuleCompletions(source, offset);
    return found && { replaces: source.slice(found.start, offset), values: found.values };
}

const SILENCE = '{ "simics-target-debug.tcfTrace.silence": [ ';

// The service is the first part of a rule, also in a rule that is not closed yet.
test("silence keys suggest services first", () => {
    assert.deepEqual(at(`${SILENCE}"Loc|" ] }`), { replaces: "Loc", values: ["*", ...TRACE_SERVICES] });
    assert.deepEqual(at(`${SILENCE}"a", "|" ] }`)?.replaces, "");
    assert.deepEqual(at(`${SILENCE}"Mem|\n] }`)?.replaces, "Mem");
    assert.deepEqual(at(`{ "settings": ${SILENCE}"C|" ] } }`)?.replaces, "C");
});

// After "/" and each ",": the types not chosen yet, "*" only alone.
test("silence keys suggest message types after the service", () => {
    assert.deepEqual(at(`${SILENCE}"Locator/ev|" ] }`), {
        replaces: "ev",
        values: ["*", "command", "event", "flowControl"],
    });
    assert.deepEqual(at(`${SILENCE}"Memory/command,|" ] }`), { replaces: "", values: ["event", "flowControl"] });
    assert.equal(at(`${SILENCE}"Memory/*,|" ] }`), undefined);
});

// Names, other settings and the text after a rule get nothing.
test("silence completions only in silence rules before the name", () => {
    assert.equal(at(`${SILENCE}"Locator/event/peer|" ] }`), undefined);
    assert.equal(at(`${SILENCE}"Loc"| ] }`), undefined);
    assert.equal(at(`{ "simics-target-debug.tcfTrace.silence|": [] }`), undefined);
    assert.equal(at(`{ "editor.fontSize|": 12 }`), undefined);
    assert.equal(at(`{ "other": [ "Loc|" ] }`), undefined);
});
