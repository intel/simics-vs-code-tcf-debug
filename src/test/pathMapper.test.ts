import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    PathMapper,
    deriveRule,
    mapPrefix,
    parsePathMapConfig,
    pathMapProblems,
    pathMapContextQuery,
} from "@/pathMapper";
import { PathMapRuleProperties, PathMapService } from "@/tcf/services/pathMap";

function fakePathMapService(agentRules: PathMapRuleProperties[] | Error) {
    const sets: PathMapRuleProperties[][] = [];
    let changed: (() => void) | undefined;
    let gets = 0;
    const service = {
        get: async () => {
            gets++;
            if (agentRules instanceof Error) {
                throw agentRules;
            }
            return agentRules;
        },
        set: async (rules: PathMapRuleProperties[]) => {
            sets.push(rules);
        },
        onChanged: (listener: () => void) => {
            changed = listener;
        },
    };
    return {
        service: service as unknown as PathMapService,
        sets,
        gets: () => gets,
        fireChanged: () => changed?.(),
    };
}

/** Creates a temporary directory with the given (empty) files in it. */
function tempDir(...files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simics-target-debug-test-"));
    for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), "");
    }
    return dir;
}

// The prefix must match whole path parts: /build/src does not match
// /build/src2. Trailing slashes in rules do not matter.
test("mapPrefix replaces a prefix that ends at a separator", () => {
    assert.equal(mapPrefix("/build/src/a.c", "/build/src", "/ws"), "/ws/a.c");
    assert.equal(mapPrefix("/build/src/a.c", "/build/src/", "/ws/"), "/ws/a.c");
    assert.equal(mapPrefix("/build/src", "/build/src", "/ws"), "/ws");
    assert.equal(mapPrefix("/build/src2/a.c", "/build/src", "/ws"), undefined);
    assert.equal(mapPrefix("/other/a.c", "/build/src", "/ws"), undefined);
});

// Backslashes in paths and rules work like slashes.
test("mapPrefix accepts Windows paths", () => {
    assert.equal(mapPrefix("C:\\build\\src\\a.c", "C:\\build\\src", "/ws"), "/ws/a.c");
    assert.equal(mapPrefix("C:/build/src/a.c", "C:\\build\\src\\", "/ws"), "/ws/a.c");
});

// A rule for "" or "/" never matches.
test("mapPrefix ignores an empty prefix", () => {
    assert.equal(mapPrefix("/a.c", "", "/ws"), undefined);
    assert.equal(mapPrefix("/a.c", "/", "/ws"), undefined);
});

// Rules without a non-empty source and destination are dropped, with one
// error message each. A setting that is not a list is one error.
test("parsePathMapConfig keeps valid rules and reports invalid ones", () => {
    assert.deepEqual(parsePathMapConfig(undefined), { rules: [], errors: [] });
    assert.deepEqual(parsePathMapConfig({ source: "/a", destination: "/b" }), {
        rules: [],
        errors: ['"pathMap" must be a list of' + ' { "source": ..., "destination": ... } rules'],
    });
    const result = parsePathMapConfig([
        { source: "/a", destination: "/b" },
        { source: "", destination: "/b" },
        null,
        { source: "/c" },
        { source: "/d", destination: 5 },
    ]);
    assert.deepEqual(result.rules, [{ source: "/a", destination: "/b" }]);
    assert.deepEqual(
        result.errors,
        [1, 2, 3, 4].map((i) => `pathMap[${i}] is ignored, it needs non-empty` + ' "source" and "destination" strings'),
    );
});

test("pathMapProblems reports empty and missing parts", () => {
    const existing = new Set(["/host/src", path.join("/ws", "rel")]);
    const exists = (p: string) => existing.has(p);
    assert.deepEqual(pathMapProblems(undefined, exists), []);
    assert.deepEqual(pathMapProblems({ source: "/a" }, exists), []);
    assert.deepEqual(
        pathMapProblems(
            [
                { source: "/a", destination: "/host/src" },
                { source: "/a", destination: "rel" },
                { source: "", destination: "/host/src" },
                { source: "/a", destination: "" },
                {},
                null,
                { source: "/a", destination: "/gone" },
            ],
            exists,
            "/ws",
        ),
        [
            "Rule 3 has no source and is ignored.",
            "Rule 4 has no destination and is ignored.",
            "Rule 5 has no source and destination and is ignored.",
            "Rule 6 has no source and destination and is ignored.",
            "Rule 7: the destination /gone does not exist on this host.",
        ],
    );
});

