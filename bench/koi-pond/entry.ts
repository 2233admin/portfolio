/* Browser side of the koi-pond benchmark. Bundled by run.mjs and driven through window.koiBench. */
import { KoiRenderer } from "../../src/app/components/koi-pond/renderer";
import { KoiRenderer as BaselineRenderer } from "./baseline/renderer.baseline";
import { World, type Box } from "../../src/app/components/koi-pond/world";

type AnyRenderer = KoiRenderer | BaselineRenderer;
export type Variant = "baseline" | "text" | "atlas" | "explicit";
export type Config = { width: number; height: number; dpr: number; frames: number; warmup: number; light?: boolean };

const STEP = 1 / 60;

// Seeded PRNG, installed only inside the benchmark so product code stays untouched.
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

function makeRenderer(variant: Variant, canvas: HTMLCanvasElement, light: boolean): AnyRenderer {
    // "explicit" is the text renderer with every art option spelled out at its default value.
    const r =
        variant === "baseline"
            ? new BaselineRenderer(canvas)
            : new KoiRenderer(canvas, { glyphs: variant === "explicit" ? "text" : variant });
    if (variant === "explicit" && r instanceof KoiRenderer) {
        r.setArt({ style: "tile", halo: true, edge: false, wake: 1 });
    }
    r.setTheme(light);
    return r;
}

class Scene {
    world: World;
    boxes: Box[];
    frame = 0;
    // One generator per scene, swapped in around every call, so two scenes stepped in turn stay in lockstep.
    private rng = mulberry32(20240607);
    constructor(
        public width: number,
        public height: number
    ) {
        Math.random = this.rng;
        this.world = new World({ goldenChance: 0 });
        this.world.resize(width, height);
        // A content card in the middle, so the dimming path is exercised too.
        this.boxes = [
            { left: width * 0.3, top: height * 0.3, right: width * 0.7, bottom: height * 0.7 },
            { left: width * 0.05, top: height * 0.05, right: width * 0.25, bottom: height * 0.12 },
        ];
        this.world.avoid = this.boxes;
        this.world.pointer = { x: width * 0.2, y: height * 0.8, speed: 300, active: true };
        // Five simulated seconds so the school has spread out; two throws of food along the way.
        for (let i = 0; i < 300; i++) {
            if (i === 60) this.world.feed(width * 0.25, height * 0.6);
            if (i === 180) this.world.feed(width * 0.78, height * 0.4);
            this.world.step(STEP);
        }
    }
    advance() {
        Math.random = this.rng;
        // Keeps pellets, ripples, bites and wakes alive for the whole run.
        if (this.frame === 100) this.world.feed(this.width * 0.5, this.height * 0.85);
        if (this.frame === 200) this.world.feed(this.width * 0.15, this.height * 0.3);
        this.world.step(STEP);
        this.frame++;
    }
}

function setup(variant: Variant, cfg: Config) {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const renderer = makeRenderer(variant, canvas, !!cfg.light);
    renderer.resize(cfg.width, cfg.height, cfg.dpr);
    const scene = new Scene(cfg.width, cfg.height);
    renderer.setDimBoxes(scene.boxes);
    return { canvas, renderer, scene };
}

function stats(xs: number[]) {
    const s = [...xs].sort((a, b) => a - b);
    const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return {
        median: at(0.5),
        p95: at(0.95),
        mean: xs.reduce((a, b) => a + b, 0) / xs.length,
        min: s[0],
        max: s[s.length - 1],
    };
}

async function run(variant: Variant, cfg: Config) {
    const { canvas, renderer, scene } = setup(variant, cfg);
    const ctx = canvas.getContext("2d")!;
    const total: number[] = [];
    const cpu: number[] = [];
    for (let f = 0; f < cfg.warmup + cfg.frames; f++) {
        scene.advance();
        const t0 = performance.now();
        renderer.render(scene.world, STEP);
        const t1 = performance.now();
        // Canvas commands are deferred; a 1x1 readback forces the raster work to finish inside the timed region.
        ctx.getImageData(0, 0, 1, 1);
        const t2 = performance.now();
        if (f >= cfg.warmup) {
            cpu.push(t1 - t0);
            total.push(t2 - t0);
        }
        // Let the browser breathe now and then so it doesn't throttle one long synchronous run.
        if (f % 50 === 49) await new Promise((r) => setTimeout(r, 0));
    }
    canvas.remove();
    return { variant, ...cfg, total: stats(total), cpu: stats(cpu) };
}

