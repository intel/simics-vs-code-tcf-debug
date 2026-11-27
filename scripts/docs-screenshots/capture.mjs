/*
 * Takes the screenshots of the user guide: starts VS Code with the extension,
 * attaches it to the stand-in agent of agent.mjs, and saves one picture per
 * block below. It also prints what each picture shows, as text, so that the
 * result can be checked without looking at every pixel.
 *
 * Run it with run.sh, see .github/skills/docs-screenshots/SKILL.md.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAgent } from "./agent.mjs";
import { launch, workspace } from "./vscode.mjs";

if (process.env.SHOTS_SANDBOX !== "1") {
    // Outside the sandbox the pictures would show paths of this machine,
    // and port 1534 may belong to a real agent.
    console.error("Run scripts/docs-screenshots/run.sh instead, it starts this script in a sandbox.");
    process.exit(2);
}

const out = process.env.SHOTS_OUT;
/** The pictures of the last commit, to tell which ones changed. */
const before = process.env.SHOTS_BEFORE;
const firstCapture = process.env.SHOTS_FIRST_CAPTURE;
/** A picture with at most this many clearly different pixels counts as unchanged. */
const NOISE = 10;
fs.mkdirSync(path.join(out, "raw"), { recursive: true });
// Files that the example launch configuration names.
for (const f of ["build/server.elf", "build/driver.ko", "libs/.keep", "src/net.h"]) {
    fs.mkdirSync(path.dirname(path.join(workspace, f)), { recursive: true });
    fs.writeFileSync(path.join(workspace, f), f.endsWith(".h") ? "int open_port(int port);\n" : "");
}

const WIDTH = 1240;
const HEIGHT = 800;
const agent = createAgent({ workspace });
await agent.listen(1534);
const { app, page } = await launch({
    width: WIDTH,
    height: HEIGHT,
    settings: { "workbench.hover.delay": 100000, "editor.hover.enabled": false },
});
const sleep = (ms) => page.waitForTimeout(ms);
/** Waits until a scrollbar that showed during scrolling has faded out. */
const scrollbarsFaded = () => sleep(1600);
/** Moves the pointer to the title bar, which no picture shows, so that nothing in a picture is hovered. */
async function park() {
    await page.mouse.move(WIDTH / 2, 12);
    await sleep(400);
}
const shots = [];
console.log("VS Code", await app.evaluate(({ app: electron }) => electron.getVersion()));

async function shot(name, clip) {
    await page.screenshot({ path: path.join(out, "raw", `${name}.png`), ...(clip && { clip }) });
    shots.push(name);
    console.log(
        `shot ${name}: ${clip ? `${Math.round(clip.width)}x${Math.round(clip.height)} at ${Math.round(clip.x)},${Math.round(clip.y)}` : "window"}`,
    );
}

async function command(title) {
    await page.keyboard.press("F1");
    await page.locator(".quick-input-widget input").first().waitFor({ state: "visible" });
    await page.keyboard.type(title, { delay: 5 });
    await sleep(500);
    const first = await page.locator(".quick-input-widget .monaco-list-row").first().textContent();
    if (!first?.includes(title.replace(/^.*: /, "").slice(0, 20))) {
        throw new Error(`command "${title}" not found, first match: ${first}`);
    }
    await page.keyboard.press("Enter");
    await sleep(700);
}

const header = (name) => page.locator(`.part.sidebar .pane-header[aria-label="${name} Section"]`);
const pane = (name) => page.locator(`.part.sidebar .pane:has(> .pane-header[aria-label="${name} Section"])`);

async function setPanes(open) {
    const all = [
        "Variables",
        "Watch",
        "Call Stack",
        "Breakpoints",
        "Path Maps",
        "Symbol Files",
        "Consoles",
        "Snapshots",
    ];
    for (const name of all) {
        const expanded = (await header(name).getAttribute("aria-expanded")) === "true";
        if (expanded !== open.includes(name)) {
            await header(name).locator("h3").click();
            await sleep(250);
        }
    }
    await sleep(400);
}

