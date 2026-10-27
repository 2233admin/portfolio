import { CellPainter, type GlyphMode } from "./painter";
import { bodyHalfWidth, classify, FLAG_BARBEL, FLAG_EYE, FLAG_FIN, type ShapeHit } from "./shape";
import {
    clamp,
    hash3,
    BITE_LIFE,
    KOI_NODES,
    LEAP_DURATION,
    LEAP_MID,
    leapHeight,
    TAU,
    PELLET_LIFE,
    PELLET_SINK,
    RIPPLE_SPEED,
    rippleLife,
    smoothstep,
    SPLASH_LIFE,
    waveProgress,
    waveRadius,
    type Bite,
    type Box,
    type Koi,
    type Wave,
    type World,
} from "./world";

export type Rgb = [number, number, number];

/** How far, as a fraction of body length at full height, a leaping koi's shadow sits down and right of its body. */
const SHADOW_SHIFT = 0.14;

/** How far a leaping koi throws its fins open: wide, but not the full spread, which would swallow the frame. */
const LEAP_FLARE = 1.2;

// How visible a koi stays while it swims under page content.
const DIM_UNDER_CONTENT = 0.15;

/**
 * Every colour and strength the pond is drawn with. Pass your own to `KoiRenderer.setPalette` to restyle it.
 * Keep `white`, `red` and `black` as distinct array objects: the markings are matched to them by identity.
 */
export interface Palette {
    /** Page background, which tiles are mixed toward. */
    bg: Rgb;
    white: Rgb;
    red: Rgb;
    black: Rgb;
    fin: Rgb;
    eye: Rgb;
    water: Rgb;
    pellet: Rgb;
    shadow: Rgb;
    shadowAlpha: number;
    alpha: number;
    /** How much a deep koi fades, as the alpha it keeps at the bottom of the pond. */
    depthFloor: number;
    /** How much skin colour a tile carries, from shadow (0) to lit (1); the rest is page background. */
    tile: [number, number];
    /** Hi (the red-orange of koi markings) from deep shadow to a lit highlight, so patches shade across hues. */
    hi: Rgb[];
    /** Glyph brightness relative to the tile under it. */
    ink: number;
    /** The golden koi's skin from deep shadow to a bright highlight, in six steps. */
    gold: Rgb[];
}

export const DARK_PALETTE: Palette = {
    bg: [26, 25, 33],
    white: [236, 228, 218],
    red: [232, 96, 56],
    black: [92, 90, 108],
    fin: [214, 206, 198],
    eye: [20, 20, 26],
    water: [255, 247, 240],
    shadow: [0, 0, 0],
    shadowAlpha: 0.55,
    pellet: [236, 170, 92],
    alpha: 0.8,
    depthFloor: 0.4,
    tile: [0.68, 0.98],
    hi: [
        [112, 22, 24],
        [168, 34, 28],
        [214, 58, 30],
        [240, 96, 34],
        [250, 138, 52],
        [255, 178, 96],
    ],
    ink: 0.42,
    gold: [
        [92, 54, 16],
        [146, 88, 24],
        [198, 132, 36],
        [232, 168, 58],
        [248, 198, 100],
        [255, 226, 152],
    ],
};

// Paper page: tiles are pale washes of the skin colour with dark glyphs etched on top.
export const LIGHT_PALETTE: Palette = {
    bg: [245, 244, 241],
    white: [112, 108, 104],
    red: [204, 62, 28],
    black: [36, 33, 40],
    fin: [138, 132, 126],
    eye: [24, 22, 26],
    water: [38, 37, 35],
    shadow: [60, 58, 56],
    shadowAlpha: 0.2,
    pellet: [176, 108, 40],
    alpha: 0.9,
    depthFloor: 0.55,
    tile: [0.78, 0.55],
    hi: [
        [138, 24, 22],
        [184, 38, 24],
        [222, 62, 28],
        [238, 100, 38],
        [244, 140, 66],
        [248, 176, 116],
    ],
    ink: 0.45,
    gold: [
        [118, 68, 12],
        [166, 102, 20],
        [204, 136, 34],
        [228, 164, 52],
        [242, 192, 92],
        [250, 216, 140],
    ],
};

/**
 * Optional art tweaks; the defaults reproduce the original look pixel for pixel.
 * - `cell`: target cell width in px (default: width / 125, clamped to 8..12). Smaller gives finer outlines.
 * - `style`: `tile` washes each cell in skin colour with a glyph etched on it; `ink` draws glyphs only, picked from a
 *   brightness ramp and coloured like the skin, on the bare background.
 * - `halo`: false stops the pale tiles and dark shadow marks that ring the koi from reading as grey blocks.
 * - `edge`: true gives outline cells a glyph that follows the outline (`/ \ ( ) _ -`) and fin cells a line along
 *   their rays, so contours and fins read as shapes rather than steps.
 * - `wake`: brightness multiplier for the tail wake and ripple glyphs.
 * - `backdrop`: true paints the palette's page background under the pond on the canvas itself, so the pond is
 *   opaque and a splash uncovers whatever lies beneath the canvas. Off, the canvas is transparent between glyphs.
 */
export interface ArtOptions {
    cell?: number;
    style?: "tile" | "ink";
    halo?: boolean;
    edge?: boolean;
    wake?: number;
    backdrop?: boolean;
}
type Art = Required<Omit<ArtOptions, "cell">> & { cell: number | null };
const DEFAULT_ART: Art = { cell: null, style: "tile", halo: true, edge: false, wake: 1, backdrop: false };

/** Light to dense, for the ink style. */
const INK_RAMP = " .:-=+*#%@";

// Dense glyphs etched into each skin tile, sparse where it catches the light.
/** Plain `fillText` is as fast as the atlas path or faster in software-rasterised Chromium; the atlas is opt-in via `setGlyphMode`. */
const DEFAULT_GLYPH_MODE: GlyphMode = "text";

const TILE_GLYPHS = "t%SX8@#";
const SUBSAMPLES = [0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75];

// A line glyph that follows a direction in screen space, for fin rays and ripple rings.
function lineGlyph(dx: number, dy: number) {
    const d = Math.hypot(dx, dy) || 1;
    if (Math.abs(dy) < 0.38 * d) return "-";
    if (Math.abs(dx) < 0.38 * d) return "|";
    return dx * dy > 0 ? "\\" : "/";
}

