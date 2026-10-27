/* Browser side of the leap measurements in verify-gate.mjs. Bundled there by esbuild and loaded into a blank page. */
import { KoiRenderer } from "../../src/app/components/koi-pond/renderer";
import { World, type Koi } from "../../src/app/components/koi-pond/world";

const STEP = 1 / 60;

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

type Grid = {
    cellGlyph: Uint16Array;
    cellTileAlpha: Float32Array;
    cellShadowLeap: Uint8Array;
    cols: number;
    cw: number;
    ch: number;
};

/** Centre of mass and count of the grid cells for which `has` is true. */
function blob(g: Grid, has: (i: number) => boolean) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < g.cellGlyph.length; i++) {
        if (!has(i)) continue;
        n++;
        sx += (i % g.cols) * g.cw;
        sy += Math.floor(i / g.cols) * g.ch;
    }
    return { n, x: n ? sx / n : 0, y: n ? sy / n : 0 };
}

/**
 * Leaps one koi in an otherwise empty pond and counts the cells the koi covers (glyph or tile) before take-off and
 * at the top of the leap (0.55 s in), and how far the shadow's centre sits from the body's.
 */
function measure(seed: number) {
    const rng = mulberry32(seed);
    Math.random = rng;
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const renderer = new KoiRenderer(canvas);
    renderer.setArt({ cell: 8 });
    renderer.resize(1440, 900, 1);
    const world = new World({ goldenChance: 0 });
    world.resize(1440, 900);
    for (let i = 0; i < 600; i++) world.step(STEP);
    world.leap();
    const fish = world.koi.find((k) => k.leap) as Koi;
    // Only this koi stays, so every cell counted is its own.
    world.koi = [fish];
    const grid = renderer as unknown as Grid;
    const cells = () => blob(grid, (i) => grid.cellGlyph[i] !== 0 || grid.cellTileAlpha[i] > 0);
    renderer.render(world, STEP);
    const before = cells();
    const length = fish.length;
    for (let i = 0; i < 33; i++) world.step(STEP);
    renderer.render(world, STEP);
    const apex = cells();
    const shadow = blob(grid, (i) => grid.cellShadowLeap[i] > 0);
    canvas.remove();
    return {
        seed,
        length: Math.round(length),
        cellsBefore: before.n,
        cellsApex: apex.n,
        ratio: +(apex.n / before.n).toFixed(2),
        shadowCells: shadow.n,
        shadowOffsetOverLength: +(Math.hypot(shadow.x - apex.x, shadow.y - apex.y) / length).toFixed(2),
    };
}

declare global {
    interface Window {
        leapMetrics: typeof measure;
    }
}
window.leapMetrics = measure;
