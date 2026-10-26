/**
 * Lazily filled glyph atlas: every (character, colour) pair the pond draws is rasterised once into a slot on an
 * offscreen page, and frames then copy slots with `drawImage` instead of shaping text for every cell.
 *
 * Slots hold the glyph already painted in its (quantised) colour at full opacity, so per-cell alpha is just
 * `globalAlpha` on the copy, which composites exactly like `fillText` with that alpha.
 */

const PAGE_SIZE = 2048;
/** Pages kept before the whole atlas is dropped and refilled; the pond only ever needs a few thousand colours. */
const MAX_PAGES = 6;
/** Room around the cell, in CSS px, so glyphs that overhang their cell aren't clipped. */
const PAD = 2;

/** Bits kept per colour channel. 8 is exact; fewer shares slots between near-identical colours. */
export const COLOR_BITS = 5;
const KEEP = (0xff << (8 - COLOR_BITS)) & 0xff;
const QMASK = KEEP * 0x010101;
// Land in the middle of each bucket, so quantising doesn't darken everything.
const QMID = COLOR_BITS >= 8 ? 0 : (1 << (7 - COLOR_BITS)) * 0x010101;

type Page = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

export class GlyphAtlas {
    /** Slot size in device pixels. */
    slotW = 0;
    slotH = 0;
    private font = "";
    private dpr = 1;
    private perRow = 1;
    private perPage = 1;
    private pages: Page[] = [];
    private slots = new Map<number, number>();
    private count = 0;
    /** Ink bounds per character, relative to a slot: x, y, width, height in device px. */
    private bounds = new Map<number, [number, number, number, number]>();
    /** The same bounds per slot, flattened, so drawing a slot never copies its transparent margin. */
    private slotBox = new Int16Array(0);
    /** Set when the atlas outgrew its pages; the owner should call `clear()` at a frame boundary. */
    full = false;

    /** Set the cell geometry and font. Always drops existing slots, since their pixels depend on all of these. */
    configure(cw: number, ch: number, dpr: number, font: string) {
        this.dpr = dpr;
        this.font = font;
        this.slotW = Math.ceil((cw + 2 * PAD) * dpr);
        this.slotH = Math.ceil((ch + 2 * PAD) * dpr);
        this.perRow = Math.max(1, Math.floor(PAGE_SIZE / this.slotW));
        this.perPage = this.perRow * Math.max(1, Math.floor(PAGE_SIZE / this.slotH));
        this.bounds.clear();
        this.slotBox = new Int16Array(MAX_PAGES * this.perPage * 4);
        this.clear();
    }

    clear() {
        this.slots.clear();
        this.pages = [];
        this.count = 0;
        this.full = false;
    }

    get size() {
        return this.count;
    }

    /** Slot for a glyph (ASCII char code) in a packed 0xRRGGBB colour, rasterising it on first use. */
    slot(code: number, rgb: number) {
        const q = COLOR_BITS >= 8 ? rgb : (rgb & QMASK) | QMID;
        const key = (q << 7) | code;
        let id = this.slots.get(key);
        if (id === undefined) {
            id = this.add(code, q);
            this.slots.set(key, id);
        }
        return id;
    }

    page(id: number) {
        return this.pages[(id / this.perPage) | 0].canvas;
    }

    /** Source rect of the slot's ink inside its page. */
    sx(id: number) {
        return (id % this.perRow) * this.slotW + this.slotBox[id * 4];
    }

    sy(id: number) {
        return (((id % this.perPage) / this.perRow) | 0) * this.slotH + this.slotBox[id * 4 + 1];
    }

    /** Offset of that ink from the slot's top-left corner. */
    bx(id: number) {
        return this.slotBox[id * 4];
    }

    by(id: number) {
        return this.slotBox[id * 4 + 1];
    }

    sw(id: number) {
        return this.slotBox[id * 4 + 2];
    }

    sh(id: number) {
        return this.slotBox[id * 4 + 3];
    }

    /** Where the ink sits within the slot, found once per character by drawing it and scanning for set pixels. */
    private ink(code: number) {
        let b = this.bounds.get(code);
        if (b) return b;
        const { slotW: w, slotH: h, dpr } = this;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("2D canvas unavailable");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.font = this.font;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String.fromCharCode(code), w / 2 / dpr, h / 2 / dpr);
        const px = ctx.getImageData(0, 0, w, h).data;
        let x0 = w;
        let y0 = h;
        let x1 = -1;
        let y1 = -1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (px[(y * w + x) * 4 + 3] === 0) continue;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
        b = x1 < 0 ? [0, 0, 1, 1] : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
        this.bounds.set(code, b);
        return b;
    }

    private add(code: number, rgb: number) {
        const id = this.count++;
        const pageIndex = (id / this.perPage) | 0;
        if (pageIndex >= MAX_PAGES) {
            // Keep drawing from the last page this frame (wrong glyphs beat a crash); the owner resets next frame.
            this.full = true;
            this.count = id;
            return id - 1;
        }
        let page = this.pages[pageIndex];
        if (!page) {
            const canvas = document.createElement("canvas");
            canvas.width = PAGE_SIZE;
            canvas.height = PAGE_SIZE;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("2D canvas unavailable");
            page = { canvas, ctx };
            this.pages[pageIndex] = page;
        }
        const { ctx } = page;
        const x = (id % this.perRow) * this.slotW;
        const y = (((id % this.perPage) / this.perRow) | 0) * this.slotH;
        this.slotBox.set(this.ink(code), id * 4);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.font = this.font;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = `rgb(${rgb >>> 16},${(rgb >>> 8) & 255},${rgb & 255})`;
        // Same centre the cell would have had: the slot's middle, in CSS px.
        ctx.fillText(String.fromCharCode(code), (x + this.slotW / 2) / this.dpr, (y + this.slotH / 2) / this.dpr);
        return id;
    }
}