/** A glyph that follows the outline, given the direction (in px) from a cell's centre into the body. */
function outlineGlyph(gx: number, gy: number) {
    const d = Math.hypot(gx, gy) || 1;
    if (Math.abs(gy) < 0.38 * d) return gx > 0 ? "(" : ")";
    if (Math.abs(gx) < 0.38 * d) return gy > 0 ? "-" : "_";
    // The outline runs perpendicular to that direction.
    return -gy * gx > 0 ? "\\" : "/";
}

function valueNoise(x: number, y: number, seed: number) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = smoothstep(0, 1, x - xi);
    const v = smoothstep(0, 1, y - yi);
    const a = hash3(xi, yi, seed);
    const b = hash3(xi + 1, yi, seed);
    const c = hash3(xi, yi + 1, seed);
    const d = hash3(xi + 1, yi + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** A marking in body space: centred at (s, v) along and across the spine, as fractions of length. */
type Patch = { s: number; v: number; rs: number; rv: number };
type Markings = { red: Patch[]; black: Patch[] };

function inPatch(m: Patch, s: number, vn: number, wobble: number) {
    return ((s - m.s) / m.rs) ** 2 + ((vn - m.v) / m.rv) ** 2 < 1 + wobble;
}

/**
 * Each koi gets a fixed set of markings, seeded by its id, so every fish carries a clear pattern:
 * kohaku a red head and two or three red saddles on white, sanke the same plus small black spots,
 * tancho a single red disc on the crown.
 */
function koiMarkings(k: Koi): Markings {
    const r = (j: number) => hash3(k.id, j, 41);
    if (k.variety === "tancho") return { red: [{ s: 0.11, v: 0, rs: 0.05, rv: 0.055 }], black: [] };

    const red: Patch[] = [];
    if (r(0) < 0.75) red.push({ s: 0.1, v: (r(1) - 0.5) * 0.03, rs: 0.055 + r(2) * 0.03, rv: 0.11 });
    const saddles = 2 + Math.floor(r(3) * 2);
    for (let j = 0; j < saddles; j++) {
        const span = 0.42 / saddles;
        red.push({
            s: 0.25 + span * (j + 0.5) + (r(10 + j) - 0.5) * span * 0.3,
            v: (r(20 + j) - 0.5) * 0.05,
            rs: span * (0.32 + r(30 + j) * 0.12),
            rv: 0.09 + r(40 + j) * 0.05,
        });
    }

    const black: Patch[] = [];
    if (k.variety === "sanke") {
        const spots = 4 + Math.floor(r(50) * 3);
        for (let j = 0; j < spots; j++) {
            black.push({ s: 0.24 + r(60 + j) * 0.44, v: (r(70 + j) - 0.5) * 0.16, rs: 0.022, rv: 0.026 });
        }
    }
    return { red, black };
}

const packRgb = (c: Rgb) => (c[0] << 16) | (c[1] << 8) | c[2];
/** Sample a colour ramp at t in [0, 1]. */
function ramp(stops: Rgb[], t: number): Rgb {
    const x = clamp(t, 0, 1) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    return mix(stops[i], stops[i + 1], x - i);
}

const mix = (a: Rgb, b: Rgb, k: number): Rgb => [
    (a[0] + (b[0] - a[0]) * k) | 0,
    (a[1] + (b[1] - a[1]) * k) | 0,
    (a[2] + (b[2] - a[2]) * k) | 0,
];
const shade = (c: Rgb, k: number): Rgb => [
    Math.min(255, c[0] * k) | 0,
    Math.min(255, c[1] * k) | 0,
    Math.min(255, c[2] * k) | 0,
];

export class KoiRenderer {
    private ctx: CanvasRenderingContext2D;
    private dpr = 1;
    private cw = 8;
    private ch = 12;
    private cols = 0;
    private rows = 0;
    private palette = DARK_PALETTE;
    private painter: CellPainter;
    private markingCache = new Map<number, Markings>();
    private art: Art = DEFAULT_ART;
    private width = 0;
    private height = 0;
    private dimBoxes: Box[] = [];
    private fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";

    private energy = new Float32Array(0);
    private energyTmp = new Float32Array(0);
    private cellGlyph = new Uint16Array(0);
    private cellColor = new Uint32Array(0);
    private cellAlpha = new Float32Array(0);
    private cellTile = new Uint32Array(0);
    private cellTileAlpha = new Float32Array(0);
    private cellDim = new Float32Array(0);
    /** Cells under a koi's shadow on the pond floor. */
    private cellShadow = new Uint8Array(0);
    /** Shadow left on the water by a leaping koi, 0..255: how dark, fading as the koi climbs. */
    private cellShadowLeap = new Uint8Array(0);
    /** Brightest ripple glyph per cell this frame: its alpha and char code. */
    private ripA = new Float32Array(0);
    private ripG = new Uint8Array(0);

    private spine = new Float32Array(KOI_NODES * 2);
    private arc = new Float32Array(KOI_NODES);
    private arcTotal = 1;
    private flareLeft = 1;
    private flareRight = 1;
    // Scratch outputs of sample(), to avoid allocating per sample.
    private hit: ShapeHit = { flag: 0, across: 1, du: 1, da: 0 };
    private hitS = 0;
    private hitV = 0;
    private hitDist = 0;
    private hitTx = 1;
    private hitTy = 0;
    private hitSeg = 0;

    constructor(canvas: HTMLCanvasElement, options: { glyphs?: GlyphMode } = {}) {
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2D canvas unavailable");
        this.ctx = ctx;
        this.painter = new CellPainter(options.glyphs ?? DEFAULT_GLYPH_MODE);
    }

    /** Switch between `fillText` and the glyph atlas; takes effect on the next frame. */
    setGlyphMode(mode: GlyphMode) {
        this.painter.mode = mode;
    }

    /** The width of a grid cell in CSS px. */
    get cellWidth() {
        return this.cw;
    }

    /** Change the art options (merged into the current ones); a new cell size re-lays-out the grid. */
    setArt(opts: ArtOptions) {
        const next: Art = {
            cell: opts.cell === undefined ? this.art.cell : opts.cell,
            style: opts.style ?? this.art.style,
            halo: opts.halo ?? this.art.halo,
            edge: opts.edge ?? this.art.edge,
            wake: opts.wake ?? this.art.wake,
            backdrop: opts.backdrop ?? this.art.backdrop,
        };
        const relayout = next.cell !== this.art.cell;
        this.art = next;
        if (relayout && this.width > 0) {
            this.resize(this.width, this.height, this.dpr);
            this.setDimBoxes(this.dimBoxes);
        }
    }

    setTheme(isLight: boolean) {
        this.setPalette(isLight ? LIGHT_PALETTE : DARK_PALETTE);
    }

    /** Swap in a whole palette. The glyph atlas is refilled lazily, so the next frame already uses the new colours. */
    setPalette(p: Palette) {
        this.palette = p;
        this.painter.clearCaches();
    }

    resize(width: number, height: number, dpr: number) {
        this.dpr = dpr;
        this.width = width;
        this.height = height;
        // Near-square tiles, large enough to read each etched glyph.
        this.cw =
            this.art.cell === null ? clamp(Math.round(width / 125), 8, 12) : Math.max(3, Math.round(this.art.cell));
        this.ch = this.cw + 2;
        this.cols = Math.ceil(width / this.cw);
        this.rows = Math.ceil(height / this.ch);
        this.ctx.canvas.width = Math.round(width * dpr);
        this.ctx.canvas.height = Math.round(height * dpr);
        // Glyph slots depend on the cell size, dpr and font, so a resize starts the painter's caches over.
        this.painter.configure(
            this.cw,
            this.ch,
            this.cols,
            dpr,
            `600 ${Math.round(this.ch * 0.72)}px ${this.fontFamily}`
        );

        const n = this.cols * this.rows;
        this.energy = new Float32Array(n);
        this.energyTmp = new Float32Array(n);
        this.cellGlyph = new Uint16Array(n);
        this.cellColor = new Uint32Array(n);
        this.cellAlpha = new Float32Array(n);
        this.cellTile = new Uint32Array(n);
        this.cellTileAlpha = new Float32Array(n);
        this.cellDim = new Float32Array(n).fill(1);
        this.cellShadow = new Uint8Array(n);
        this.cellShadowLeap = new Uint8Array(n);
        this.ripA = new Float32Array(n);
        this.ripG = new Uint8Array(n);
    }

    /** Fade koi under these canvas-space boxes, easing back in over a few cells around them. */
    setDimBoxes(boxes: Box[]) {
        this.dimBoxes = boxes;
        const { cols, rows, cw, ch, cellDim } = this;
        cellDim.fill(1);
        const pad = cw * 4;
        for (const b of boxes) {
            const c0 = Math.max(0, Math.floor((b.left - pad) / cw));
            const c1 = Math.min(cols - 1, Math.floor((b.right + pad) / cw));
            const r0 = Math.max(0, Math.floor((b.top - pad) / ch));
            const r1 = Math.min(rows - 1, Math.floor((b.bottom + pad) / ch));
            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    const x = c * cw + cw / 2;
                    const y = r * ch + ch / 2;
                    const d = Math.hypot(Math.max(b.left - x, 0, x - b.right), Math.max(b.top - y, 0, y - b.bottom));
                    const i = r * cols + c;
                    cellDim[i] = Math.min(
                        cellDim[i],
                        DIM_UNDER_CONTENT + (1 - DIM_UNDER_CONTENT) * smoothstep(0, pad, d)
                    );
                }
            }
        }
    }

    render(world: World, dt: number) {
        if (this.cols === 0) return;

        this.cellGlyph.fill(0);
        this.cellTileAlpha.fill(0);
        this.cellShadow.fill(0);
        this.cellShadowLeap.fill(0);
        // Deeper koi first, so the ones near the surface glide over them; a koi in the air is above all of them.
        for (const k of [...world.koi].sort((a, b) => (a.leap ? 1 : 0) - (b.leap ? 1 : 0) || a.depth - b.depth)) {
            if (k.leap) this.rasterizeKoi(k, world.time, true);
            this.rasterizeKoi(k, world.time, false);
        }
        this.depositWake(world);
        this.diffuse(dt);

        const { painter } = this;
        painter.begin();
        this.drawShadows();
        this.drawWake();
        this.drawRipples(world);
        this.drawPellets(world);
        this.drawCells();
        // While the splash front crosses the pond, flashes are drawn after the reveal so it doesn't wipe them.
        if (!world.wave) this.drawBites(world);
        painter.flush(this.ctx);
        if (this.art.backdrop) this.fillBackdrop();
        if (world.wave) this.drawWave(world, world.wave);
    }

    /** Paint the page background underneath everything already drawn. */
    private fillBackdrop() {
        const { ctx, palette } = this;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = `rgb(${palette.bg[0]},${palette.bg[1]},${palette.bg[2]})`;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
    }

    /** Wipe the whole canvas to transparent, e.g. once the pond has been washed away. */
    clear() {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    }

    // ── splash ──────────────────────────────────────────────────────────

    /**
     * The splash front: the pond is erased inside it (with a soft edge a couple of cells wide), so whatever lies
     * under the canvas shows from the centre outward. A bright band of line glyphs rides the front, with two fainter
     * rings trailing behind it.
     */
    private drawWave(world: World, wave: Wave) {
        const { ctx, cw, ch, cols, rows, palette, painter, dpr } = this;
        const p = waveProgress(wave, world.time);
        const r = waveRadius(wave, world.time);
        const soft = cw * 2;
        if (r >= 1) {
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.globalCompositeOperation = "destination-out";
            const g = ctx.createRadialGradient(wave.x, wave.y, 0, wave.x, wave.y, r);
            g.addColorStop(Math.max(0, (r - soft) / r), "rgba(0,0,0,1)");
            g.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, this.width, this.height);
            ctx.restore();
        }

        painter.begin();
        // The ring weakens as it thins out toward the edges.
        const fade = 1 - 0.5 * smoothstep(0.6, 1, p);
        // Front band: 2.5 cells wide, brightest at its leading edge. Then two thinner rings further back.
        const bands = [
            { at: r - cw * 1.25, half: cw * 1.25, alpha: 0.95, dots: false, taper: true },
            { at: r - cw * 5, half: cw * 0.6, alpha: 0.5, dots: false, taper: false },
            { at: r - cw * 8.5, half: cw * 0.6, alpha: 0.26, dots: true, taper: false },
        ];
        for (const band of bands) {
            if (band.at < 2) continue;
            const c0 = Math.max(0, Math.floor((wave.x - band.at - band.half) / cw));
            const c1 = Math.min(cols - 1, Math.floor((wave.x + band.at + band.half) / cw));
            const r0 = Math.max(0, Math.floor((wave.y - band.at - band.half) / ch));
            const r1 = Math.min(rows - 1, Math.floor((wave.y + band.at + band.half) / ch));
            for (let row = r0; row <= r1; row++) {
                for (let col = c0; col <= c1; col++) {
                    const dx = col * cw + cw / 2 - wave.x;
                    const dy = row * ch + ch / 2 - wave.y;
                    const off = Math.hypot(dx, dy) - band.at;
                    if (Math.abs(off) > band.half) continue;
                    // Within the front band, dimmer toward the trailing edge.
                    const lead = band.taper ? 0.55 + 0.45 * ((off + band.half) / (2 * band.half)) : 1;
                    const glyph = band.dots ? "." : lineGlyph(-dy, dx);
                    this.glyphAt(row * cols + col, glyph, palette.water, Math.min(1, band.alpha * lead * fade));
                }
            }
        }
        this.drawBites(world);
        painter.flush(ctx, false);
    }

    private glyphAt(i: number, glyph: string, rgb: Rgb, alpha: number) {
        this.painter.glyph(i, glyph.charCodeAt(0), packRgb(rgb), alpha, 0);
    }

    private cellIndex(x: number, y: number) {
        const c = Math.floor(x / this.cw);
        const r = Math.floor(y / this.ch);
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
        return r * this.cols + c;
    }

    // ── koi ─────────────────────────────────────────────────────────────

    /** Find the nearest point on the render spine, then classify it against the koi's outline. */
    private sample(px: number, py: number, L: number, from = 0, to = KOI_NODES - 2) {
        const { spine, arc } = this;
        let best = Infinity;
        let bestS = 0;
        let bestSign = 1;
        let past = 0;
        let ahead = 0;
        let lateral = 0;
        for (let n = from; n <= to; n++) {
            const ax = spine[n * 2];
            const ay = spine[n * 2 + 1];
            const sx = spine[(n + 1) * 2] - ax;
            const sy = spine[(n + 1) * 2 + 1] - ay;
            const len2 = sx * sx + sy * sy || 1;
            const raw = ((px - ax) * sx + (py - ay) * sy) / len2;
            const u = clamp(raw, 0, 1);
            const d2 = (px - ax - sx * u) ** 2 + (py - ay - sy * u) ** 2;
            if (d2 < best) {
                const len = Math.sqrt(len2);
                best = d2;
                bestS = (arc[n] + u * len) / this.arcTotal;
                bestSign = sx * (py - ay) - sy * (px - ax) >= 0 ? 1 : -1;
                past = n === KOI_NODES - 2 ? Math.max(0, raw - 1) * len : 0;
                ahead = n === 0 ? Math.max(0, -raw) * len : 0;
                lateral = Math.abs(sx * (py - ay) - sy * (px - ax)) / len;
                this.hitTx = sx / len;
                this.hitTy = sy / len;
                this.hitSeg = n;
            }
        }

        const a = Math.sqrt(best);
        this.hitDist = a;
        this.hitS = bestS;
        this.hitV = a * bestSign;
        return classify(
            bestS,
            a / L,
            past / L,
            bestSign > 0 ? this.flareLeft : this.flareRight,
            this.hit,
            ahead / L,
            lateral / L
        );
    }

    /** Skin colour for a body point, from the koi's own markings pinned to body coordinates. */
    private skin(k: Koi, s: number, v: number, across: number, length: number): Rgb {
        const p = this.palette;
        const vn = v / length;
        // Belly edges and the tail stalk stay white on every variety, which frames the markings.
        if (across > 0.9 || s > 0.74) return p.white;
        // Ragged edges, so patches read as painted markings rather than ellipses.
        const wobble = (valueNoise(s * 14 + k.id, vn * 30, k.id + 3) - 0.5) * 0.6;
        const markings = this.markings(k);
        for (const m of markings.black) if (inPatch(m, s, vn, wobble)) return p.black;
        for (const m of markings.red) if (inPatch(m, s, vn, wobble)) return p.red;
        return p.white;
    }

    private markings(k: Koi) {
        let m = this.markingCache.get(k.id);
        if (!m) {
            m = koiMarkings(k);
            this.markingCache.set(k.id, m);
        }
        return m;
    }

    /**
     * Rasterise one koi into the cell grid. A koi in mid-leap is sampled the same way from a spine that is bowed,
     * scaled about the middle of the body and has its fins flared. With `shadowOnly` the leaping koi is instead
     * sampled as the smaller, fainter shadow it throws on the water, shifted down and right as it climbs, and only
     * the shadow cells are marked.
     */
    private rasterizeKoi(k: Koi, t: number, shadowOnly: boolean) {
        const { spine, arc, cw, ch, cols, rows, cellGlyph, cellColor, cellAlpha, cellTile, cellTileAlpha, palette } =
            this;
        const leap = k.leap;
        const u = leap ? clamp(leap.age / LEAP_DURATION, 0, 1) : 0;
        const h = leap ? leapHeight(leap.age) : 0;
        const bend = u < 0.4 ? smoothstep(0, 0.4, u) : 1 - smoothstep(0.4, 1, u);
        const bow = leap ? leap.side * k.length * 0.1 * bend : 0;
        const scale = shadowOnly ? 1 - 0.35 * h : 1 + 0.25 * h;
        const L0 = k.length;
        const L = L0 * scale;
        const nodes = k.nodes;
        // The body only undulates while the tail is beating; coasting koi hold almost straight.
        const swim = 0.2 + 1.1 * k.beat;

        // Travelling body wave that grows toward the tail.
        for (let n = 0; n < KOI_NODES; n++) {
            const s = n / (KOI_NODES - 1);
            const a = Math.max(0, n - 1);
            const b = Math.min(KOI_NODES - 1, n + 1);
            let tx = nodes[a * 2] - nodes[b * 2];
            let ty = nodes[a * 2 + 1] - nodes[b * 2 + 1];
            const tl = Math.hypot(tx, ty) || 1;
            tx /= tl;
            ty /= tl;
            const amp = L0 * 0.04 * (0.05 + 0.95 * Math.pow(s, 2.2)) * swim;
            let off = amp * Math.sin(k.phase - s * 4.6);
            // Bowed like a drawn bow: both ends stay on the line and the middle swings to one side.
            if (bow !== 0) off += bow * Math.sin(Math.PI * s);
            spine[n * 2] = nodes[n * 2] - ty * off;
            spine[n * 2 + 1] = nodes[n * 2 + 1] + tx * off;
        }
        if (scale !== 1) {
            const mx = (spine[LEAP_MID * 2] + spine[LEAP_MID * 2 + 2]) / 2;
            const my = (spine[LEAP_MID * 2 + 1] + spine[LEAP_MID * 2 + 3]) / 2;
            for (let n = 0; n < KOI_NODES; n++) {
                spine[n * 2] = mx + (spine[n * 2] - mx) * scale;
                spine[n * 2 + 1] = my + (spine[n * 2 + 1] - my) * scale;
            }
        }
        if (shadowOnly) {
            // The shadow stays down on the water while the body rises, so it slides away from the body.
            const away = (SHADOW_SHIFT * L0 * h) / Math.SQRT2;
            for (let n = 0; n < KOI_NODES; n++) {
                spine[n * 2] += away;
                spine[n * 2 + 1] += away;
            }
        }
        arc[0] = 0;
        for (let n = 1; n < KOI_NODES; n++) {
            arc[n] =
                arc[n - 1] + Math.hypot(spine[n * 2] - spine[(n - 1) * 2], spine[n * 2 + 1] - spine[(n - 1) * 2 + 1]);
        }
        this.arcTotal = arc[KOI_NODES - 1] || 1;
        // Pectorals tuck in during a burst, scull in turn while coasting, and the inner one spreads to brake on a turn.
        const spread = 1 - 0.25 * k.beat;
        const scull = 0.18 * (1 - k.beat) * Math.sin(k.finPhase);
        const bank = clamp(k.turn * 0.6, -0.35, 0.35);
        this.flareLeft = spread + scull - bank;
        this.flareRight = spread - scull + bank;
        if (leap) {
            // Fins thrown fully open while the koi is in the air.
            const open = Math.min(1, h * 1.6);
            this.flareLeft += (LEAP_FLARE - this.flareLeft) * open;
            this.flareRight += (LEAP_FLARE - this.flareRight) * open;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let n = 0; n < KOI_NODES; n++) {
            minX = Math.min(minX, spine[n * 2]);
            maxX = Math.max(maxX, spine[n * 2]);
            minY = Math.min(minY, spine[n * 2 + 1]);
            maxY = Math.max(maxY, spine[n * 2 + 1]);
        }
        const reach = L * 0.26;
        const c0 = Math.max(0, Math.floor((minX - reach) / cw));
        const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw));
        const r0 = Math.max(0, Math.floor((minY - reach) / ch));
        const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch));
        if (c0 > c1 || r0 > r1) return;

        // Each side gets a single eye: the eye-hit cell closest to where the eye ideally sits. The rest of the
        // eye band is painted as plain skin, so a big koi doesn't grow a row of "o o o o".
        const eyeCell = this.pickEyeCells(L);
        const gold = k.variety === "ogon";

        const diag = Math.hypot(cw, ch);
        // Near the surface a koi is brighter and its shadow falls farther away on the floor.
        const shadowDc = Math.round((L * 0.07 * k.depth) / cw) + 1;
        const shadowDr = Math.round((L * 0.05 * k.depth) / ch) + 1;
        let dim = palette.alpha * (palette.depthFloor + (1 - palette.depthFloor) * k.depth);
        // Out of the water the koi is lit to full.
        if (h > 0) dim += (1 - dim) * h;
        const [tile0, tile1] = palette.tile;
        const hit = this.hit;
        const { style, edge, halo } = this.art;
        const ink = style === "ink";

        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const x = c * cw;
                const y = r * ch;
                const centerHit = this.sample(x + cw / 2, y + ch / 2, L);
                // Nothing reaches far from the spine at the waist, where the fins end.
                if (!centerHit && this.hitDist > L * (this.hitS > 0.4 && this.hitS < 0.62 ? 0.15 : 0.25) + diag) {
                    // Distance to the spine changes by at most a cell per cell, so skip cells that can't reach it.
                    c += Math.max(0, Math.floor((this.hitDist - L * 0.25 - diag) / cw));
                    continue;
                }
                // Sub-samples sit within a cell of the centre, so only the neighbouring segments can be nearest.
                const from = Math.max(0, this.hitSeg - 2);
                const to = Math.min(KOI_NODES - 2, this.hitSeg + 2);
                let { flag, across } = hit;
                let finDu = hit.du;
                let finDa = hit.da;
                let s = this.hitS;
                let v = this.hitV;
                let tx = this.hitTx;
                let ty = this.hitTy;

                let hits = centerHit ? 1 : 0;
                // Points from the cell centre toward the covered side, i.e. across the outline into the koi.
                let gx = 0;
                let gy = 0;
                // Cells well inside the body can't have a sub-sample outside it, so skip straight to full coverage.
                const deepInside =
                    centerHit &&
                    flag !== FLAG_FIN &&
                    flag !== FLAG_BARBEL &&
                    s > 0.04 &&
                    s < 0.72 &&
                    bodyHalfWidth(s) * L - this.hitDist > diag * 0.35;
                if (deepInside) hits = 5;
                for (let q = 0; !deepInside && q < SUBSAMPLES.length; q += 2) {
                    if (!this.sample(x + SUBSAMPLES[q] * cw, y + SUBSAMPLES[q + 1] * ch, L, from, to)) continue;
                    gx += (SUBSAMPLES[q] - 0.5) * cw;
                    gy += (SUBSAMPLES[q + 1] - 0.5) * ch;
                    if (hits === 0) {
                        ({ flag, across } = hit);
                        finDu = hit.du;
                        finDa = hit.da;
                        s = this.hitS;
                        v = this.hitV;
                        tx = this.hitTx;
                        ty = this.hitTy;
                    }
                    hits++;
                }
                if (hits === 0) continue;
                this.hitTx = tx;
                this.hitTy = ty;
                const coverage = hits / 5;
                const side = v >= 0 ? 1 : -1;

                const i = r * cols + c;
                // Body-anchored key so each glyph rides along with the skin.
                const key = (hash3(Math.round(s * 90), Math.round(v / (cw * 0.8)), k.id) * 4294967295) >>> 0;
                const solid = centerHit && coverage >= 0.6;
                if (shadowOnly) {
                    const skinCell = flag !== FLAG_BARBEL && flag !== FLAG_FIN && !(flag === FLAG_EYE && solid);
                    // The shadow's own offset is already in the spine, so it lands on the cell it was sampled in.
                    if (skinCell && hits === 5) this.cellShadowLeap[r * cols + c] = Math.round(255 * (1 - 0.7 * h));
                    continue;
                }

                let glyph = " ";
                let rgb: Rgb = palette.fin;
                let alpha = dim;
                let tile: Rgb | null = null;
                let tileAlpha = 0;
                if (flag === FLAG_BARBEL) {
                    // Drawn along the whisker: forward from the mouth and angled out to its side.
                    glyph = lineGlyph(-tx - side * ty * 0.7, -ty + side * tx * 0.7);
                    rgb = shade(mix(palette.bg, palette.fin, 0.9), palette.ink + 0.3);
                } else if (flag === FLAG_EYE && solid && i === eyeCell[v >= 0 ? 0 : 1]) {
                    tile = mix(palette.bg, palette.eye, 0.85);
                    tileAlpha = dim;
                    glyph = "o";
                    rgb = mix(palette.bg, palette.white, 0.9);
                } else if (flag === FLAG_FIN) {
                    // Fins are a faint wash of tile with rays drawn over it in the pale body colour, so they read
                    // as translucent membrane next to the body rather than a slab. The tail keeps the V notch of its
                    // outline because cells outside it are simply not hit.
                    // The golden koi's fins are pale gold.
                    const finTint = gold ? ramp(palette.gold, palette.bg[0] < 128 ? 0.9 : 0.5) : palette.white;
                    tile = mix(palette.bg, gold ? finTint : palette.fin, 0.55);
                    tileAlpha = dim * 0.45 * coverage * 0.25;
                    // Rays run from the root outward: body-space (du along the spine, da away from it) in screen space.
                    const ray = () => lineGlyph(finDu * tx - finDa * side * ty, finDu * ty + finDa * side * tx);
                    if (ink && h === 0) {
                        tile = null;
                        tileAlpha = 0;
                        glyph = coverage >= 0.8 && key % 2 === 0 ? ray() : ".";
                        rgb = mix(palette.bg, palette.fin, 0.85);
                        alpha = dim * (0.2 + 0.35 * coverage);
                    } else {
                        // In the air the wash fades out by half height and only the rays are left.
                        tileAlpha *= 1 - clamp(h / 0.5, 0, 1);
                        if (!halo) tileAlpha *= 0.35;
                        glyph = coverage >= 0.4 ? ray() : ".";
                        rgb = finTint;
                        alpha = dim * (0.5 + 0.4 * coverage);
                    }
                } else {
                    // Each skin cell is a tile washed in the skin colour, shaded like a rounded back lit from
                    // the top-left, with a dense glyph etched on top. Edge cells get a paler, empty tile.
                    // The golden koi is one colour all over; its "skin" is routed through the red path with the gold ramp.
                    const skin = gold ? palette.red : this.skin(k, s, v, across, L);
                    const facing = side * (0.6 * ty - 0.8 * tx) * across;
                    const lum = clamp(0.22 + 0.5 * Math.sqrt(1 - across * across) + 0.18 * facing, 0, 1);
                    if (gold) {
                        // Metallic: a soft highlight band (about 0.15 of the body long, 2.5 s end to end) slides from
                        // the head to the tail, lifting the gold a step or two as it passes.
                        const centre = ((t / 2.5 + hash3(k.id, 9, 5)) % 1) * 1.3 - 0.15;
                        const x = clamp((s - centre) / 0.075, -1, 1);
                        const band = 0.5 * (1 + Math.cos(Math.PI * x));
                        const grain = (valueNoise(s * 9 + k.id, (v / L) * 18, k.id + 21) - 0.5) * 0.12;
                        tile = ramp(palette.gold, 0.12 + 0.68 * lum + grain + band * 0.5);
                    } else if (skin === palette.red) {
                        // Red patches run the full hi ramp: crimson in shadow, vermilion across the back, orange
                        // to amber where the light hits. Each koi leans a little redder or more orange, and a
                        // slow body-pinned noise varies the hue within a patch, like real pigment.
                        const lean = (hash3(k.id, 5, 17) - 0.5) * 0.3;
                        const grain = (valueNoise(s * 9 + k.id, (v / L) * 18, k.id + 21) - 0.5) * 0.25;
                        // A band of shine travels down the body, like light sliding over wet scales.
                        const sheen = Math.max(0, Math.sin(s * 11 - t * 1.8 + k.id) - 0.7) / 0.3;
                        tile = ramp(palette.hi, 0.15 + 0.8 * lum + lean + grain + sheen * 0.35);
                    } else {
                        tile = mix(palette.bg, skin, tile0 + (tile1 - tile0) * lum);
                    }
                    // Ink style paints with the skin colour itself, lit by the same shading.
                    const skinInk: Rgb = ink
                        ? skin === palette.red
                            ? tile
                            : mix(palette.bg, skin, 0.62 + 0.38 * lum)
                        : tile;
                    if (hits === 5) {
                        const sc = c + shadowDc;
                        const sr = r + shadowDr;
                        if (!leap && sc < cols && sr < rows) this.cellShadow[sr * cols + sc] = 1;
                        tileAlpha = ink ? 0 : dim;
                        if (s < 0.035 && across < 0.6 && k.gulp > 0.5) {
                            glyph = "o";
                            rgb = ink ? mix(palette.bg, skin, 0.35) : palette.eye;
                        } else if (ink) {
                            const jitter = ((key >>> 4) % 3) - 1;
                            const weight = skin === palette.black ? 0.75 : 1;
                            const d = clamp((lum * 1.15 - 0.05 + jitter * 0.04) * weight, 0, 1);
                            glyph = INK_RAMP[1 + Math.round(d * (INK_RAMP.length - 2))];
                            rgb = skinInk;
                            const tick = Math.floor(t * 1.4 + (key % 997) / 97);
                            if (hash3(key, tick, 7) < 0.03) rgb = mix(rgb, palette.bg, 0.45);
                        } else {
                            const jitter = (key >>> 4) % 3;
                            glyph = TILE_GLYPHS[clamp(Math.round((1 - lum) * 4) + jitter, 0, TILE_GLYPHS.length - 1)];
                            rgb = shade(tile, palette.ink);
                            // White skin is etched lightly so the red and black patches carry the pattern.
                            if (skin === palette.white) alpha *= 0.6;
                            // Scales glint on a staggered clock.
                            const tick = Math.floor(t * 1.4 + (key % 997) / 97);
                            if (hash3(key, tick, 7) < 0.03) tile = mix(tile, palette.bg, 0.45);
                        }
                    } else {
                        tileAlpha = ink ? 0 : dim * coverage * 0.55;
                        // Without the halo, only cells mostly inside the body keep a (fainter) tile.
                        if (!halo && !ink) tileAlpha = coverage >= 0.6 ? tileAlpha * 0.5 : 0;
                        const g = Math.hypot(gx, gy);
                        if (edge && g > cw * 0.1) {
                            glyph = outlineGlyph(gx, gy);
                            rgb = mix(palette.bg, skin === palette.red ? skinInk : skin, 0.85);
                            alpha = dim * (0.55 + 0.4 * coverage);
                        } else if (ink) {
                            if (g > cw * 0.2) {
                                glyph = coverage >= 0.6 ? ":" : ".";
                                rgb = skinInk;
                                alpha = dim * 0.8;
                            }
                        } else if (g > cw * 0.2 && key % 3 === 0) {
                            glyph = ".";
                            rgb = shade(tile, palette.ink);
                        }
                    }
                }
                if (glyph === " " && tileAlpha === 0) continue;
                cellTile[i] = tile ? packRgb(tile) : 0;
                cellTileAlpha[i] = tileAlpha;
                cellGlyph[i] = glyph.charCodeAt(0);
                cellColor[i] = packRgb(rgb);
                cellAlpha[i] = alpha;
            }
        }
    }

    /**
     * The cell for each eye of the koi in `spine` (index 0 for the side where v >= 0, 1 for the other), or -1:
     * among cells near the ideal eye spot whose centre hits the eye, the closest one; else the cell holding the spot.
     */
    private pickEyeCells(L: number): [number, number] {
        const { spine, arc, cw, ch, cols, rows } = this;
        const sEye = 0.0775;
        const target = sEye * this.arcTotal;
        let n = 0;
        while (n < KOI_NODES - 2 && arc[n + 1] < target) n++;
        const sx = spine[(n + 1) * 2] - spine[n * 2];
        const sy = spine[(n + 1) * 2 + 1] - spine[n * 2 + 1];
        const len = Math.hypot(sx, sy) || 1;
        const u = clamp((target - arc[n]) / len, 0, 1);
        const bx = spine[n * 2] + sx * u;
        const by = spine[n * 2 + 1] + sy * u;
        const out: [number, number] = [-1, -1];
        for (let k = 0; k < 2; k++) {
            const sign = k === 0 ? 1 : -1;
            const off = 0.675 * bodyHalfWidth(sEye) * L * sign;
            const ex = bx + (-sy / len) * off;
            const ey = by + (sx / len) * off;
            const c0 = Math.floor(ex / cw);
            const r0 = Math.floor(ey / ch);
            let best = Infinity;
            for (let r = r0 - 2; r <= r0 + 2; r++) {
                for (let c = c0 - 2; c <= c0 + 2; c++) {
                    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
                    if (!this.sample(c * cw + cw / 2, r * ch + ch / 2, L) || this.hit.flag !== FLAG_EYE) continue;
                    const d = (c * cw + cw / 2 - ex) ** 2 + (r * ch + ch / 2 - ey) ** 2;
                    if (d < best) {
                        best = d;
                        out[k] = r * cols + c;
                    }
                }
            }
            if (out[k] < 0 && c0 >= 0 && r0 >= 0 && c0 < cols && r0 < rows) out[k] = r0 * cols + c0;
        }
        return out;
    }

    private drawCells() {
        const { cellGlyph, cellColor, cellAlpha, cellTile, cellTileAlpha, cellDim } = this;
        for (let i = 0; i < cellGlyph.length; i++) {
            const code = cellGlyph[i];
            if (!code) continue;
            if (cellTileAlpha[i] > 0) this.painter.tile(i, cellTile[i], cellTileAlpha[i] * cellDim[i]);
            if (code === 32) continue;
            this.painter.glyph(i, code, cellColor[i], cellAlpha[i] * cellDim[i], 1);
        }
    }

    // ── water ───────────────────────────────────────────────────────────

    private depositWake(world: World) {
        const { energy } = this;
        for (const k of world.koi) {
            for (let n = KOI_NODES - 4; n < KOI_NODES; n++) {
                const i = this.cellIndex(k.nodes[n * 2], k.nodes[n * 2 + 1]);
                if (i >= 0) energy[i] = Math.min(1.5, energy[i] + 0.035 + k.speed * 0.0012);
            }
        }
        if (world.pointer.active) {
            const i = this.cellIndex(world.pointer.x, world.pointer.y);
            if (i >= 0) energy[i] = Math.min(1.5, energy[i] + 0.12);
        }
    }

    /** Blur and decay so wakes spread like ripples and fade. */
    private diffuse(dt: number) {
        const { cols, rows, energy, energyTmp: tmp } = this;
        const decay = Math.exp(-dt * 1.1);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const l = c > 0 ? energy[i - 1] : energy[i];
                const rt = c < cols - 1 ? energy[i + 1] : energy[i];
                const u = r > 0 ? energy[i - cols] : energy[i];
                const d = r < rows - 1 ? energy[i + cols] : energy[i];
                tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay;
            }
        }
        this.energy = tmp;
        this.energyTmp = energy;
    }

    private drawShadows() {
        const { cellShadow, cellShadowLeap, cellGlyph, cellDim, palette } = this;
        for (let i = 0; i < cellShadow.length; i++) {
            if (!cellShadow[i] || cellGlyph[i]) continue;
            if (this.art.halo) this.glyphAt(i, ":", palette.shadow, palette.shadowAlpha * cellDim[i]);
            else this.glyphAt(i, ".", palette.shadow, palette.shadowAlpha * 0.5 * cellDim[i]);
        }
        for (let i = 0; i < cellShadowLeap.length; i++) {
            if (!cellShadowLeap[i] || cellShadow[i] || cellGlyph[i]) continue;
            // Sparse, faint specks rather than a block: mostly `.`, a few `:`, at most 0.35 opaque, fading as the koi climbs.
            const pick = hash3(i, 3, 29);
            if (pick > 0.5) continue;
            const alpha = (cellShadowLeap[i] / 255) * Math.min(0.35, palette.shadowAlpha) * cellDim[i];
            this.glyphAt(i, pick < 0.07 ? ":" : ".", palette.shadow, alpha);
        }
    }

    private drawWake() {
        const { energy, cellGlyph, cellShadow, palette } = this;
        for (let i = 0; i < energy.length; i++) {
            const e = energy[i];
            if (e < 0.22 || cellGlyph[i] || cellShadow[i]) continue;
            this.glyphAt(
                i,
                e > 0.5 ? "-" : ".",
                palette.water,
                Math.min(1, Math.min(1, (e - 0.22) * 1.4) * 0.35 * this.art.wake)
            );
        }
    }

    /**
     * Expanding rings drawn as ASCII circles, one cell wide: every cell the circle passes through gets the line
     * glyph that follows the circle's tangent there (- / | \\ by octant). Where rings overlap a cell keeps the
     * brightest one, so crossing rings never cancel into fragments.
     */
    private drawRipples(world: World) {
        const { cw, ch, cols, rows, cellGlyph, ripA, ripG, palette } = this;
        ripA.fill(0);
        for (const rp of world.ripples) {
            const age = world.time - rp.born;
            const fade = Math.pow(1 - age / rippleLife(rp), 1.5) * rp.strength;
            for (let ring = 0; ring < 2; ring++) {
                const radius = Math.max(0, age - ring * 0.45) * RIPPLE_SPEED * (0.7 + 0.5 * rp.strength);
                if (radius < 2) continue;
                const c0 = Math.max(0, Math.floor((rp.x - radius - cw) / cw));
                const c1 = Math.min(cols - 1, Math.floor((rp.x + radius + cw) / cw));
                const r0 = Math.max(0, Math.floor((rp.y - radius - ch) / ch));
                const r1 = Math.min(rows - 1, Math.floor((rp.y + radius + ch) / ch));
                const alpha = Math.min(1, fade * (ring === 0 ? 0.8 : 0.4) * this.art.wake);
                for (let r = r0; r <= r1; r++) {
                    for (let c = c0; c <= c1; c++) {
                        const i = r * cols + c;
                        if (cellGlyph[i] || alpha <= ripA[i]) continue;
                        const dx = c * cw + cw / 2 - rp.x;
                        const dy = r * ch + ch / 2 - rp.y;
                        const d = Math.hypot(dx, dy) || 1;
                        // The circle crosses this cell when its distance from the centre is within the cell's
                        // half-extent along the radial direction.
                        const half = 0.5 * (Math.abs(dx / d) * cw + Math.abs(dy / d) * ch);
                        if (Math.abs(d - radius) > half) continue;
                        ripA[i] = alpha;
                        ripG[i] = lineGlyph(-dy, dx).charCodeAt(0);
                    }
                }
            }
        }
        for (let i = 0; i < ripA.length; i++) {
            if (ripA[i] > 0) this.painter.glyph(i, ripG[i], packRgb(palette.water), ripA[i], 0);
        }
    }

    /** A bite flashes * over the koi's mouth, settling to + then a dot as the splash takes over. */
    private drawBites(world: World) {
        const { palette } = this;
        for (const b of world.bites) {
            if (b.size) {
                this.drawSplash(b, world.time);
                continue;
            }
            const i = this.cellIndex(b.x, b.y);
            if (i < 0) continue;
            const t = (world.time - b.born) / BITE_LIFE;
            const glyph = t < 0.35 ? "*" : t < 0.7 ? "+" : ".";
            this.glyphAt(i, glyph, palette.pellet, Math.min(1, palette.alpha * 1.6) * (1 - t * t));
        }
    }

    /** A splash: a burst at the centre and a crown of droplets thrown outward, `size` cells deep, fading as they land. */
    private drawSplash(b: Bite, now: number) {
        const { palette, cw, ch } = this;
        const t = (now - b.born) / SPLASH_LIFE;
        const alpha = Math.min(1, palette.alpha * 1.6) * (1 - t * t);
        const colour = b.gold ? ramp(palette.gold, 0.95) : palette.water;
        const centre = this.cellIndex(b.x, b.y);
        if (centre >= 0) this.glyphAt(centre, t < 0.3 ? "*" : t < 0.6 ? "+" : ".", colour, alpha);
        const drops = 8 + 4 * b.size!;
        const seed = Math.round(b.born * 1000);
        for (let j = 0; j < drops; j++) {
            // Each droplet flies out at its own angle and speed and falls short of the crown's full reach.
            const angle = hash3(seed, j, 11) * TAU;
            const reach = (0.4 + 0.6 * hash3(seed, j, 12)) * b.size! * 2.6;
            const flight = Math.min(1, t * 1.6);
            const d = reach * (1 - (1 - flight) ** 2);
            const i = this.cellIndex(b.x + Math.cos(angle) * d * cw, b.y + Math.sin(angle) * d * ch);
            if (i < 0) continue;
            this.glyphAt(i, t < 0.35 ? "o" : t < 0.65 ? "*" : ".", colour, alpha * (0.6 + 0.4 * hash3(seed, j, 13)));
        }
    }

    /** Pellets fall in (' then .), land as o with a splash, bob while floating, then dim to . as they sink. */
    private drawPellets(world: World) {
        const { cellGlyph, palette, ch } = this;
        for (const p of world.pellets) {
            const age = world.time - p.born;
            if (!p.landed) {
                const fall = age / p.landAt;
                // Drawn a little above where it will land, closing in as it drops.
                const i = this.cellIndex(p.x, p.y - (1 - fall) * ch * 1.5);
                if (i < 0 || cellGlyph[i]) continue;
                // A speck at first, growing to an o as it nears the water.
                this.glyphAt(
                    i,
                    fall < 0.5 ? "\u00b7" : "o",
                    palette.pellet,
                    Math.min(1, palette.alpha * (0.7 + 0.5 * fall))
                );
                continue;
            }
            const i = this.cellIndex(p.x, p.y);
            if (i < 0 || cellGlyph[i]) continue;
            const sink = smoothstep(PELLET_SINK, PELLET_LIFE, age);
            // A solid dot in a brighter shade of the pellet colour that glimmers slowly (0.75 to 1), then sinks away.
            const lit = palette.bg[0] < 128 ? mix(palette.pellet, [255, 255, 255], 0.3) : shade(palette.pellet, 0.8);
            const glimmer = 0.875 + 0.125 * Math.sin(age * 2.4 + p.x * 0.7);
            // A chip of the pellet colour under it, so the dot reads at a glance against the dark water.
            if (sink <= 0.55) this.painter.tile(i, packRgb(palette.pellet), 0.28 * glimmer * (1 - sink));
            this.glyphAt(i, sink > 0.55 ? "." : "\u25cf", lit, glimmer * (1 - 0.85 * sink));
        }
    }
}