/** Composite a canvas over the page background, so semi-transparent pixels are compared as the viewer sees them. */
function flatten(c: HTMLCanvasElement, light: boolean) {
    const t = document.createElement("canvas");
    t.width = c.width;
    t.height = c.height;
    const x = t.getContext("2d")!;
    x.fillStyle = light ? "rgb(245,244,241)" : "rgb(26,25,33)";
    x.fillRect(0, 0, t.width, t.height);
    x.drawImage(c, 0, 0);
    return t;
}

function diffCanvases(a: HTMLCanvasElement, b: HTMLCanvasElement, light: boolean) {
    if (a.width !== b.width || a.height !== b.height) throw new Error("size mismatch");
    const ta = flatten(a, light);
    const tb = flatten(b, light);
    const da = ta.getContext("2d")!.getImageData(0, 0, ta.width, ta.height).data;
    const db = tb.getContext("2d")!.getImageData(0, 0, tb.width, tb.height).data;
    let sum = 0;
    let max = 0;
    let over8 = 0;
    let changed = 0;
    for (let i = 0; i < da.length; i += 4) {
        let m = 0;
        for (let c = 0; c < 3; c++) {
            const d = Math.abs(da[i + c] - db[i + c]);
            sum += d;
            if (d > m) m = d;
        }
        if (m > max) max = m;
        if (m > 8) over8++;
        if (m > 0) changed++;
    }
    const px = ta.width * ta.height;
    return { mean: sum / (px * 3), max, pctOver8: (100 * over8) / px, changed: (100 * changed) / px, ta, tb };
}

/** Render the same frames with both renderers from identically-seeded worlds and diff them. */
function compare(variant: Variant, cfg: Config, frames: number[]) {
    const a = setup("baseline", cfg);
    const b = setup(variant, cfg);
    const out: {
        frame: number;
        mean: number;
        max: number;
        pctOver8: number;
        changed: number;
        png: [string, string];
    }[] = [];
    for (let f = 0; f <= Math.max(...frames); f++) {
        a.scene.advance();
        b.scene.advance();
        a.renderer.render(a.scene.world, STEP);
        b.renderer.render(b.scene.world, STEP);
        if (!frames.includes(f)) continue;
        const { ta, tb, ...m } = diffCanvases(a.canvas, b.canvas, !!cfg.light);
        out.push({ frame: f, ...m, png: [ta.toDataURL("image/png"), tb.toDataURL("image/png")] });
    }
    a.canvas.remove();
    b.canvas.remove();
    return out;
}

/** Exercise resize, dpr and theme changes: after each, the new renderer is diffed against the baseline. */
function lifecycle(variant: Variant, cfg: Config) {
    const a = setup("baseline", cfg);
    const b = setup(variant, cfg);
    let light = !!cfg.light;
    const rows: { step: string; mean: number; max: number; pctOver8: number }[] = [];
    const diff = (label: string) => {
        a.renderer.render(a.scene.world, STEP);
        b.renderer.render(b.scene.world, STEP);
        const { ta, tb, ...m } = diffCanvases(a.canvas, b.canvas, light);
        void ta;
        void tb;
        rows.push({ step: label, mean: m.mean, max: m.max, pctOver8: m.pctOver8 });
    };
    const both = (fn: (r: AnyRenderer) => void) => {
        fn(a.renderer);
        fn(b.renderer);
        a.scene.advance();
        b.scene.advance();
    };
    diff("initial (dark, 1920x1080 dpr1)");
    light = true;
    both((r) => r.setTheme(true));
    diff("setTheme(light)");
    light = false;
    both((r) => r.setTheme(false));
    diff("setTheme(dark)");
    both((r) => r.resize(1280, 720, 2));
    both((r) => r.setDimBoxes(a.scene.boxes));
    diff("resize 1280x720 dpr2");
    both((r) => r.resize(1280, 720, 1));
    diff("dpr 2 -> 1");
    both((r) => r.resize(900, 1200, 1));
    diff("resize 900x1200 dpr1");
    both((r) => r.resize(1920, 1080, 2));
    diff("resize 1920x1080 dpr2");
    a.canvas.remove();
    b.canvas.remove();
    return rows;
}

declare global {
    interface Window {
        koiBench: { run: typeof run; compare: typeof compare; lifecycle: typeof lifecycle };
    }
}
window.koiBench = { run, compare, lifecycle };
