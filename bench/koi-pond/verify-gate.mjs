#!/usr/bin/env node
// Drives out/gate-preview.html in headless Chromium and checks the moods, the leap and the splash into the workbench.
//   node bench/koi-pond/build-gate-preview.mjs && node bench/koi-pond/verify-gate.mjs
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const url = "file://" + join(here, "out/gate-preview.html");
const shots = join(here, "screenshots");
mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const errors = [];

// Seeds Math.random inside the page so paired runs start from the same pond.
const seedScript = (
    seed
) => `(() => { let a = ${seed} >>> 0; Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })()`;

async function open(opts = {}, seed = null) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
    if (seed !== null) await ctx.addInitScript(seedScript(seed));
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on(
        "console",
        (
            m // The willReadFrequently warning comes from this script's own getImageData probe, not the page.
        ) =>
            (m.type() === "error" || m.type() === "warning") &&
            !m.text().includes("willReadFrequently") &&
            errors.push(`console ${m.type()}: ${m.text()}`)
    );
    await page.goto(url);
    await sleep(500);
    return { ctx, page };
}
const click = (page, group, label) =>
    page.locator(`[aria-label="${group}"] button`, { hasText: new RegExp(`^${label}$`) }).click();
// Count canvas pixels that are drawn (alpha above a floor) within `radius` css px of the panel centre.
const countNear = (page, radius) =>
    page.evaluate((radius) => {
        const c = document.querySelector("canvas");
        const scale = c.width / c.getBoundingClientRect().width;
        const b = document.querySelector("[data-koi-avoid]").getBoundingClientRect();
        const cx = ((b.left + b.right) / 2) * scale;
        const cy = ((b.top + b.bottom) / 2) * scale;
        const r = radius * scale;
        const x0 = Math.max(0, Math.floor(cx - r)),
            y0 = Math.max(0, Math.floor(cy - r));
        const x1 = Math.min(c.width, Math.ceil(cx + r)),
            y1 = Math.min(c.height, Math.ceil(cy + r));
        const d = c.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let n = 0;
        for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
                if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
                {
                    // The pond is opaque (backdrop), so "drawn" means not the page background colour.
                    const o = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
                    if (d[o + 3] > 40 && Math.abs(d[o] - 26) + Math.abs(d[o + 1] - 25) + Math.abs(d[o + 2] - 33) > 14)
                        n++;
                }
            }
        return Math.round(n / (scale * scale)); // css px^2
    }, radius);
const shot = (page, clip) => page.screenshot(clip ? { clip } : {});

const report = {};

// 1 + 2: moods animate, with and without reduced motion
report.moods = {};
for (const reduced of [false, true]) {
    const { ctx, page } = await open(reduced ? { reducedMotion: "reduce" } : {});
    for (const mood of ["检查中", "已连接", "断开", "未登记", "无服务"]) {
        await click(page, "状态", mood);
        await sleep(700);
        const a = await shot(page);
        await sleep(400);
        const b = await shot(page);
        const led = await page.getByTestId("led").evaluate((e) => getComputedStyle(e).backgroundColor);
        report.moods[`${mood}${reduced ? " (reduce)" : ""}`] = { framesDiffer: !a.equals(b), led };
    }
    await ctx.close();
}

// 3 + 4: scatter and gather, several trials each; "control" stays in 无服务 for the same time
async function trial(kind, seed) {
    const { ctx, page } = await open({}, seed);
    await sleep(3000);
    const radius = kind === "disconnected" ? 200 : 300;
    const before = await countNear(page, radius);
    await click(page, "状态", kind === "disconnected" ? "断开" : kind === "connected" ? "已连接" : "无服务");
    await sleep(kind === "disconnected" ? 2000 : 3000);
    const after = await countNear(page, radius);
    await ctx.close();
    return { before, after };
}
report.disconnected = [];
report.connected = [];
report.control300 = [];
const SEEDS = [1, 2, 3, 4, 5, 6];
for (const seed of SEEDS) {
    report.disconnected.push({ seed, ...(await trial("disconnected", seed)) });
    report.connected.push({ seed, ...(await trial("connected", seed)) });
    report.control300.push({ seed, ...(await trial("control", seed)) });
}
const sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0);
report.totals = Object.fromEntries(
    ["disconnected", "connected", "control300"].map((k) => [
        k,
        { before: sum(report[k], "before"), after: sum(report[k], "after") },
    ])
);

