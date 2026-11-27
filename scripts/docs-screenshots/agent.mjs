/*
 * A stand-in TCF agent for capture.mjs, so that the screenshots need no
 * Simics. It answers the commands that the extension sends with a small
 * made-up target: the Linux example of docs/debugging/call-stack.md, with one
 * thread stopped in workspace/src/server.c. Nothing here comes from a real
 * target. The reply formats are those of the TCF services, see the tcf skill.
 */
import net from "node:net";
import path from "node:path";

const ESC = 3;
const big = (v) => BigInt(v);
const toJson = (v) =>
    JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `\u0000big:${x}` : x)).replace(/"\\u0000big:(-?\d+)"/g, "$1");
const parse = (text) =>
    text === ""
        ? undefined
        : JSON.parse(text, (_k, v, ctx) =>
              typeof v === "number" && !Number.isSafeInteger(v) && /^-?\d+$/.test(ctx.source) ? BigInt(ctx.source) : v,
          );
const b64le = (value, size) => {
    const b = Buffer.alloc(size);
    let v = BigInt.asUintN(size * 8, big(value));
    for (let i = 0; i < size; i++, v >>= 8n) {
        b[i] = Number(v & 0xffn);
    }
    return b.toString("base64");
};

export function createAgent({ workspace }) {
    const source = path.join(workspace, "src", "server.c");

    // ---- Functions and lines -------------------------------------------
    const functions = [
        {
            name: "checksum",
            addr: 0x401000n,
            size: 0x50,
            lines: [
                [0x00, 5],
                [0x10, 7],
                [0x20, 8],
                [0x30, 9],
                [0x40, 11],
            ],
        },
        {
            name: "handle_request",
            addr: 0x401050n,
            size: 0x50,
            lines: [
                [0x00, 14],
                [0x10, 16],
                [0x20, 17],
                [0x30, 19],
                [0x40, 20],
            ],
        },
        {
            name: "serve",
            addr: 0x4010a0n,
            size: 0x30,
            lines: [
                [0x00, 23],
                [0x10, 26],
                [0x20, 27],
            ],
        },
        {
            name: "main",
            addr: 0x4010d0n,
            size: 0x40,
            lines: [
                [0x00, 31],
                [0x10, 33],
                [0x20, 34],
                [0x30, 35],
            ],
        },
        { name: "default_idle", addr: 0xffffffff81c2a4d0n, size: 0x40 },
        { name: "do_idle", addr: 0xffffffff810f2b10n, size: 0x200 },
        { name: "schedule", addr: 0xffffffff81c1f3a0n, size: 0x80 },
        { name: "kthreadd", addr: 0xffffffff810c9e60n, size: 0x180 },
        { name: "worker_thread", addr: 0xffffffff810c1a40n, size: 0x300 },
        { name: "start_kernel", addr: 0xffffffff82e1c0a0n, size: 0x400 },
    ];
    const fn = (name) => functions.find((f) => f.name === name);
    const functionAt = (addr) => functions.find((f) => addr >= f.addr && addr < f.addr + big(f.size));
    const at = (name, offset) => fn(name).addr + big(offset);

    // ---- Run control contexts ------------------------------------------
    const contexts = new Map();
    const order = [];
    const add = (names, frames) => {
        const id = names.join(".");
        const parent = names.length > 1 ? names.slice(0, -1).join(".") : undefined;
        contexts.set(id, { id, name: names.at(-1), parent, frames });
        order.push(id);
        return id;
    };
    const idle = [at("default_idle", 0x12), at("do_idle", 0x1c8)];
    add(["Linux"]);
    add(["Linux", "Kernel"]);
    add(["Linux", "Kernel", "Other"]);
    add(["Linux", "Kernel", "Other", "core[0][0]"], [at("start_kernel", 0x3a4)]);
    add(["Linux", "Kernel", "Idle"]);
    add(["Linux", "Kernel", "Idle", "core[0][0]"], idle);
    add(["Linux", "Kernel", "Idle", "core[1][0]"], idle);
    add(["Linux", "Kernel", "Threads"]);
    add(["Linux", "Kernel", "Threads", "kthreadd"], [at("schedule", 0x4e), at("kthreadd", 0x121)]);
    add(["Linux", "Kernel", "Threads", "kworker/0:0"], [at("schedule", 0x4e), at("worker_thread", 0x2b0)]);
    add(["Linux", "Userspace"]);
    add(["Linux", "Userspace", "init"]);
    const focus = add(
        ["Linux", "Userspace", "init", "init"],
        [at("checksum", 0x34), at("handle_request", 0x38), at("serve", 0x28), at("main", 0x28)],
    );
    add(["Linux", "Userspace", "rc"]);
    add(["Linux", "Userspace", "rc", "rc"], [0x7f3a5c41e9a2n]);
    add(["Linux", "Userspace", "udevd"]);
    add(["Linux", "Userspace", "udevd", "udevd"], [0x7f81d20c37f5n]);
    const threads = order.filter((id) => contexts.get(id).frames);
    const children = (parent) => order.filter((id) => contexts.get(id).parent === parent);
    const rcContext = (id) => {
        const c = contexts.get(id);
        return {
            ID: id,
            ...(c.parent && { ParentID: c.parent }),
            Name: c.name,
            IsContainer: !c.frames,
            HasState: !!c.frames,
            CanSuspend: true,
            CanResume: 0x3f,
            ...(c.frames && { ProcessID: c.parent }),
            RCGroup: "Linux",
        };
    };
    const frameOf = (frameId) => {
        const [ctx, index] = frameId.split("#");
        const c = contexts.get(ctx);
        return c?.frames && index !== undefined
            ? { ctx, index: Number(index), ip: c.frames[Number(index)] }
            : undefined;
    };

    // ---- Variables of the top frame of the focused thread ---------------
    const types = {
        "type:u8": { Name: "uint8_t", TypeClass: 1, Size: 1 },
        "type:u8p": { TypeClass: 4, Size: 8, BaseTypeID: "type:u8" },
        "type:size_t": { Name: "size_t", TypeClass: 1, Size: 8 },
        "type:u32": { Name: "uint32_t", TypeClass: 1, Size: 4 },
    };
    const locals = [
        { name: "data", type: "type:u8p", value: 0x601040n },
        { name: "len", type: "type:size_t", value: 26n },
        { name: "sum", type: "type:u32", value: 0x5a3cn },
        { name: "i", type: "type:size_t", value: 7n },
    ];
    const registers = [
        ["rax", 0x5a3cn],
        ["rbx", 0n],
        ["rcx", 7n],
        ["rdx", 0x47n],
        ["rsi", 26n],
        ["rdi", 0x601040n],
        ["rbp", 0x7ffd4c2e1b40n],
        ["rsp", 0x7ffd4c2e1b20n],
        ["rip", at("checksum", 0x34)],
        ["eflags", 0x202n],
    ];
    const expression = (id) => {
        const local = locals.find((l) => `expr:${l.name}` === id);
        if (local) {
            return local;
        }
        const m = /^script:(.*)$/.exec(id);
        const text = m?.[1].trim();
        const named = locals.find((l) => l.name === text);
        if (named) {
            return named;
        }
        if (text === "$sp" || text === "$rsp") {
            return { name: text, type: "type:size_t", value: 0x7ffd4c2e1b20n };
        }
        return text && /^(0x[0-9a-f]+|\d+)$/i.test(text)
            ? { name: text, type: "type:size_t", value: big(text) }
            : undefined;
    };

    // ---- Memory ----------------------------------------------------------
    const image = Buffer.alloc(0x400);
    image.writeUInt32LE(4, 0x00); // fd
    image.writeUInt32LE(26, 0x04); // length
    image.writeUInt32LE(0x5a3c, 0x08); // checksum
    image.writeBigUInt64LE(0x601040n, 0x10); // data
    image.writeBigUInt64LE(0x601080n, 0x18);
    image.write("GET /index.html HTTP/1.1\r\n", 0x40, "latin1");
    image.write("HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\nHello, world!", 0x80, "latin1");
    image.write("listening on port %d\n\0bad request\n\0/dev/ttyS0\0", 0x100, "latin1");
    image.writeDoubleLE(3.14159, 0x140);
    image.writeUInt32LE(0xdeadbeef, 0x148);
    const IMAGE_BASE = 0x601000n;
    const readMemory = (address, size) => {
        const out = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {
            const offset = address + big(i) - IMAGE_BASE;
            if (offset >= 0n && offset < big(image.length)) {
                out[i] = image[Number(offset)];
            }
        }
        return out;
    };

    // ---- Per connection state --------------------------------------------
    let snapshots = ["after-boot", "before-test"];
    const sockets = new Set();
    let suspended = true;

    function connection(socket) {
        sockets.add(socket);
        const breakpoints = new Map();
        const memoryMaps = new Map();
        let pathMap = [];
        const send = (...fields) => {
            const parts = [];
            for (const f of fields) {
                const bytes = Buffer.from(f, "utf8");
                const escaped = [];
                for (const b of bytes) {
                    escaped.push(b);
                    if (b === ESC) {
                        escaped.push(0);
                    }
                }
                parts.push(Buffer.from(escaped), Buffer.from([0]));
            }
            parts.push(Buffer.from([ESC, 1]));
            socket.write(Buffer.concat(parts));
        };
        const event = (service, name, ...args) => send("E", service, name, ...args.map(toJson));
        const bpStatus = (bp) => {
            const f = bp.Location ? fn(String(bp.Location)) : undefined;
            const address = bp.File ? at("checksum", 0x30) : (f?.addr ?? 0x401050n);
            return { Instances: [{ LocationContext: bp.ContextIds?.[0] ?? focus, Address: address, HitCount: 0 }] };
        };
        const stop = (reason, data = {}) => {
            suspended = true;
            event("RunControl", "containerSuspended", focus, contexts.get(focus).frames[0], reason, data, threads);
        };
        const fileBreakpoints = () => [...breakpoints.values()].filter((bp) => bp.File).map((bp) => bp.ID);

        const handlers = {
            "RunControl.getChildren": (parent) => [null, children(parent ?? undefined)],
            "RunControl.getContext": (id) =>
                contexts.has(id) ? [null, rcContext(id)] : [{ Code: 1, Format: "Invalid context" }, null],
            "RunControl.getState": (id) => [null, suspended, contexts.get(id)?.frames?.[0] ?? 0, "Suspended", {}],
            "RunControl.suspend": () => {
                setTimeout(() => stop("Suspended"), 50);
                return [null];
            },
            "RunControl.resume": (_id, mode) => {
                suspended = false;
                setTimeout(() => event("RunControl", "containerResumed", threads), 10);
                setTimeout(() => (mode ? stop("Step") : stop("Breakpoint", { BPs: fileBreakpoints() })), 400);
                return [null];
            },
            "StackTrace.getChildrenRange": (ctx, start, end) => {
                const frames = contexts.get(ctx)?.frames ?? [];
                return [null, frames.map((_f, i) => `${ctx}#${i}`).slice(start, end + 1)];
            },
            "StackTrace.getChildren": (ctx) => [
                null,
                (contexts.get(ctx)?.frames ?? []).map((_f, i) => `${ctx}#${i}`).reverse(),
            ],
            "StackTrace.getContext": (ids) => [
                ids.map((id) => {
                    const f = frameOf(id);
                    return f ? { ID: id, ParentID: f.ctx, IP: f.ip, TopFrame: f.index === 0, Index: f.index } : null;
                }),
                null,
            ],
            "Symbols.findByAddr": (_ctx, addr) => {
                const f = functionAt(big(addr));
                return f ? [null, [`fn:${f.name}`]] : [{ Code: 22, Format: "Symbol not found" }, null];
            },
            "Symbols.getContext": (id) => {
                const f = id.startsWith("fn:") ? fn(id.slice(3)) : undefined;
                if (f) {
                    return [null, { ID: id, Name: f.name, Class: 3, Address: f.addr, Size: f.size }];
                }
                const local = locals.find((l) => `sym:${l.name}` === id);
                if (local) {
                    return [
                        null,
                        { ID: id, Name: local.name, Class: 2, TypeID: local.type, Size: types[local.type].Size },
                    ];
                }
                return types[id]
                    ? [null, { ID: id, Class: 4, ...types[id] }]
                    : [{ Code: 22, Format: "Symbol not found" }, null];
            },
            "Symbols.getChildren": () => [null, []],
            "LineNumbers.mapToSource": (_ctx, start) => {
                const f = functionAt(big(start));
                if (!f?.lines) {
                    return [null, []];
                }
                const offset = Number(big(start) - f.addr);
                const i = f.lines.findLastIndex(([o]) => o <= offset);
                const end = f.lines[i + 1]?.[0] ?? f.size;
                const line = f.lines[i][1];
                return [
                    null,
                    [
                        {
                            File: source,
                            SLine: line,
                            ELine: line + 1,
                            SAddr: f.addr + big(f.lines[i][0]),
                            EAddr: f.addr + big(end),
                            IsStmt: true,
                        },
                    ],
                ];
            },
            "Expressions.getChildren": (scope) => [
                null,
                scope === `${focus}#0` ? locals.map((l) => `expr:${l.name}`) : [],
            ],
            "Expressions.getContext": (id) => {
                const e = expression(id);
                return e
                    ? [
                          null,
                          {
                              ID: id,
                              SymbolID: `sym:${e.name}`,
                              Expression: e.name,
                              Type: e.type,
                              Class: types[e.type].TypeClass,
                              Size: types[e.type].Size,
                          },
                      ]
                    : [{ Code: 1, Format: "Invalid expression" }, null];
            },
            "Expressions.create": (_ctx, _lang, script) => {
                const id = `script:${script}`;
                const e = expression(id);
                return e
                    ? [
                          null,
                          {
                              ID: id,
                              Expression: script,
                              Type: e.type,
                              Class: types[e.type].TypeClass,
                              Size: types[e.type].Size,
                          },
                      ]
                    : [{ Code: 1, Format: `Cannot evaluate '${script}'` }, null];
            },
            "Expressions.evaluate": (id) => {
                const e = expression(id);
                const t = e && types[e.type];
                return e
                    ? [b64le(e.value, t.Size), null, { Class: t.TypeClass, Type: e.type, BigEndian: false }]
                    : [null, { Code: 1, Format: "Invalid expression" }, null];
            },
            "Expressions.dispose": () => [null],
            "Registers.getChildren": (parent) => [
                null,
                contexts.has(parent) || frameOf(parent) ? registers.map(([name]) => `reg:${name}`) : [],
            ],
            "Registers.getContext": (id) => [null, { ID: id, Name: id.slice(4), Size: 8, Readable: true }],
            "Registers.get": (id) => [null, b64le(registers.find(([name]) => `reg:${name}` === id)?.[1] ?? 0n, 8)],
            "Memory.getChildren": (parent) => [
                null,
                parent === null || parent === undefined ? ["board.mb.phys_mem"] : [],
            ],
            "Memory.getContext": (id) =>
                id === "board.mb.phys_mem"
                    ? [null, { ID: id, Name: id, AddressSize: 8, BigEndian: false, AccessTypes: ["physical"] }]
                    : contexts.has(id)
                      ? [
                            null,
                            {
                                ID: id,
                                Name: contexts.get(id).name,
                                AddressSize: 8,
                                BigEndian: false,
                                AccessTypes: ["instruction", "data", "virtual"],
                            },
                        ]
                      : [{ Code: 1, Format: "Invalid context" }, null],
            "Memory.get": (_id, address, _word, size) => [
                readMemory(big(address), size).toString("base64"),
                null,
                null,
            ],
            "Memory.set": (id, address, _word, size, _mode, data) => {
                const bytes = Buffer.from(data, "base64");
                const offset = big(address) - IMAGE_BASE;
                if (offset >= 0n && offset + big(size) <= big(image.length)) {
                    bytes.copy(image, Number(offset));
                }
                setTimeout(() => event("Memory", "memoryChanged", id, [{ addr: big(address), size }]), 10);
                return [null];
            },
            "MemoryMap.get": (id) => [
                null,
                [
                    ...[...memoryMaps.entries()].flatMap(([ctx, regions]) => (ctx === "" || ctx === id ? regions : [])),
                    {
                        FileName: "/home/user/linux/vmlinux",
                        Addr: 0xffffffff81000000n,
                        Size: 0x2000000,
                        Offs: 0x200000,
                        Flags: 5,
                    },
                ],
            ],
            "MemoryMap.set": (id, regions) => {
                memoryMaps.set(id, regions ?? []);
                setTimeout(() => event("MemoryMap", "changed", id), 10);
                return [null];
            },
            "PathMap.get": () => [
                null,
                [...pathMap, { ID: "simics0", Source: "/build/linux", Destination: "/home/user/linux" }],
            ],
            "PathMap.set": (rules) => {
                pathMap = rules ?? [];
                setTimeout(() => event("PathMap", "changed"), 10);
                return [null];
            },
            "ContextQuery.query": (query) => {
                const id = /^ID="?([^"]*)"?$/.exec(query)?.[1];
                return [null, id ? order.filter((c) => c === id) : threads];
            },
            "Breakpoints.getCapabilities": () => [
                null,
                {
                    ID: "",
                    Location: true,
                    Condition: true,
                    FileLine: true,
                    IgnoreCount: true,
                    AccessMode: 15,
                    ContextIds: true,
                    ContextQuery: true,
                },
            ],
            "Breakpoints.add": (bp) => {
                breakpoints.set(bp.ID, bp);
                setTimeout(() => event("Breakpoints", "status", bp.ID, bpStatus(bp)), 10);
                return [null];
            },
            "Breakpoints.change": (bp) => handlers["Breakpoints.add"](bp),
            "Breakpoints.getStatus": (id) => [null, breakpoints.has(id) ? bpStatus(breakpoints.get(id)) : {}],
            "Breakpoints.enable": () => [null],
            "Breakpoints.disable": () => [null],
            "Breakpoints.remove": (ids) => {
                ids.forEach((id) => breakpoints.delete(id));
                return [null];
            },
            "CommandLine.connect": () => {
                setTimeout(() => event("CommandLine", "write", "simics> "), 50);
                return [null];
            },
            "CommandLine.disconnect": () => [null],
            "CommandLine.sizeChanged": () => [null],
            "CommandLine.keyPressed": () => [null],
            "CommandLine.positionChanged": () => [null],
            "CommandLine.selectionChanged": () => [null],
            "CommandLine.clipboardChanged": () => [null],
            "SimUtils.getCommands": () => [
                null,
                ["getCommands", "getSnapshotIDs", "takeSnapshot", "restoreSnapshot", "deleteSnapshot"],
            ],
            "SimUtils.getSnapshotIDs": () => [null, snapshots],
            "SimUtils.takeSnapshot": (id) => {
                snapshots = [...snapshots, id];
                setTimeout(() => event("SimUtils", "snapshotsChanged"), 10);
                return [null];
            },
            "SimUtils.restoreSnapshot": () => [null],
            "SimUtils.deleteSnapshot": (id) => {
                snapshots = snapshots.filter((s) => s !== id);
                setTimeout(() => event("SimUtils", "snapshotsChanged"), 10);
                return [null];
            },
        };
        const services = [...new Set(Object.keys(handlers).map((k) => k.split(".")[0])), "Locator"];

        let fields = [];
        let part = [];
        let esc = false;
        const message = (m) => {
            if (m[0] !== "C") {
                return;
            }
            const [, token, service, command, ...args] = m;
            const handler = handlers[`${service}.${command}`];
            if (!handler) {
                agent.unknown.add(`${service}.${command}`);
                send("N", token);
                return;
            }
            try {
                send("R", token, ...handler(...args.map(parse)).map((v) => (v === undefined ? "" : toJson(v))));
            } catch (err) {
                agent.errors.push(`${service}.${command}: ${err.stack}`);
                send("R", token, toJson({ Code: 1, Format: String(err) }));
            }
        };
        socket.on("data", (data) => {
            for (const b of data) {
                if (esc) {
                    esc = false;
                    if (b === 0) {
                        part.push(ESC);
                    } else if (b === 1) {
                        message(fields);
                        fields = [];
                        part = [];
                    }
                } else if (b === ESC) {
                    esc = true;
                } else if (b === 0) {
                    fields.push(Buffer.from(part).toString("utf8"));
                    part = [];
                } else {
                    part.push(b);
                }
            }
        });
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => sockets.delete(socket));
        send("E", "Locator", "Hello", toJson(services));
    }

    const server = net.createServer(connection);
    const agent = {
        unknown: new Set(),
        errors: [],
        focus,
        threads,
        listen: (port) =>
            new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve)),
        close: () => {
            sockets.forEach((s) => s.destroy());
            return new Promise((resolve) => server.close(resolve));
        },
    };
    return agent;
}
