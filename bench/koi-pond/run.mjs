#!/usr/bin/env node
// Koi-pond renderer benchmark: bundles entry.ts, runs it in headless Chromium, writes results.
//   node bench/koi-pond/run.mjs [--rounds 3] [--frames 300] [--only baseline|atlas] [--no-compare]
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? def : process.argv[i + 1];
};
const rounds = Number(arg("rounds", 3));
const frames = Number(arg("frames", 300));
const only = arg("only", "");
const gpu = process.argv.includes("--gpu");
const headed = process.argv.includes("--headed");
const skipCompare = process.argv.includes("--no-compare");
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });

await build({
    entryPoints: [join(here, "entry.ts")],
    bundle: true,
    format: "iife",
    target: "es2022",
    outfile: join(outDir, "bundle.js"),
    logLevel: "warning",
});

// --gpu asks Chromium for hardware canvas (only meaningful on a machine with a GPU); --headed shows the window.
const browser = await chromium.launch({
    headless: !headed,
    args: gpu ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-accelerated-2d-canvas"] : [],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.error("page error:", e.message));
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
await page.setContent("<!doctype html><body style='margin:0'></body>");
await page.addScriptTag({ path: join(outDir, "bundle.js") });
const version = browser.version();

const variants = only ? only.split(",") : ["baseline", "text", "atlas"];
const dprs = [1, 2];
const results = [];
for (let round = 0; round < rounds; round++) {
    for (const dpr of dprs) {
        for (const variant of variants) {
            const r = await page.evaluate((cfg) => window.koiBench.run(cfg.variant, cfg), {
                variant,
                width: 1920,
                height: 1080,
                dpr,
                frames,
                warmup: 30,
            });
            results.push({ round, ...r });
            console.log(
                `round ${round} dpr${dpr} ${variant.padEnd(8)} median ${r.total.median.toFixed(2)} ms  p95 ${r.total.p95.toFixed(2)} ms  (cpu-only median ${r.cpu.median.toFixed(2)})`
            );
        }
    }
}

// Summarise: median across rounds of each round's median / p95.
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const table = [];
for (const dpr of dprs) {
    for (const variant of variants) {
        const rs = results.filter((r) => r.dpr === dpr && r.variant === variant);
        table.push({
            variant,
            dpr,
            median: med(rs.map((r) => r.total.median)),
            p95: med(rs.map((r) => r.total.p95)),
            cpuMedian: med(rs.map((r) => r.cpu.median)),
        });
    }
}
console.log("\n| variant | dpr | median ms | p95 ms | JS-side median ms |\n|---|---|---|---|---|");
for (const t of table) {
    console.log(
        `| ${t.variant} | ${t.dpr} | ${t.median.toFixed(2)} | ${t.p95.toFixed(2)} | ${t.cpuMedian.toFixed(2)} |`
    );
}

const report = { browser: `chromium ${version} (headless shell, software raster)`, rounds, frames, table, results };

if (!skipCompare && variants.includes("baseline")) {
    report.compare = {};
    report.lifecycle = {};
    for (const variant of variants.filter((v) => v !== "baseline")) {
        const cmp = (report.compare[variant] = {});
        for (const dpr of dprs) {
            for (const light of [false, true]) {
                const key = `dpr${dpr}-${light ? "light" : "dark"}`;
                const rows = await page.evaluate((cfg) => window.koiBench.compare(cfg.variant, cfg, [60, 250]), {
                    variant,
                    width: 1920,
                    height: 1080,
                    dpr,
                    frames: 0,
                    warmup: 0,
                    light,
                });
                cmp[key] = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "png")));
                for (const row of rows) {
                    for (const [i, name] of ["baseline", variant].entries()) {
                        writeFileSync(
                            join(outDir, `${key}-f${row.frame}-${name}.png`),
                            Buffer.from(row.png[i].split(",")[1], "base64")
                        );
                    }
                }
                console.log(variant, key, JSON.stringify(cmp[key]));
            }
        }
        report.lifecycle[variant] = await page.evaluate(
            (v) => window.koiBench.lifecycle(v, { width: 1920, height: 1080, dpr: 1, frames: 0, warmup: 0 }),
            variant
        );
        console.log(variant, "lifecycle", JSON.stringify(report.lifecycle[variant]));
    }
}
writeFileSync(join(outDir, "results.json"), JSON.stringify(report, null, 1));
await browser.close();
