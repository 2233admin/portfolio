#!/usr/bin/env node
// Frozen-clock screenshots of the default look: polish-swim, polish-feed (1.5 s after food lands) and polish-ripple.
//   node bench/koi-pond/build-gate-preview.mjs && node bench/koi-pond/polish-shots.mjs [seed] [feedX feedY] [goldenMs]
import { chromium } from "playwright";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "screenshots");
mkdirSync(shots, { recursive: true });
const seed = Number(process.argv[2] ?? 7);
const feedAt = { x: Number(process.argv[3] ?? 300), y: Number(process.argv[4] ?? 260) };
const seedScript = `(() => { let a = ${seed} >>> 0; Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })()`;
const browser = await chromium.launch();
const errors = [];

async function frozen() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(seedScript);
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
    await page.goto("file://" + join(here, "out/gate-preview.html"));
    await page.clock.pauseAt(1000);
    await page.locator('[aria-label="自动跃"] button', { hasText: /^关$/ }).click();
    return { ctx, page };
}
async function save(page, name, clip) {
    const file = join(shots, `${name}.png`);
    writeFileSync(file, await page.screenshot(clip ? { clip } : {}));
    return statSync(file).size;
}
const report = { seed, errors };
{
    const { ctx, page } = await frozen();
    await page.clock.runFor(4000);
    report.swim = await save(page, "polish-swim");
    await ctx.close();
}
{
    const { ctx, page } = await frozen();
    await page.clock.runFor(3000);
    await page.mouse.click(feedAt.x, feedAt.y);
    await page.clock.runFor(1500);
    report.feed = await save(page, "polish-feed");
    await ctx.close();
}
{
    const { ctx, page } = await frozen();
    await page.clock.runFor(3000);
    await page.mouse.click(feedAt.x, feedAt.y);
    await page.clock.runFor(1200);
    report.ripple = await save(page, "polish-ripple");
    await ctx.close();
}
{
    const { ctx, page } = await frozen();
    await page.clock.runFor(3000);
    await page.getByRole("button", { name: "放一条金鲤" }).click();
    await page.clock.runFor(Number(process.argv[5] ?? 2000));
    report.golden = await save(page, "golden");
    await ctx.close();
}
console.log(JSON.stringify(report));
await browser.close();
