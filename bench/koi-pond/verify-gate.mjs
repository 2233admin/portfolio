#!/usr/bin/env node
// Drives out/gate-preview.html in headless Chromium and checks the mood and art behaviour.
//   node bench/koi-pond/build-gate-preview.mjs && node bench/koi-pond/verify-gate.mjs
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
                if (d[((y - y0) * (x1 - x0) + (x - x0)) * 4 + 3] > 40) n++;
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

// 5: art screenshots at dpr 2
const combos = [
    ["default", { cell: "8", style: "tile", halo: "开", edge: "关", wake: "1" }],
    ["cell6-ink", { cell: "6", style: "ink", halo: "开", edge: "关", wake: "1" }],
    ["cell6-ink-edge-nohalo", { cell: "6", style: "ink", halo: "关", edge: "开", wake: "1" }],
    ["tile-nohalo-wake2.2", { cell: "8", style: "tile", halo: "关", edge: "关", wake: "2.2" }],
    ["cell6-tile-edge-nohalo", { cell: "6", style: "tile", halo: "关", edge: "开", wake: "1.6" }],
];
report.screenshots = {};
{
    const { ctx, page } = await open({ deviceScaleFactor: 2 });
    for (const [name, o] of combos) {
        await click(page, "格子", o.cell);
        await click(page, "风格", o.style);
        await click(page, "halo", o.halo);
        await click(page, "edge", o.edge);
        await click(page, "尾流", o.wake);
        await click(page, "状态", "无服务");
        await sleep(2500);
        const file = join(shots, `art-${name}.png`);
        let buf = await shot(page);
        let crop = null;
        if (buf.length > 400 * 1024) {
            // Pick the 1000x700 window with the most drawn pixels, so the crop has fish in it.
            crop = await page.evaluate(() => {
                const c = document.querySelector("canvas");
                const s = c.width / 1440;
                const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
                const step = 20,
                    W = 1000,
                    H = 700;
                let best = { n: -1, x: 0, y: 0 };
                for (let y = 0; y <= 900 - H; y += step)
                    for (let x = 0; x <= 1440 - W; x += step) {
                        let n = 0;
                        for (let yy = y; yy < y + H; yy += 4)
                            for (let xx = x; xx < x + W; xx += 4)
                                if (d[(Math.floor(yy * s) * c.width + Math.floor(xx * s)) * 4 + 3] > 40) n++;
                        if (n > best.n) best = { n, x, y };
                    }
                return { x: best.x, y: best.y, width: W, height: H };
            });
            buf = await shot(page, crop);
        }
        writeFileSync(file, buf);
        report.screenshots[name] = { bytes: statSync(file).size, crop };
    }
    await ctx.close();
}
report.errors = errors;
console.log(JSON.stringify(report, null, 1));
await browser.close();