/** The pane's box, cut below its last row. */
function paneBox(name, minHeight = 0) {
    return page.evaluate(
        ([label, min]) => {
            const head = document.querySelector(`.part.sidebar .pane-header[aria-label="${label} Section"]`);
            const r = head.parentElement.getBoundingClientRect();
            const bottoms = [...head.parentElement.querySelectorAll(".monaco-list-row")]
                .map((e) => e.getBoundingClientRect())
                .filter((b) => b.height > 0 && b.top >= r.top && b.bottom <= r.bottom + 1)
                .map((b) => b.bottom);
            const bottom = Math.max(head.getBoundingClientRect().bottom + min, ...bottoms) + 8;
            return { x: r.x, y: r.y, width: r.width, height: Math.min(r.bottom, bottom) - r.y };
        },
        [name, minHeight],
    );
}

/** The rows a pane shows, top to bottom, with the labels of their visible buttons. */
function paneRows(name) {
    return page.evaluate((label) => {
        const head = document.querySelector(`.part.sidebar .pane-header[aria-label="${label} Section"]`);
        const r = head.parentElement.getBoundingClientRect();
        const shown = (e) => {
            const b = e.getBoundingClientRect();
            return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden";
        };
        const actions = (e) =>
            [...e.querySelectorAll(".action-label")]
                .filter(shown)
                .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
                .map((a) => a.getAttribute("aria-label"))
                .join(", ");
        const rows = [...head.parentElement.querySelectorAll(".monaco-list-row")]
            .filter((e) => {
                const b = e.getBoundingClientRect();
                return b.height > 0 && b.top >= r.top && b.bottom <= r.bottom + 1;
            })
            .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
            .map((e) => {
                const state = e.getAttribute("aria-expanded");
                const mark = state === "true" ? "v " : state === "false" ? "> " : "  ";
                const acts = actions(e);
                return `${"  ".repeat(Number(e.getAttribute("aria-level") ?? 1) - 1)}${mark}${e.innerText.trim().replace(/\s+/g, " ")}${acts ? `  {${acts}}` : ""}`;
            });
        return [`title buttons: ${actions(head) || "(none shown)"}`, ...rows];
    }, name);
}

async function describePane(name) {
    console.log(`--- ${name}\n    ${(await paneRows(name)).join("\n    ")}`);
}

const union = (boxes) => {
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    return {
        x,
        y,
        width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
        height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    };
};

async function boxOf(target) {
    const box = typeof target.boundingBox === "function" ? await target.first().boundingBox() : target;
    if (!box || box.width <= 0 || box.height <= 0) {
        throw new Error("element for a callout is not shown");
    }
    return box;
}

const BADGE = 20;
const PAD = 2;
/** Where the badge of a callout box goes: a named place, or a point. */
function badgeRect(b, place = b.place) {
    if (typeof place === "object") {
        return { x: place.x, y: place.y, width: BADGE, height: BADGE };
    }
    const [x, y] = {
        left: [b.x - PAD - BADGE - 2, b.y + b.height / 2 - BADGE / 2],
        right: [b.x + b.width + PAD + 2, b.y + b.height / 2 - BADGE / 2],
        top: [b.x + b.width / 2 - BADGE / 2, b.y - PAD - BADGE - 2],
        bottom: [b.x + b.width / 2 - BADGE / 2, b.y + b.height + PAD + 2],
        inside: [b.x + b.width - BADGE - 4, b.y + 4],
        insideBottom: [b.x + b.width - BADGE - 4, b.y + b.height - BADGE - 4],
    }[place];
    return { x, y, width: BADGE, height: BADGE };
}