// All rules go in one PathMap.set. Their IDs share a prefix, so our rules
// can be told apart from the rules of other clients.
test("apply sends the configured rules to the agent", async () => {
    const fake = fakePathMapService([]);
    const mapper = new PathMapper(
        [
            { source: "/s1", destination: "/d1" },
            { source: "/s2", destination: "/d2" },
        ],
        fake.service,
    );
    await mapper.apply();
    assert.equal(fake.sets.length, 1);
    const [r1, r2] = fake.sets[0];
    assert.deepEqual({ Source: r1.Source, Destination: r1.Destination }, { Source: "/s1", Destination: "/d1" });
    assert.deepEqual({ Source: r2.Source, Destination: r2.Destination }, { Source: "/s2", Destination: "/d2" });
    assert.match(String(r1.ID), /^vscode-tcf-.*-1$/);
    assert.equal(r2.ID, String(r1.ID).replace(/-1$/, "-2"));
});

// No configured rules: PathMap.set is not called at all.
test("apply does nothing without rules", async () => {
    const fake = fakePathMapService([]);
    await new PathMapper([], fake.service).apply();
    assert.deepEqual(fake.sets, []);
});

// Two rules match: the one that gives an existing host file wins.
test("toHost prefers a mapped file that exists", async () => {
    const missing = tempDir();
    const present = tempDir("src/a.c");
    const mapper = new PathMapper(
        [
            { source: "/build", destination: missing },
            { source: "/build", destination: present },
        ],
        undefined,
    );
    assert.equal(await mapper.toHost("/build/src/a.c"), `${present}/src/a.c`);
});

// No mapped file exists: the first rule is used, so a "file not found"
// message shows the path the user expects.
test("toHost falls back to the first mapping if no file exists", async () => {
    const dir1 = tempDir();
    const dir2 = tempDir();
    const mapper = new PathMapper(
        [
            { source: "/build", destination: dir1 },
            { source: "/build", destination: dir2 },
        ],
        undefined,
    );
    assert.equal(await mapper.toHost("/build/a.c"), `${dir1}/a.c`);
});

// The compiled path exists on the host and no mapped file does: keep it.
// Without rules, any path is returned unchanged.
test("toHost keeps a compiled path that exists on the host", async () => {
    const dir = tempDir("a.c");
    const mapper = new PathMapper([{ source: dir, destination: tempDir() }], undefined);
    assert.equal(await mapper.toHost(`${dir}/a.c`), `${dir}/a.c`);
    assert.equal(await new PathMapper([], undefined).toHost("/no/such/a.c"), "/no/such/a.c");
});

// Rules the agent got from others, like Simics add-pathmap-entry, are used.
test("toHost uses rules the agent got elsewhere", async () => {
    const dir = tempDir("a.c");
    const fake = fakePathMapService([{ ID: "simics-1", Source: "/agent", Destination: dir }]);
    const mapper = new PathMapper([], fake.service);
    assert.equal(await mapper.toHost("/agent/a.c"), `${dir}/a.c`);
});

// PathMap.get is called once. A PathMap "changed" event clears the cache.
test("toHost caches results until the agent rules change", async () => {
    const fake = fakePathMapService([{ Source: "/agent", Destination: "/host" }]);
    const mapper = new PathMapper([], fake.service);
    await mapper.toHost("/agent/a.c");
    await mapper.toHost("/agent/a.c");
    await mapper.toHost("/agent/b.c");
    assert.equal(fake.gets(), 1);
    fake.fireChanged();
    await mapper.toHost("/agent/a.c");
    assert.equal(fake.gets(), 2);
});

// If PathMap.get fails, the configured rules still work.
test("toHost works when the agent cannot list its rules", async () => {
    const fake = fakePathMapService(new Error("PathMap.get failed"));
    const mapper = new PathMapper([{ source: "/build", destination: "/ws" }], fake.service);
    assert.equal(await mapper.toHost("/build/a.c"), "/ws/a.c");
});

// The agent applies our rules to breakpoint files itself, so host paths
// are sent as they are.
test("toTarget leaves configured rules to an agent with PathMap", async () => {
    const fake = fakePathMapService([]);
    const mapper = new PathMapper([{ source: "/build", destination: "/ws" }], fake.service);
    assert.equal(mapper.agentMapsPaths, true);
    assert.equal(await mapper.toTarget("/ws/a.c"), "/ws/a.c");
});