// 5: leap numbers from a bare World + renderer: the koi's cells before take-off and at the top of the leap
{
    const out = join(here, "out/leap-metrics.js");
    await build({
        entryPoints: [join(here, "leap-metrics.ts")],
        bundle: true,
        format: "iife",
        target: "es2022",
        outfile: out,
        logLevel: "warning",
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent("<!doctype html><body style='margin:0'></body>");
    await page.addScriptTag({ path: out });
    report.leapCells = [];
    for (const seed of [1, 2, 3, 4, 5, 6])
        report.leapCells.push(await page.evaluate((s) => window.leapMetrics(s), seed));
    await page.close();
}

// 6: leap and splash frames on the page. A fake clock makes the frames land at exact times: runFor(ms) advances
// rAF and timers, so "0.55 s after the leap" really is 0.55 s of pond time.
// Crops keep each PNG under 400 KB; the windows were picked by looking at these seeded runs.
const CROPS = {
    "leap-apex": { x: 0, y: 0, width: 1440, height: 900 },
    "leap-land": { x: 0, y: 0, width: 1440, height: 900 },
    "splash-mid": { x: 0, y: 0, width: 1440, height: 900 },
};
async function save(page, name) {
    const file = join(shots, `${name}.png`);
    writeFileSync(file, await page.screenshot({ clip: CROPS[name] }));
    return statSync(file).size;
}
async function frozen(seed) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(seedScript(seed));
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on(
        "console",
        (m) =>
            (m.type() === "error" || m.type() === "warning") &&
            !m.text().includes("willReadFrequently") &&
            errors.push(`console ${m.type()}: ${m.text()}`)
    );
    await page.clock.install({ time: 0 });
    await page.goto(url);
    // Freeze time: from here only runFor() moves rAF, timers and performance.now().
    await page.clock.pauseAt(1000);
    await page.clock.runFor(3000);
    return { ctx, page };
}
report.frames = {};
{
    const { ctx, page } = await frozen(7);
    await click(page, "自动跃", "关");
    await page.getByRole("button", { name: "跳一条" }).click();
    await page.clock.runFor(550);
    report.frames["leap-apex"] = await save(page, "leap-apex");
    // Landing is at 1.1 s; 1.25 s catches the crown of droplets in flight.
    await page.clock.runFor(700);
    report.frames["leap-land"] = await save(page, "leap-land");
    await ctx.close();
}
{
    const { ctx, page } = await frozen(7);
    await click(page, "自动跃", "关");
    await page.getByRole("button", { name: /进入/ }).click();
    await page.clock.runFor(350);
    report.frames["splash-mid"] = await save(page, "splash-mid");
    await ctx.close();
}

// 7: the splash on real time: how long it takes, that the canvas ends up clear and the loop stops, and the restart
report.splash = [];
for (const seed of [11, 12, 13]) {
    const { ctx, page } = await open({}, seed);
    await sleep(1500);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__splashMs !== undefined, null, { timeout: 5000 });
    const after = await page.evaluate(async () => {
        const c = document.querySelector("canvas");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let drawn = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) drawn++;
        const r1 = window.__renders;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise((r) => setTimeout(r, 300));
        const r2 = window.__renders;
        return {
            ms: Math.round(window.__splashMs),
            drawnPixels: drawn,
            rendersAtResolve: r1,
            rendersLater: r2,
            panelOpacity: getComputedStyle(document.querySelector("[data-testid=panel]")).opacity,
        };
    });
    report.splash.push({
        seed,
        ...after,
        restartShown: await page.getByRole("button", { name: "重新开始" }).isVisible(),
    });
    if (seed === 11) {
        // Restart: the pond comes back and the koi move.
        await page.getByRole("button", { name: "重新开始" }).click();
        await sleep(1500);
        const snap = () =>
            page.evaluate(() => {
                const c = document.querySelector("canvas");
                const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
                let drawn = 0;
                let sum = 0;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] !== 0) drawn++;
                    sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 1000003;
                }
                return { drawn, sum, renders: window.__renders };
            });
        const a = await snap();
        await sleep(400);
        const b = await snap();
        report.restart = { pondDrawn: a.drawn > 0, framesDiffer: a.sum !== b.sum, rendering: b.renders > a.renders };
    }
    await ctx.close();
}

report.errors = errors;
console.log(JSON.stringify(report, null, 1));
await browser.close();
