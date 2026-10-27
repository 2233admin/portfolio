#!/usr/bin/env node
// Checks that the simulation is unchanged when none of the new features is used: steps the world.ts of an older
// revision and the current one side by side from the same seeds and compares every sampled value.
//   node bench/koi-pond/sim-compare.mjs [rev]      (default rev: 1c45a66, the commit before splash and leap)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const rev = process.argv[2] ?? "1c45a66";
const out = join(here, "out");
mkdirSync(out, { recursive: true });
writeFileSync(
    join(out, "world.old.ts"),
    execFileSync("git", ["show", `${rev}:src/app/components/koi-pond/world.ts`], { cwd: root, encoding: "utf8" })
);
await build({
    entryPoints: [join(here, "sim-compare.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(out, "sim-compare.cjs"),
    logLevel: "warning",
});
execFileSync("node", [join(out, "sim-compare.cjs")], { stdio: "inherit" });