/** The texts and controls that a rectangle (in window coordinates) covers in a page or webview frame. */
async function covered(scope, rect) {
    const origin = scope === page ? { x: 0, y: 0 } : await scope.locator("html").boundingBox();
    return scope.evaluate(
        (r) => {
            const hit = (b) =>
                b.width > 0 &&
                b.height > 0 &&
                b.left < r.x + r.width &&
                b.right > r.x &&
                b.top < r.y + r.height &&
                b.bottom > r.y;
            const shown = (e) => {
                for (let p = e; p; p = p.parentElement) {
                    const s = getComputedStyle(p);
                    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") {
                        return false;
                    }
                }
                return true;
            };
            const hits = new Set();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if (!n.textContent.trim() || n.parentElement.closest("#shot-callouts")) {
                    continue;
                }
                const range = document.createRange();
                range.selectNodeContents(n);
                if ([...range.getClientRects()].some(hit) && shown(n.parentElement)) {
                    const p = n.parentElement;
                    hits.add(
                        `"${n.textContent.trim().slice(0, 24)}" in ${p.tagName.toLowerCase()}.${String(p.className).split(" ")[0]}`,
                    );
                }
            }
            for (const e of document.querySelectorAll("button, input, select, .codicon, .action-label")) {
                if (hit(e.getBoundingClientRect()) && shown(e)) {
                    hits.add(
                        `<${e.tagName.toLowerCase()} ${e.getAttribute("title") ?? e.getAttribute("aria-label") ?? e.className}>`.slice(
                            0,
                            50,
                        ),
                    );
                }
            }
            return [...hits];
        },
        { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height },
    );
}

/** Draws numbered outlines; returns a function that removes them. `scopes` are checked for what the badges cover. */
async function callouts(items, within, scopes = [page]) {
    const boxes = [];
    for (const [n, target, place = "inside"] of items) {
        const box = await boxOf(target);
        if (
            within &&
            (box.x < within.x - 1 ||
                box.y < within.y - 1 ||
                box.x + box.width > within.x + within.width + 1 ||
                box.y + box.height > within.y + within.height + 1)
        ) {
            throw new Error(
                `callout ${n} is outside the picture: ${JSON.stringify(box)} not in ${JSON.stringify(within)}`,
            );
        }
        boxes.push({ n, place, ...box });
    }
    console.log(
        "callouts:",
        boxes
            .map(
                (b) =>
                    `${b.n ?? "-"}@${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`,
            )
            .join("  "),
    );
    for (const b of boxes.filter((box) => box.n !== null)) {
        const hitsAt = async (place) => {
            const hits = [];
            for (const scope of scopes) {
                hits.push(...(await covered(scope, badgeRect(b, place))));
            }
            return hits;
        };
        const hits = await hitsAt(b.place);
        const at = typeof b.place === "object" ? `${Math.round(b.place.x)},${Math.round(b.place.y)}` : b.place;
        console.log(`  badge ${b.n} (${at}) covers: ${hits.join(", ") || "nothing"}`);
        if (hits.length > 0) {
            for (const place of ["left", "right", "top", "bottom", "inside", "insideBottom"]) {
                const r = badgeRect(b, place);
                const inPicture =
                    !within ||
                    (r.x >= within.x &&
                        r.y >= within.y &&
                        r.x + r.width <= within.x + within.width &&
                        r.y + r.height <= within.y + within.height);
                console.log(
                    `      ${place}: ${inPicture ? (await hitsAt(place)).join(", ") || "nothing" : "outside the picture"}`,
                );
            }
            throw new Error(`badge ${b.n} covers ${hits[0]}; the lines above list what each other place covers`);
        }
    }
    await page.evaluate(
        (list) => {
            const layer = document.createElement("div");
            layer.id = "shot-callouts";
            Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "1000000", pointerEvents: "none" });
            for (const b of list) {
                const pad = 2;
                const frame = document.createElement("div");
                Object.assign(frame.style, {
                    position: "fixed",
                    left: `${b.x - pad}px`,
                    top: `${b.y - pad}px`,
                    width: `${b.width + 2 * pad}px`,
                    height: `${b.height + 2 * pad}px`,
                    border: "2px solid #ffb000",
                    borderRadius: "4px",
                    boxSizing: "border-box",
                });
                const size = 20;
                const pos = [b.badge.x, b.badge.y];
                layer.append(frame);
                if (b.n === null) {
                    continue;
                }
                const badge = document.createElement("div");
                badge.textContent = String(b.n);
                Object.assign(badge.style, {
                    position: "fixed",
                    left: `${pos[0]}px`,
                    top: `${pos[1]}px`,
                    width: `${size}px`,
                    height: `${size}px`,
                    borderRadius: "50%",
                    background: "#ffb000",
                    color: "#1b1b1b",
                    font: "bold 13px/20px sans-serif",
                    textAlign: "center",
                    boxShadow: "0 0 0 1px #1b1b1b",
                });
                layer.append(badge);
            }
            document.body.append(layer);
        },
        boxes.map((b) => ({ ...b, badge: badgeRect(b) })),
    );
    await sleep(150);
    return () => page.evaluate(() => document.getElementById("shot-callouts")?.remove());
}

