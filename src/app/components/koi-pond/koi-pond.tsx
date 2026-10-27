"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { cn } from "../../../lib/utils";
import { KoiRenderer, type ArtOptions } from "./renderer";
import { waveProgress, World, type Box } from "./world";

export type PondStats = { koi: number; pellets: number };

/** Connection state the pond acts out; see `PondEngine.setMood`. */
export type PondMood = "checking" | "connected" | "disconnected" | "unregistered" | "absent";

const STEP = 1 / 60;
const MAX_STEPS = 4;
const INTERACTIVE = "a, button, input, textarea, select, label, [role='button'], [data-koi-ignore]";
// Content over the pond carries this attribute; koi steer around it and fade beneath it.
const AVOID_TARGETS = "[data-koi-avoid]";
// Re-measure the content boxes this often, in frames, to follow layout shifts and entrance animations.
const MEASURE_EVERY_FRAMES = 30;
// Content boxes closer than this merge, so koi aren't squeezed into the slot between them.
const MERGE_GAP_PX = 160;

function mergeNearby(boxes: Box[]) {
    const merged: Box[] = [];
    for (const b of [...boxes].sort((p, q) => p.top - q.top)) {
        const near = merged.find(
            (m) => b.top - m.bottom < MERGE_GAP_PX && b.left - m.right < MERGE_GAP_PX && m.left - b.right < MERGE_GAP_PX
        );
        if (!near) {
            merged.push({ ...b });
            continue;
        }
        near.left = Math.min(near.left, b.left);
        near.right = Math.max(near.right, b.right);
        near.bottom = Math.max(near.bottom, b.bottom);
    }
    return merged;
}