// Without a PathMap service, our rules are applied in reverse here.
test("toTarget maps configured rules in reverse without PathMap", async () => {
    const mapper = new PathMapper([{ source: "/build", destination: "/ws" }], undefined);
    assert.equal(mapper.agentMapsPaths, false);
    assert.equal(await mapper.toTarget("/ws/a.c"), "/build/a.c");
    assert.equal(await mapper.toTarget("/other/a.c"), "/other/a.c");
});

// Agent rules for all contexts and for this host are used in reverse.
// Rules for some contexts, other hosts, or with empty fields are not.
test("toTarget maps agent rules for this host in reverse", async () => {
    const fake = fakePathMapService([
        { Source: "/s-plain", Destination: "/plain" },
        { Source: "/s-all", Destination: "/all", ContextQuery: "*" },
        { Source: "/s-local", Destination: "/local", Host: "LOCALHOST" },
        {
            Source: "/s-this",
            Destination: "/this",
            Host: os.hostname().toUpperCase(),
        },
        {
            Source: "/s-query",
            Destination: "/query",
            ContextQuery: "Name=cpu0",
        },
        {
            Source: "/s-remote",
            Destination: "/remote",
            Host: "some-other-host.invalid",
        },
        { Source: "/s-nodest", Destination: "" },
        { Destination: "/nosrc" },
    ]);
    const mapper = new PathMapper([], fake.service);
    const expected: [string, string][] = [
        ["/plain/a.c", "/s-plain/a.c"],
        ["/all/a.c", "/s-all/a.c"],
        ["/local/a.c", "/s-local/a.c"],
        ["/this/a.c", "/s-this/a.c"],
        ["/query/a.c", "/query/a.c"],
        ["/remote/a.c", "/remote/a.c"],
        ["/nosrc/a.c", "/nosrc/a.c"],
    ];
    for (const [host, target] of expected) {
        assert.equal(await mapper.toTarget(host), target, host);
    }
});

// Rules like add-pathmap-entry "target=/host" "/" map binaries the tracker
// reports in the target's file system. Source paths must not get the
// "target=" prefix, the debug information never contains it.
test("toTarget does not reverse rules for the target file system", async () => {
    const fake = fakePathMapService([
        { Source: "target=/host/disk3", Destination: "/disk3" },
        { Source: "/build", Destination: "/disk3/ws" },
    ]);
    const agent = new PathMapper([], fake.service);
    assert.equal(await agent.toTarget("/disk3/src/a.c"), "/disk3/src/a.c");
    assert.equal(await agent.toTarget("/disk3/ws/a.c"), "/build/a.c");
    const local = new PathMapper([{ source: "target=/host/disk3", destination: "/disk3" }], undefined);
    assert.equal(await local.toTarget("/disk3/src/a.c"), "/disk3/src/a.c");
});

// PathMap.get also returns our own rules. They must not be used as agent
// rules, since the agent already applies them.
test("toTarget skips the rules this client sent itself", async () => {
    const agentRules: PathMapRuleProperties[] = [];
    const fake = fakePathMapService(agentRules);
    const mapper = new PathMapper([{ source: "/build", destination: "/ws" }], fake.service);
    await mapper.apply();
    // The agent lists our own rules too, here with another destination.
    agentRules.push({ ...fake.sets[0][0], Destination: "/elsewhere" });
    assert.equal(await mapper.toTarget("/elsewhere/a.c"), "/elsewhere/a.c");
});

// The common tail of the two paths is dropped, so the rule also maps the
// other files of the source tree.
test("deriveRule maps the differing directory prefixes", () => {
    assert.deepEqual(deriveRule("/build/fw/src/drv/uart.c", "/home/me/fw/src/drv/uart.c"), {
        source: "/build",
        destination: "/home/me",
    });
    assert.deepEqual(deriveRule("C:\\work\\fw\\main.c", "/home/me/fw/main.c"), {
        source: "C:/work",
        destination: "/home/me",
    });
});

// A rule for the root directory would not match anything, so at least one
// directory is kept in both prefixes.
test("deriveRule keeps a directory besides the root", () => {
    assert.deepEqual(deriveRule("/src/a.c", "/home/me/src/a.c"), {
        source: "/src",
        destination: "/home/me/src",
    });
    assert.deepEqual(deriveRule("/home/me/src/a.c", "/src/a.c"), {
        source: "/home/me/src",
        destination: "/src",
    });
});