/** The webview frame that has an element matching `selector`. */
async function webview(selector) {
    for (let i = 0; i < 60; i++) {
        for (const frame of page.frames()) {
            if (
                (await frame
                    .locator(selector)
                    .count()
                    .catch(() => 0)) > 0
            ) {
                return frame;
            }
        }
        await sleep(250);
    }
    throw new Error(
        `no webview with ${selector}; frames: ${page
            .frames()
            .map((f) => f.url().slice(0, 60))
            .join(" ; ")}`,
    );
}

/**
 * How many pixels of a picture differ clearly from a reference picture:
 * undefined without a reference, -1 if the sizes differ. The same view
 * can differ in a pixel or two between runs, and that changes the colours
 * that compressing picks, so small differences in colour are not counted.
 */
async function changedPixels(file, reference) {
    if (!fs.existsSync(reference)) {
        return undefined;
    }
    return page.evaluate(
        async (files) => {
            const [a, b] = await Promise.all(
                files.map(async (base64) => {
                    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
                    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
                    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
                    context.drawImage(bitmap, 0, 0);
                    return context.getImageData(0, 0, bitmap.width, bitmap.height);
                }),
            );
            if (a.width !== b.width || a.height !== b.height) {
                return -1;
            }
            let count = 0;
            for (let i = 0; i < a.data.length; i += 4) {
                if ([0, 1, 2].some((c) => Math.abs(a.data[i + c] - b.data[i + c]) > 40)) {
                    count++;
                }
            }
            return count;
        },
        [file, reference].map((f) => fs.readFileSync(f).toString("base64")),
    );
}

/** Writes a smaller copy of a picture for the documentation. pngquant also removes metadata. */
function compress(raw, file) {
    try {
        execFileSync("pngquant", ["--quality=80-98", "--speed", "1", "--strip", "--force", "--output", file, raw]);
    } catch {
        // pngquant writes nothing if it cannot keep the quality. A capture has no metadata either.
        fs.copyFileSync(raw, file);
    }
}

/** The fonts Chromium really draws the first match of each selector with. */
async function fonts(selectors) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    for (const selector of selectors) {
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        if (!nodeId) {
            console.log(`font ${selector}: no such element`);
            continue;
        }
        const { fonts: used } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        console.log(
            `font ${selector}: ${used.map((f) => `${f.familyName} (${f.glyphCount} glyphs)`).join(", ") || "no text"}`,
        );
    }
    await cdp.detach();
}

