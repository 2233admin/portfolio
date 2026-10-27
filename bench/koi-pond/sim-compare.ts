/* Steps an older copy of world.ts and the current one side by side from the same seeds and compares every sampled value. */
// out/world.old.ts is written by sim-compare.mjs just before bundling, so it is missing when the project is type-checked.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { World as Old } from "./out/world.old";
import { World as New } from "../../src/app/components/koi-pond/world";

function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let samples = 0;
let diffs = 0;
function compare(a: unknown, b: unknown, path: string) {
    if (typeof a === "number") {
        samples++;
        if (a !== b) {
            diffs++;
            if (diffs <= 5) console.log("DIFF", path, a, b);
        }
    } else if (a instanceof Float32Array) {
        a.forEach((x, i) => compare(x, (b as Float32Array)[i], `${path}[${i}]`));
    } else if (Array.isArray(a)) {
        if (a.length !== (b as unknown[]).length) {
            diffs++;
            console.log("LENGTH", path);
            return;
        }
        a.forEach((x, i) => compare(x, (b as unknown[])[i], `${path}[${i}]`));
    } else if (a && typeof a === "object") {
        for (const [key, value] of Object.entries(a)) {
            // A pellet is the same object in both worlds only by position, so compare the target by presence.
            if (key === "food") {
                samples++;
                if ((value === null) !== ((b as Record<string, unknown>).food === null)) diffs++;
            } else compare(value, (b as Record<string, unknown>)[key], `${path}.${key}`);
        }
    }
}

const STEPS = 3600;
for (const seed of [1, 2, 3]) {
    const rngOld = mulberry32(seed);
    const rngNew = mulberry32(seed);
    const worlds = [
        { w: new Old(), rng: rngOld },
        { w: new New({ goldenChance: 0 }), rng: rngNew },
    ];
    for (const { w, rng } of worlds) {
        Math.random = rng;
        w.resize(1440, 900);
        w.avoid = [{ left: 400, top: 200, right: 1000, bottom: 600 }];
        w.pointer = { x: 300, y: 700, speed: 300, active: true };
    }
    for (let i = 0; i < STEPS; i++) {
        for (const { w, rng } of worlds) {
            Math.random = rng;
            if (i === 100) w.feed(300, 500);
            if (i === 400) w.pulse(700, 400, 0.8);
            if (i === 401) w.gather(700, 400, 4);
            if (i === 900) {
                w.scatter(700, 400);
                w.setUnease(1);
            }
            if (i === 1500) w.setUnease(0);
            if (i === 1700) w.feed(1100, 300);
            if (i === 2400) w.pointer.speed = 3000;
            w.step(1 / 60);
        }
        if (i % 10 === 0) {
            const [a, b] = worlds.map((x) => x.w);
            for (const key of ["koi", "pellets", "ripples", "bites", "time"] as const) compare(a[key], b[key], key);
        }
    }
}
console.log(`${samples} samples compared, ${diffs} differ`);
process.exitCode = diffs ? 1 : 0;