// Different file names: the rule maps only this file.
test("deriveRule maps a renamed file by itself", () => {
    assert.deepEqual(deriveRule("/build/a.c", "/home/me/b.c"), {
        source: "/build/a.c",
        destination: "/home/me/b.c",
    });
    assert.equal(mapPrefix("/build/a.c", "/build/a.c", "/home/me/b.c"), "/home/me/b.c");
});

// A rule added while debugging is used for later lookups and sent to the
// agent together with the configured rules.
test("addRule maps new paths and updates the agent", async () => {
    const dir = tempDir("fw/a.c");
    const fake = fakePathMapService([]);
    const mapper = new PathMapper([{ source: "/s1", destination: "/d1" }], fake.service);
    assert.equal(await mapper.toHost("/build/fw/a.c"), "/build/fw/a.c");
    await mapper.addRule({ source: "/build", destination: dir });
    await mapper.addRule({ source: "/build", destination: dir });
    assert.equal(await mapper.toHost("/build/fw/a.c"), `${dir}/fw/a.c`);
    assert.equal(fake.sets.length, 2);
    assert.deepEqual(
        fake.sets[1].map((r) => r.Source),
        ["/s1", "/build"],
    );
    fs.rmSync(dir, { recursive: true });
});

test("replaceRules clears the last rule locally and on the agent", async () => {
    const fake = fakePathMapService([]);
    const rule = { source: "/compiled", destination: "/host" };
    const mapper = new PathMapper([rule], fake.service);
    assert.equal(await mapper.toHost("/compiled/a.c"), "/host/a.c");
    await mapper.replaceRules([], [rule]);
    assert.deepEqual(fake.sets, [[]]);
    assert.deepEqual(mapper.getRules(), []);
    assert.equal(await mapper.toHost("/compiled/a.c"), "/compiled/a.c");
});

test("replaceRules edits paths and reverses them without PathMap", async () => {
    const mapper = new PathMapper([{ source: "/old", destination: "/host" }], undefined);
    assert.equal(await mapper.toTarget("/host/a.c"), "/old/a.c");
    await mapper.replaceRules([{ source: "/new", destination: "/host" }]);
    assert.equal(await mapper.toHost("/new/a.c"), "/host/a.c");
    assert.equal(await mapper.toTarget("/host/a.c"), "/new/a.c");
    await mapper.replaceRules([]);
    assert.equal(await mapper.toTarget("/host/a.c"), "/host/a.c");
});