const state = () =>
    page.evaluate(() => {
        const box = (sel) => {
            const e = document.querySelector(sel);
            const r = e?.getBoundingClientRect();
            return r && r.width > 0
                ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
                : "hidden";
        };
        const texts = (sel) =>
            [...document.querySelectorAll(sel)]
                .filter((e) => e.getBoundingClientRect().width > 0)
                .map((e) => e.getAttribute("aria-label") ?? e.textContent.trim());
        return {
            window: `${innerWidth}x${innerHeight}`,
            sidebar: box(".part.sidebar"),
            auxiliarybar: box(".part.auxiliarybar"),
            panel: box(".part.panel"),
            editor: box(".part.editor"),
            toasts: texts(".notifications-toasts .notification-list-item-message").join(" | ") || "(none)",
            tabs: texts(".part.editor .tab").join(" | ") || "(none)",
            debugToolbar: `${box(".debug-toolbar")}: ${texts(".debug-toolbar .action-label").filter(Boolean).join(" | ")}`,
            editorTitleButtons: texts(".part.editor .editor-actions .action-label").join(" | ") || "(none)",
            currentLine: document.querySelector(".part.editor .view-overlays .debug-top-stack-frame-line")
                ? "highlighted"
                : "not highlighted",
            editorText: [...document.querySelectorAll(".part.editor .view-line")]
                .slice(0, 3)
                .map((l) => l.textContent.replace(/\u00a0/g, " "))
                .join(" / "),
            terminal:
                [...document.querySelectorAll(".part.panel .xterm-rows > div")]
                    .map((d) => d.textContent.trimEnd())
                    .filter(Boolean)
                    .join(" / ") || "(empty)",
            panelTab: texts(".part.panel .composite.title .action-item.checked a").join(" | "),
            statusBar: texts(".part.statusbar .statusbar-item").join(" | "),
        };
    });

async function describe(title) {
    console.log(`\n=== ${title}`);
    for (const [k, v] of Object.entries(await state())) {
        console.log(`${k}: ${v}`);
    }
}

