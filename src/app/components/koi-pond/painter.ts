import { GlyphAtlas } from "./glyph-atlas";

/**
 * How glyphs reach the canvas.
 * - `text`: plain `fillText`, replayed in painting order from the recorded draw list. Pixel-identical to drawing
 *   directly. (Regrouping glyphs by colour and alpha to save state changes was tried and measured no faster.)
 * - `atlas`: every (glyph, colour) is rasterised once into an offscreen atlas and frames copy it with `drawImage`.
 *
 * Which is faster depends on the browser's canvas backend; see bench/koi-pond/README.md.
 */
export type GlyphMode = "text" | "atlas";

const KIND_GLYPH = 0;
const KIND_TILE = 1;
const CHARS: string[] = Array.from({ length: 128 }, (_, c) => String.fromCharCode(c));
const rgbCss = (rgb: number) => `rgb(${rgb >>> 16},${(rgb >>> 8) & 255},${rgb & 255})`;

/**
 * Records a frame's cell draws in painting order (tiles, then glyphs) and replays them in one pass.
 * Cells are addressed by index into a `cols`-wide grid.
 */
export class CellPainter {
    mode: GlyphMode;
    private atlas = new GlyphAtlas();
    private font = "";
    private cw = 8;
    private ch = 12;
    private cols = 1;
    private dpr = 1;
    private rectW = 0;
    private rectH = 0;
    private styles = new Map<number, string>();

    private kind = new Uint8Array(0);
    private cell = new Int32Array(0);
    private offset = new Uint8Array(0);
    private code = new Uint8Array(0);
    private rgb = new Int32Array(0);
    private alpha = new Float32Array(0);
    private slot = new Int32Array(0);
    private count = 0;

    constructor(mode: GlyphMode) {
        this.mode = mode;
    }

    configure(cw: number, ch: number, cols: number, dpr: number, font: string) {
        this.cw = cw;
        this.ch = ch;
        this.cols = cols;
        this.dpr = dpr;
        this.font = font;
        this.rectW = Math.round((cw - 1) * dpr);
        this.rectH = Math.round((ch - 1) * dpr);
        this.atlas.configure(cw, ch, dpr, font);
    }

    /** Drop colour-keyed caches, e.g. after a palette change. */
    clearCaches() {
        this.atlas.clear();
    }

    begin() {
        this.count = 0;
        if (this.atlas.full) this.atlas.clear();
    }

    private next() {
        const n = this.count++;
        if (n >= this.alpha.length) {
            const size = Math.max(4096, this.alpha.length * 2);
            const grow = <T extends Uint8Array | Int32Array | Float32Array>(a: T): T => {
                const b = new (a.constructor as new (n: number) => T)(size);
                b.set(a);
                return b;
            };
            this.kind = grow(this.kind);
            this.cell = grow(this.cell);
            this.offset = grow(this.offset);
            this.code = grow(this.code);
            this.rgb = grow(this.rgb);
            this.alpha = grow(this.alpha);
            this.slot = grow(this.slot);
        }
        return n;
    }

    /** A glyph centred in cell `i`, `offset` CSS px below its middle. */
    glyph(i: number, code: number, rgb: number, alpha: number, offset: number) {
        const n = this.next();
        this.kind[n] = KIND_GLYPH;
        this.cell[n] = i;
        this.offset[n] = offset;
        this.code[n] = code;
        this.rgb[n] = rgb;
        this.alpha[n] = alpha;
    }

    /** A tile filling cell `i`, less its top and left gridline. */
    tile(i: number, rgb: number, alpha: number) {
        const n = this.next();
        this.kind[n] = KIND_TILE;
        this.cell[n] = i;
        this.rgb[n] = rgb;
        this.alpha[n] = alpha;
    }

    private style(rgb: number) {
        let s = this.styles.get(rgb);
        if (!s) {
            s = rgbCss(rgb);
            this.styles.set(rgb, s);
        }
        return s;
    }

    /** Replay the recorded draws; `clear: false` paints over what is already on the canvas. */
    flush(ctx: CanvasRenderingContext2D, clear = true) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (clear) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        if (this.mode === "atlas") this.flushAtlas(ctx);
        else this.flushText(ctx);
        ctx.globalAlpha = 1;
    }

    // ── atlas ───────────────────────────────────────────────────────────

    private flushAtlas(ctx: CanvasRenderingContext2D) {
        const { atlas, kind, cell, offset, code, rgb, alpha, slot, count, cols, cw, ch, dpr, rectW, rectH } = this;
        // Fill the atlas first: writing to it between copies would force the browser to snapshot it again.
        for (let n = 0; n < count; n++) if (kind[n] === KIND_GLYPH) slot[n] = atlas.slot(code[n], rgb[n]);
        ctx.imageSmoothingEnabled = false;
        let a = -1;
        let fill = -1;
        for (let n = 0; n < count; n++) {
            if (alpha[n] !== a) {
                a = alpha[n];
                ctx.globalAlpha = a;
            }
            const i = cell[n];
            const col = i % cols;
            const row = (i / cols) | 0;
            if (kind[n] === KIND_GLYPH) {
                const id = slot[n];
                const w = atlas.sw(id);
                const h = atlas.sh(id);
                const x = Math.round((col * cw + cw / 2) * dpr - atlas.slotW / 2) + atlas.bx(id);
                const y = Math.round((row * ch + ch / 2 + offset[n]) * dpr - atlas.slotH / 2) + atlas.by(id);
                ctx.drawImage(atlas.page(id), atlas.sx(id), atlas.sy(id), w, h, x, y, w, h);
            } else {
                if (rgb[n] !== fill) {
                    fill = rgb[n];
                    ctx.fillStyle = this.style(fill);
                }
                ctx.fillRect(Math.round((col * cw + 1) * dpr), Math.round((row * ch + 1) * dpr), rectW, rectH);
            }
        }
    }

    // ── text ────────────────────────────────────────────────────────────

    /** The original draw sequence, replayed in recorded order with redundant alpha and fill changes skipped. */
    private flushText(ctx: CanvasRenderingContext2D) {
        const { kind, cell, offset, code, rgb, alpha, count, cols, cw, ch, dpr } = this;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.font = this.font;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        let a = -1;
        let fill = -1;
        for (let n = 0; n < count; n++) {
            if (alpha[n] !== a) {
                a = alpha[n];
                ctx.globalAlpha = a;
            }
            if (rgb[n] !== fill) {
                fill = rgb[n];
                ctx.fillStyle = this.style(fill);
            }
            const i = cell[n];
            const x = (i % cols) * cw;
            const y = ((i / cols) | 0) * ch;
            if (kind[n] === KIND_GLYPH) ctx.fillText(CHARS[code[n]], x + cw / 2, y + ch / 2 + offset[n]);
            else ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
        }
    }
}