class PondEngine {
    private world = new World();
    private renderer: KoiRenderer;
    private raf = 0;
    private last = 0;
    private acc = 0;
    private frames = 0;
    private lastPointerTime = 0;
    private reported: PondStats = { koi: -1, pellets: -1 };
    private visible = true;
    private disposed = false;
    private moodTimer: ReturnType<typeof setInterval> | null = null;
    private mood: PondMood | null = null;
    private anchor: string | undefined;
    private splashing: Promise<void> | null = null;
    private finishSplash: (() => void) | null = null;
    private resizeObserver = new ResizeObserver(() => this.resize());
    private intersectionObserver = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        this.schedule();
    });

    constructor(
        private canvas: HTMLCanvasElement,
        isLight: boolean,
        private onStats: (stats: PondStats) => void,
        private onRenderMs?: (ms: number) => void,
        private onSplashProgress?: (p: number) => void
    ) {
        this.renderer = new KoiRenderer(canvas);
        this.renderer.setTheme(isLight);
        this.resizeObserver.observe(canvas);
        this.intersectionObserver.observe(canvas);
        window.addEventListener("pointermove", this.onPointerMove, { passive: true });
        window.addEventListener("click", this.onClick);
        document.documentElement.addEventListener("pointerleave", this.onPointerLeave);
        window.addEventListener("blur", this.onPointerLeave);
        this.resize();
        this.schedule();
    }

    destroy() {
        this.disposed = true;
        cancelAnimationFrame(this.raf);
        this.clearMood();
        this.resizeObserver.disconnect();
        this.intersectionObserver.disconnect();
        window.removeEventListener("pointermove", this.onPointerMove);
        window.removeEventListener("click", this.onClick);
        document.documentElement.removeEventListener("pointerleave", this.onPointerLeave);
        window.removeEventListener("blur", this.onPointerLeave);
    }

    setTheme(isLight: boolean) {
        this.renderer.setTheme(isLight);
    }

    /** Where mood events happen, in canvas space: the centre of the anchor element, else the canvas centre. */
    private anchorPoint() {
        const origin = this.canvas.getBoundingClientRect();
        const el = document.querySelector(this.anchor ?? AVOID_TARGETS);
        if (!el) return { x: origin.width / 2, y: origin.height / 2 };
        const b = el.getBoundingClientRect();
        return { x: (b.left + b.right) / 2 - origin.left, y: (b.top + b.bottom) / 2 - origin.top };
    }

    setArt(opts: ArtOptions) {
        this.renderer.setArt(opts);
    }

    /** Let the koi leap now and then on their own (every 25 to 60 seconds). */
    setLeaps(on: boolean) {
        this.world.autoLeap = on;
    }

    /** Make one koi leap right now: one near the surface if there is one. */
    leap() {
        if (this.splashing || this.disposed) return false;
        return this.world.leap();
    }

    /**
     * A stone dropped at the anchor: a shock front washes the pond away from there outward, so what lies under the
     * canvas is uncovered from the middle. Resolves once the whole canvas is clear, after which the engine has
     * stopped and released its listeners; later calls do nothing and resolve at once.
     */
    splash(): Promise<void> {
        if (this.splashing) return this.splashing;
        if (this.disposed) return Promise.resolve();
        this.clearMood();
        const { x, y } = this.anchorPoint();
        this.world.splash(x, y);
        this.splashing = new Promise<void>((resolve) => {
            this.finishSplash = resolve;
        });
        return this.splashing;
    }

    /** The front has crossed the pond: leave the canvas transparent and stop everything. */
    private endSplash() {
        this.renderer.clear();
        this.destroy();
        this.onSplashProgress?.(1);
        this.finishSplash?.();
        this.finishSplash = null;
    }

    private clearMood() {
        if (this.moodTimer !== null) clearInterval(this.moodTimer);
        this.moodTimer = null;
        this.world.setUnease(0);
    }

    /**
     * Act out a connection state at the anchor. Entering a state fires its one-off event, and the previous state's
     * lasting effects (the heartbeat timer, unrest) are cleared first. Re-sending the same mood does nothing.
     */
    setMood(mood: PondMood, anchor?: string) {
        if (this.splashing || this.disposed) return;
        if (mood === this.mood && anchor === this.anchor) return;
        this.mood = mood;
        this.anchor = anchor;
        this.clearMood();
        const world = this.world;
        const { x, y } = this.anchorPoint();
        if (mood === "checking") {
            const beat = () => {
                const p = this.anchorPoint();
                world.pulse(p.x, p.y, 0.15);
            };
            beat();
            this.moodTimer = setInterval(beat, 1600);
        } else if (mood === "connected") {
            world.pulse(x, y, 0.8);
            world.gather(x, y, 4);
        } else if (mood === "disconnected") {
            world.scatter(x, y);
            world.setUnease(1);
        }
    }

    private resize() {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        this.renderer.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
        this.world.resize(rect.width, rect.height);
        this.measureContent();
        this.report();
    }

    // Only call back when a count changes, so the page doesn't re-render every frame.
    private report() {
        const koi = this.world.koi.length;
        const pellets = this.world.pellets.length;
        if (koi === this.reported.koi && pellets === this.reported.pellets) return;
        this.reported = { koi, pellets };
        this.onStats(this.reported);
    }

    private schedule = () => {
        cancelAnimationFrame(this.raf);
        if (this.disposed || !this.visible) return;
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.frame);
    };

    private measureContent() {
        const origin = this.canvas.getBoundingClientRect();
        const measured = Array.from(document.querySelectorAll(AVOID_TARGETS), (el) => {
            const b = el.getBoundingClientRect();
            return {
                left: b.left - origin.left,
                top: b.top - origin.top,
                right: b.right - origin.left,
                bottom: b.bottom - origin.top,
            };
        });
        const boxes = mergeNearby(measured);
        this.renderer.setDimBoxes(boxes);
        this.world.avoid = boxes;
    }

    private frame = (now: number) => {
        const dt = Math.min(0.1, (now - this.last) / 1000);
        this.last = now;
        this.acc += dt;
        let steps = 0;
        while (this.acc >= STEP && steps < MAX_STEPS) {
            this.world.step(STEP);
            this.acc -= STEP;
            steps++;
        }
        if (steps === MAX_STEPS) this.acc = 0;
        if (++this.frames % MEASURE_EVERY_FRAMES === 0) this.measureContent();
        const t0 = this.onRenderMs ? performance.now() : 0;
        this.renderer.render(this.world, dt);
        this.onRenderMs?.(performance.now() - t0);
        const wave = this.world.wave;
        if (wave) {
            const p = waveProgress(wave, this.world.time);
            if (p >= 1) return this.endSplash();
            this.onSplashProgress?.(p);
        }
        this.report();
        this.raf = requestAnimationFrame(this.frame);
    };

    private toLocal(e: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        return { x, y, inside: x >= 0 && y >= 0 && x <= rect.width && y <= rect.height };
    }

    private onPointerMove = (e: PointerEvent) => {
        const { x, y, inside } = this.toLocal(e);
        const p = this.world.pointer;
        const elapsed = Math.max(1, e.timeStamp - this.lastPointerTime) / 1000;
        const speed = Math.hypot(x - p.x, y - p.y) / elapsed;
        p.speed += (Math.min(speed, 5000) - p.speed) * 0.5;
        this.lastPointerTime = e.timeStamp;
        p.x = x;
        p.y = y;
        p.active = inside && e.pointerType !== "touch";
    };

    // Clicks on empty space drop food; links, buttons, and text selection are left alone.
    private onClick = (e: MouseEvent) => {
        // The path recorded at dispatch, not target.closest(): a control that re-renders as it's clicked (the theme
        // toggle swaps its icon) can leave the target detached, with no ancestors left to find the button through.
        if (this.splashing) return;
        if (e.composedPath().some((n) => n instanceof Element && n.matches(INTERACTIVE))) return;
        if (window.getSelection()?.toString()) return;
        const { x, y, inside } = this.toLocal(e);
        if (!inside) return;
        this.world.feed(x, y);
        this.report();
    };

    private onPointerLeave = () => {
        this.world.pointer.active = false;
        this.world.pointer.speed = 0;
    };
}