try {
    await sleep(2500);
    await command("Notifications: Clear All Notifications");
    await command("View: Show Run and Debug");
    await page.keyboard.press("F5");
    await page.locator(".debug-toolbar").waitFor({ state: "visible", timeout: 30000 });
    await sleep(5000);
    // Continue: the agent stops again in the example thread, which takes the focus.
    await page.keyboard.press("F5");
    await sleep(3000);
    await command("Notifications: Clear All Notifications");
    // The floating debug toolbar covers the editor tabs, move it to the right of them.
    await page.evaluate((dx) => {
        const grip = document.querySelector(".debug-toolbar .drag-area");
        const r = grip.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const event = (type, clientX) =>
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX, clientY: y, button: 0 });
        grip.dispatchEvent(event("mousedown", x));
        document.body.dispatchEvent(event("mousemove", x + dx / 2));
        document.body.dispatchEvent(event("mousemove", x + dx));
        document.body.dispatchEvent(event("mouseup", x + dx));
    }, 320);
    await park();
    await sleep(300);

    // ---- overview.png: a debug session ------------------------------------
    await setPanes(["Variables", "Call Stack", "Breakpoints"]);
    // VS Code opens this group or not, depending on timing. The picture has it open.
    const other = pane("Call Stack").locator(".monaco-list-row:has(.session)", { hasText: "Other.core[0][0]" });
    if ((await other.getAttribute("aria-expanded")) === "false") {
        await other.locator(".monaco-tl-twistie").click();
        await sleep(700);
    }
    // The same selection and no keyboard focus in every run: no outline, no blinking cursor.
    await pane("Call Stack").locator(".monaco-list-row:has(.stack-frame)", { hasText: "checksum" }).click();
    await sleep(700);
    await page.evaluate(() => document.activeElement.blur());
    await park();
    await scrollbarsFaded();
    await describe("overview");
    for (const name of ["Variables", "Call Stack"]) {
        await describePane(name);
    }
    await fonts([
        ".part.sidebar .debug-call-stack .monaco-list-row .name",
        ".part.editor .view-line",
        ".part.sidebar .pane-header h3",
        ".part.panel .xterm-rows > div",
        ".debug-toolbar .codicon",
    ]);
    const full = { x: 0, y: 30, width: WIDTH, height: HEIGHT - 30 };
    const viewHeaders = [];
    for (const name of ["Path Maps", "Symbol Files", "Consoles", "Snapshots"]) {
        viewHeaders.push(await header(name).boundingBox());
    }
    let remove = await callouts(
        [
            [1, pane("Call Stack")],
            [2, page.locator('.debug-toolbar .action-label[aria-label="Open Target Memory"]'), "bottom"],
            [3, union(viewHeaders)],
            [4, page.locator(".part.panel"), "insideBottom"],
        ],
        full,
    );
    await shot("overview", full);
    await remove();

    // ---- call-stack.png: the Call Stack view with all groups open -----------
    await setPanes(["Call Stack"]);
    for (let i = 0; i < 12; i++) {
        const row = pane("Call Stack").locator('.monaco-list-row[aria-expanded="false"]:has(.session)').first();
        if ((await row.count()) === 0) {
            break;
        }
        await row.locator(".monaco-tl-twistie").click();
        await sleep(700);
    }
    const stackBox = await pane("Call Stack").boundingBox();
    await page.mouse.move(stackBox.x + 150, stackBox.y + 200);
    await page.mouse.wheel(0, -3000);
    await sleep(300);
    // Select the current frame again, the last expanded group has the focus.
    await pane("Call Stack").locator(".monaco-list-row:has(.stack-frame)", { hasText: "checksum" }).click();
    await park();
    await scrollbarsFaded();
    await describePane("Call Stack");
    console.log("selected row:", await pane("Call Stack").locator(".monaco-list-row.selected").innerText());
    await shot("call-stack", await paneBox("Call Stack"));

    // ---- context-picker.png and breakpoints.png -----------------------------
    await setPanes(["Call Stack", "Breakpoints"]);
    const quick = page.locator(".quick-input-widget");
    const quickState = async () =>
        `${(await quick.locator(".quick-input-title").innerText()).trim()} :: ${(
            await quick
                .locator(".monaco-list-row")
                .evaluateAll((rows) =>
                    rows
                        .filter((r) => r.getBoundingClientRect().height > 0)
                        .map(
                            (r) =>
                                `${r.classList.contains("focused") ? "*" : ""}${r.innerText.trim().replace(/\s+/g, " ")}`,
                        ),
                )
        ).join(" | ")} :: placeholder "${await quick.locator("input").first().getAttribute("placeholder")}"`;
    await command("Simics Target Debug: Add Function Breakpoint in Context...");
    await sleep(800);
    console.log("picker:", await quickState());
    const q = await quick.boundingBox();
    await shot("context-picker", q);
    await page.keyboard.press("Enter");
    await sleep(700);
    console.log("input:", (await quick.locator(".quick-input-title").textContent())?.trim());
    await page.keyboard.type("handle_request");
    await page.keyboard.press("Enter");
    await sleep(800);
    await command("Simics Target Debug: Add Function Breakpoint in Context...");
    await sleep(800);
    await page.keyboard.type("Context Query");
    await sleep(400);
    await page.keyboard.press("Enter");
    await sleep(700);
    await page.keyboard.type("**/HasState=true");
    await page.keyboard.press("Enter");
    await sleep(700);
    await page.keyboard.type("start_kernel");
    await page.keyboard.press("Enter");
    await sleep(1500);
    // Hovering does not show in screenshots. A focused view shows its title buttons too.
    await pane("Breakpoints").locator(".monaco-list").first().focus();
    await park();
    await scrollbarsFaded();
    await describePane("Breakpoints");
    const bpClip = await paneBox("Breakpoints");
    remove = await callouts(
        [
            [
                null,
                union([
                    await header("Breakpoints")
                        .locator('.action-label[aria-label^="Add Function Breakpoint in Context"]')
                        .boundingBox(),
                    await header("Breakpoints")
                        .locator('.action-label[aria-label^="Edit Function Breakpoint Contexts"]')
                        .boundingBox(),
                ]),
            ],
        ],
        bpClip,
    );
    await shot("breakpoints", bpClip);
    await remove();

    // ---- path-maps.png, symbol-files.png, consoles.png, snapshots.png -------
    await setPanes(["Path Maps", "Symbol Files", "Consoles", "Snapshots"]);
    await sleep(800);
    await park();
    for (const [name, file] of [
        ["Path Maps", "path-maps"],
        ["Symbol Files", "symbol-files"],
        ["Consoles", "consoles"],
        ["Snapshots", "snapshots"],
    ]) {
        // The focused row shows its buttons, like a row under the pointer does.
        await pane(name).locator(".monaco-list").first().focus();
        await page.keyboard.press("Home");
        await scrollbarsFaded();
        await describePane(name);
        console.log(
            `focused row: ${(await pane(name).locator(".monaco-list-row.focused").innerText()).replace(/\s+/g, " ")}`,
        );
        await shot(file, await paneBox(name));
    }

    // ---- target-memory.png --------------------------------------------------
    await page.locator('.debug-toolbar .action-label[aria-label="Open Target Memory"]').click();
    const tm = await webview(".toolbar .target-select");
    await tm.locator(".address-input").fill("data");
    await tm.locator(".address-input").press("Enter");
    await sleep(2000);
    if ((await tm.locator(".inspector").count()) === 0) {
        await tm.locator('button[title="Data inspector"]').click();
        await sleep(500);
    }
    await park();
    await describe("target memory");
    console.log(
        "memory rows:",
        (
            await tm
                .locator(".row")
                .evaluateAll((rows) => rows.slice(0, 6).map((r) => r.innerText.replace(/\s+/g, " ")))
        ).join(" / "),
    );
    console.log(
        "memory target:",
        await tm
            .locator(".target-select")
            .evaluate((s) => [...s.options].map((o) => `${o.selected ? "*" : ""}${o.textContent}`).join(" | ")),
    );
    console.log("memory inspector:", (await tm.locator(".inspector").innerText()).replace(/\s+/g, " ").slice(0, 260));
    console.log("memory status:", (await tm.locator(".status-bar").innerText()).replace(/\s+/g, " "));
    console.log(
        "memory toolbar:",
        (
            await tm.locator(".toolbar > *").evaluateAll((items) =>
                items.map((e) => {
                    const r = e.getBoundingClientRect();
                    return `${e.getAttribute("title") ?? e.className}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
                }),
            )
        ).join("  "),
    );
    let editorBox = await page.locator(".part.editor").boundingBox();
    const perRow = await tm.locator('select[title="Bytes per row"]').boundingBox();
    const readAgain = await tm.locator('button[title="Read memory again"]').boundingBox();
    const toolbarBox = await tm.locator(".toolbar").boundingBox();
    remove = await callouts(
        [
            // The badge goes in the gap between the left and the right group of controls.
            [
                1,
                toolbarBox,
                {
                    x: (perRow.x + perRow.width + readAgain.x) / 2 - BADGE / 2,
                    y: toolbarBox.y + toolbarBox.height / 2 - BADGE / 2,
                },
            ],
            [2, tm.locator(".inspector"), "insideBottom"],
        ],
        editorBox,
        [page, tm],
    );
    await shot("target-memory", editorBox);
    await remove();

    // ---- launch-configurations.png ------------------------------------------
    await command("View: Toggle Panel Visibility");
    await command("Simics Target Debug: Edit Launch Configurations");
    const form = await webview("nav.list");
    await sleep(1500);
    await form.locator(".context-scope").first().scrollIntoViewIfNeeded();
    await park();
    await sleep(500);
    await describe("launch configurations");
    console.log(
        "form list:",
        (
            await form
                .locator("nav.list li")
                .evaluateAll((items) =>
                    items.map((i) => `${i.classList.contains("selected") ? "*" : ""}${i.textContent}`),
                )
        ).join(" | "),
    );
    console.log("form settings:", (await form.locator(".details .setting-title .label").allTextContents()).join(" | "));
    console.log(
        "form start button:",
        await form
            .locator(".details-header button.start")
            .evaluate((b) => `${b.getAttribute("aria-label")} disabled=${b.disabled}`),
    );
    console.log(
        "form contexts:",
        (
            await form
                .locator(".context-scope select")
                .evaluateAll((s) => s.map((e) => e.selectedOptions[0].textContent))
        ).join(" | "),
    );
    editorBox = await page.locator(".part.editor").boundingBox();
    // The Contexts column of the first table; the badge goes in the free part of its header cell.
    const table = form.locator(".object-list").first();
    const th = await table.locator("th", { hasText: "Contexts" }).boundingBox();
    const column = [th];
    for (const cell of await table.locator(".context-scope").all()) {
        column.push(await cell.boundingBox());
    }
    remove = await callouts(
        [
            [1, form.locator("nav.list"), "insideBottom"],
            [2, form.locator(".details-header .actions"), "left"],
            [3, union(column), { x: th.x + th.width - BADGE - 3, y: th.y + (th.height - BADGE) / 2 }],
            [
                4,
                union([
                    await page
                        .locator('.part.editor .editor-actions .action-label[aria-label^="Open launch.json as Text"]')
                        .boundingBox(),
                    await page
                        .locator('.part.editor .editor-actions .action-label[aria-label^="Open Settings"]')
                        .boundingBox(),
                ]),
                "left",
            ],
        ],
        editorBox,
        [page, form],
    );
    await shot("launch-configurations", editorBox);
    await remove();

    // ---- Which pictures differ from the committed ones ------------------------
    console.log("\ncompared with the committed pictures:");
    const changes = [];
    for (const name of shots) {
        const file = path.join(out, `${name}.png`);
        compress(path.join(out, "raw", `${name}.png`), file);
        const pixels = await changedPixels(file, path.join(before, `${name}.png`));
        const state = pixels === undefined ? "new" : pixels < 0 || pixels > NOISE ? "changed" : "unchanged";
        const note = pixels === undefined ? "" : pixels < 0 ? "other size" : `${pixels} pixels differ`;
        console.log(`  ${name}.png: ${state}${note && ` (${note})`}`);
        changes.push(`${name}.png\t${state}\t${note}\n`);
    }
    if (firstCapture) {
        const missing = new Set(fs.readdirSync(firstCapture).filter((name) => name.endsWith(".png")));
        const differences = [];
        for (const name of shots) {
            const file = `${name}.png`;
            missing.delete(file);
            const pixels = await changedPixels(path.join(out, file), path.join(firstCapture, file));
            if (pixels === undefined) differences.push(`${file}: missing from first capture`);
            else if (pixels < 0) differences.push(`${file}: different dimensions`);
            else if (pixels > NOISE) differences.push(`${file}: ${pixels} pixels differ`);
        }
        for (const file of missing) differences.push(`${file}: missing from second capture`);
        if (differences.length > 0) throw new Error(`captures are not repeatable:\n  ${differences.join("\n  ")}`);
        console.log(`Repeatability check passed (${shots.length} pictures, at most ${NOISE} different pixels each)`);
    }
    fs.writeFileSync(path.join(out, "changes.txt"), changes.join(""));
} catch (err) {
    console.error("FAILED:", err.message);
    await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => undefined);
    await describe("at failure").catch(() => undefined);
    process.exitCode = 1;
} finally {
    console.log("\nshots:", shots.join(", ") || "none");
    // Commands the stand-in agent does not know. The extension gets "not supported" for them.
    console.log("unknown commands:", [...agent.unknown].join(", ") || "none");
    console.log("agent errors:", agent.errors.join("\n") || "none");
    if (agent.errors.length > 0) {
        process.exitCode = 1;
    }
    await app.close().catch(() => undefined);
    await agent.close();
}