test("replaceRules changes the priority of existing mapped files", async () => {
    const dir = tempDir("first/a.c", "second/a.c");
    try {
        const first = { source: "/build", destination: `${dir}/first` };
        const second = { source: "/build", destination: `${dir}/second` };
        const mapper = new PathMapper([first, second], undefined);
        assert.equal(await mapper.toHost("/build/a.c"), `${dir}/first/a.c`);
        await mapper.replaceRules([second, first]);
        assert.equal(await mapper.toHost("/build/a.c"), `${dir}/second/a.c`);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test("failed replacement preserves rules and reports the error", async () => {
    const fake = fakePathMapService([]);
    fake.service.set = async () => {
        throw new Error("PathMap.set failed");
    };
    const original = { source: "/compiled", destination: "/host" };
    const mapper = new PathMapper([original], fake.service);
    await assert.rejects(mapper.replaceRules([]), /PathMap.set failed/);
    assert.deepEqual(mapper.getRules(), [original]);
    await assert.rejects(mapper.addRule({ source: "/new", destination: "/other" }), /PathMap.set failed/);
    assert.deepEqual(mapper.getRules(), [original]);
});

test("stale edits cannot overwrite a newly located source rule", async () => {
    const mapper = new PathMapper([], undefined);
    const snapshot = mapper.getRules();
    const located = { source: "/build", destination: "/host" };
    const adding = mapper.addRule(located);
    const editing = mapper.replaceRules([], snapshot);
    await adding;
    await assert.rejects(editing, /Path map rules changed/);
    assert.deepEqual(mapper.getRules(), [located]);
    await mapper.replaceRules([], [located]);
    assert.deepEqual(mapper.getRules(), []);
});

test("getRules and replacement inputs do not expose mutable state", async () => {
    const mapper = new PathMapper([], undefined);
    const rule = { source: "/build", destination: "/host" };
    const replacing = mapper.replaceRules([rule]);
    rule.destination = "/changed";
    await replacing;
    const snapshot = mapper.getRules();
    snapshot[0].destination = "/changed-again";
    snapshot.push(rule);
    assert.deepEqual(mapper.getRules(), [{ source: "/build", destination: "/host" }]);
});

test("scope parsing preserves IDs and queries without broadening invalid rules", () => {
    const base = { source: "/build", destination: "/host" };
    const valid = [
        base,
        { ...base, context: "cpu0" },
        { ...base, contextQuery: "ID=cpu0" },
        { ...base, contextQuery: "/server/**/HasState=true" },
    ];
    assert.deepEqual(parsePathMapConfig(valid), { rules: valid, errors: [] });
    for (const scope of [
        { context: "" },
        { context: "   " },
        { context: 12 },
        { contextQuery: "" },
        { contextQuery: "  " },
        { contextQuery: false },
        { context: "cpu0", contextQuery: "*" },
    ]) {
        const result = parsePathMapConfig([{ ...base, ...scope }]);
        assert.deepEqual(result.rules, []);
        assert.equal(result.errors.length, 1);
        assert.equal(pathMapProblems([{ ...base, ...scope }], () => true).length, 1);
    }
});

test("apply and replacement send exact ContextQuery wire properties", async () => {
    const fake = fakePathMapService([]);
    const base = { source: "/build", destination: "/host" };
    const mapper = new PathMapper(
        [
            base,
            { ...base, context: "cpu0" },
            { ...base, contextQuery: "/server/**/HasState=true" },
            { ...base, context: 'cpu/"a\\b' },
        ],
        fake.service,
    );
    await mapper.apply();
    const expected = [undefined, "ID=cpu0", "/server/**/HasState=true", "ID=" + JSON.stringify('cpu/"a\\b')];
    assert.deepEqual(
        fake.sets[0].map((r) => r.ContextQuery),
        expected,
    );
    assert.equal("ContextQuery" in fake.sets[0][0], false);
    for (const rule of fake.sets[0]) {
        assert.equal("context" in rule, false);
        assert.equal("contextQuery" in rule, false);
    }
    await mapper.replaceRules(mapper.getRules());
    assert.deepEqual(fake.sets[1], fake.sets[0]);
    assert.equal(pathMapContextQuery({ context: "cpu0" }), "ID=cpu0");
});

test("identical compiled paths are mapped and cached separately per context", async () => {
    const mapper = new PathMapper(
        [
            { source: "/build", destination: "/cpu0", context: "cpu0" },
            { source: "/build", destination: "/cpu1", contextQuery: "ID=cpu1" },
            { source: "/build", destination: "/all" },
        ],
        undefined,
    );
    for (let i = 0; i < 2; i++) {
        assert.equal(await mapper.toHost("/build/a.c", "cpu0"), "/cpu0/a.c");
        assert.equal(await mapper.toHost("/build/a.c", "cpu1"), "/cpu1/a.c");
        assert.equal(await mapper.toHost("/build/a.c", "cpu2"), "/all/a.c");
        assert.equal(await mapper.toHost("/build/a.c"), "/all/a.c");
    }
});

test("ID filters quote special characters and do not match another context", async () => {
    const id = 'cpu/"a\\b';
    const mapper = new PathMapper([{ source: "/build", destination: "/scoped", context: id }], undefined);
    assert.equal(await mapper.toHost("/build/a.c", id), "/scoped/a.c");
    assert.equal(await mapper.toHost("/build/a.c", "cpu"), "/build/a.c");
    assert.equal(await mapper.toHost("/build/a.c"), "/build/a.c");
});

test("query scopes select groups and invalidate when contexts change", async () => {
    let members = ["cpu0", "cpu1"];
    const queries: string[] = [];
    const query = "/server/**/HasState=true";
    const mapper = new PathMapper(
        [{ source: "/build", destination: "/group", contextQuery: query }],
        undefined,
        async (q) => {
            queries.push(q);
            return members;
        },
    );
    assert.equal(await mapper.toHost("/build/a.c", "cpu0"), "/group/a.c");
    assert.equal(await mapper.toHost("/build/b.c", "cpu1"), "/group/b.c");
    assert.equal(await mapper.toHost("/build/a.c", "cpu2"), "/build/a.c");
    assert.deepEqual(queries, [query]);
    members = ["cpu2"];
    mapper.invalidateContexts();
    assert.equal(await mapper.toHost("/build/a.c", "cpu0"), "/build/a.c");
    assert.equal(await mapper.toHost("/build/a.c", "cpu2"), "/group/a.c");
    assert.deepEqual(queries, [query, query]);
});

test("query errors are explicit and a failed query can be retried", async () => {
    const rules = [
        {
            source: "/build",
            destination: "/group",
            contextQuery: "HasState=true",
        },
    ];
    const unsupported = new PathMapper(rules, undefined);
    await assert.rejects(unsupported.toHost("/build/a.c", "cpu0"), /does not provide ContextQuery/);
    assert.equal(await unsupported.toHost("/build/a.c"), "/build/a.c");
    let fail = true;
    const mapper = new PathMapper(rules, undefined, async () => {
        if (fail) {
            throw new Error("Invalid query");
        }
        return ["cpu0"];
    });
    await assert.rejects(mapper.toHost("/build/a.c", "cpu0"), /Invalid query/);
    fail = false;
    assert.equal(await mapper.toHost("/build/a.c", "cpu0"), "/group/a.c");
});

test("agent-provided scoped rules apply only to matching contexts in both directions", async () => {
    const fake = fakePathMapService([
        { Source: "/build0", Destination: "/host", ContextQuery: "ID=cpu0" },
        {
            Source: "/build1",
            Destination: "/host",
            ContextQuery: "/server/**/HasState=true",
        },
    ]);
    const mapper = new PathMapper([], fake.service, async () => ["cpu1"]);
    assert.equal(await mapper.toHost("/build0/a.c", "cpu0"), "/host/a.c");
    assert.equal(await mapper.toHost("/build0/a.c", "cpu1"), "/build0/a.c");
    assert.equal(await mapper.toHost("/build1/a.c", "cpu1"), "/host/a.c");
    assert.equal(await mapper.toTarget("/host/a.c", "cpu0"), "/build0/a.c");
    assert.equal(await mapper.toTarget("/host/a.c", "cpu1"), "/build1/a.c");
    assert.equal(await mapper.toTarget("/host/a.c", "cpu2"), "/host/a.c");
    assert.equal(await mapper.toTarget("/host/a.c"), "/host/a.c");
});

test("scoped reverse mappings without PathMap require context and never leak globally", async () => {
    const rule = { source: "/build", destination: "/host", context: "cpu0" };
    const mapper = new PathMapper([rule], undefined);
    assert.equal(await mapper.toTarget("/host/a.c", "cpu0"), "/build/a.c");
    assert.equal(await mapper.toTarget("/host/a.c", "cpu1"), "/host/a.c");
    await assert.rejects(mapper.toTarget("/host/a.c"), /needs a context ID/);
    const fake = fakePathMapService([]);
    const agent = new PathMapper([rule], fake.service);
    assert.equal(await agent.toTarget("/host/a.c"), "/host/a.c");
    assert.equal(await agent.toTarget("/host/a.c", "cpu0"), "/host/a.c");
});

test("adding the same path for distinct contexts retains both scopes", async () => {
    const mapper = new PathMapper([], undefined);
    const base = { source: "/build", destination: "/host" };
    await mapper.addRule({ ...base, context: "cpu0" });
    await mapper.addRule({ ...base, contextQuery: "ID=cpu0" });
    await mapper.addRule({ ...base, context: "cpu1" });
    await mapper.addRule(base);
    assert.equal(mapper.getRules().length, 3);
});

test("in-flight query results do not restore stale mappings after invalidation", async () => {
    let finish: (ids: string[]) => void = () => {
        throw new Error("Query was not started");
    };
    let calls = 0;
    const mapper = new PathMapper(
        [
            {
                source: "/build",
                destination: "/host",
                contextQuery: "HasState=true",
            },
        ],
        undefined,
        async () => {
            calls++;
            if (calls === 1) {
                return new Promise<string[]>((resolve) => {
                    finish = resolve;
                });
            }
            return [];
        },
    );
    const pending = mapper.toHost("/build/a.c", "cpu0");
    mapper.invalidateContexts();
    finish(["cpu0"]);
    await pending;
    assert.equal(await mapper.toHost("/build/a.c", "cpu0"), "/build/a.c");
    assert.equal(calls, 2);
});