type KoiPondProps = {
    isLight: boolean;
    className?: string;
    onStats?: (stats: PondStats) => void;
    /** Connection state to act out; defaults to plain swimming. */
    mood?: PondMood;
    /** CSS selector of the element mood events happen at. Defaults to the first `[data-koi-avoid]` element. */
    anchor?: string;
    /** Renderer art options; omit for the original look. */
    art?: ArtOptions;
    /** Called with the time `render()` took, every frame. For benchmarking. */
    onRenderMs?: (ms: number) => void;
    /** Let koi leap out of the water now and then, every 25 to 60 seconds. Off by default. */
    leaps?: boolean;
    /** Called every frame of a splash with how far the front has gone, 0 to 1, so the page can fade its content in step. */
    onSplashProgress?: (progress: number) => void;
};

export type KoiPondHandle = {
    /** Make one koi leap right now, e.g. to preview it. */
    leap(): boolean;
    /** Wash the pond away from the anchor outward; resolves once the canvas is clear and the pond has stopped for good. */
    splash(): Promise<void>;
};

const KoiPond = forwardRef<KoiPondHandle, KoiPondProps>(function KoiPond(
    { isLight, className, onStats, mood = "absent", anchor, art, leaps = false, onRenderMs, onSplashProgress },
    ref
) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const engineRef = useRef<PondEngine | null>(null);
    // Read through a ref so a new callback doesn't tear down the engine.
    const onStatsRef = useRef(onStats);
    onStatsRef.current = onStats;
    const onRenderMsRef = useRef(onRenderMs);
    onRenderMsRef.current = onRenderMs;
    const onSplashProgressRef = useRef(onSplashProgress);
    onSplashProgressRef.current = onSplashProgress;
    const leapsRef = useRef(leaps);
    leapsRef.current = leaps;
    const artRef = useRef(art);
    artRef.current = art;

    useImperativeHandle(
        ref,
        () => ({
            leap: () => engineRef.current?.leap() ?? false,
            splash: () => engineRef.current?.splash() ?? Promise.resolve(),
        }),
        []
    );

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const engine = new PondEngine(
            canvas,
            isLight,
            (stats) => onStatsRef.current?.(stats),
            (ms) => onRenderMsRef.current?.(ms),
            (p) => onSplashProgressRef.current?.(p)
        );
        if (artRef.current) engine.setArt(artRef.current);
        engine.setLeaps(leapsRef.current);
        engineRef.current = engine;
        return () => {
            engine.destroy();
            engineRef.current = null;
        };
    }, []);

    useEffect(() => {
        engineRef.current?.setTheme(isLight);
    }, [isLight]);

    useEffect(() => {
        engineRef.current?.setLeaps(leaps);
    }, [leaps]);

    useEffect(() => {
        if (art) engineRef.current?.setArt(art);
    }, [art]);

    useEffect(() => {
        engineRef.current?.setMood(mood, anchor);
    }, [mood, anchor]);

    return <canvas ref={canvasRef} aria-hidden="true" className={cn("pointer-events-none", className)} />;
});

export default KoiPond;
