export const TAU = Math.PI * 2;
export const KOI_NODES = 20;
export const RIPPLE_SPEED = 52;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export function smoothstep(e0: number, e1: number, x: number) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
}

export function angleDiff(a: number, b: number) {
    let d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
}

// Deterministic integer hash to [0, 1), so textures stay pinned to the body.
export function hash3(x: number, y: number, z: number) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

export type Box = { left: number; top: number; right: number; bottom: number };

export type Variety = "kohaku" | "sanke" | "tancho";

const VARIETY_WEIGHTS: [Variety, number][] = [
    ["kohaku", 3],
    ["sanke", 2],
    ["tancho", 1],
];
const TOTAL_WEIGHT = VARIETY_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

function pickVariety(): Variety {
    let r = Math.random() * TOTAL_WEIGHT;
    for (const [variety, weight] of VARIETY_WEIGHTS) {
        r -= weight;
        if (r <= 0) return variety;
    }
    return "kohaku";
}

/** A koi in mid-leap; see `World.leap`. */
export interface Leap {
    /** Seconds since take-off. */
    age: number;
    /** Which way the body bows, +1 or -1. */
    side: 1 | -1;
}

export interface Koi {
    id: number;
    variety: Variety;
    length: number;
    /** Spine positions, snout first: [x0, y0, x1, y1, ...]. */
    nodes: Float32Array;
    heading: number;
    speed: number;
    phase: number;
    /** Smoothed angular velocity, used to splay the fins into turns. */
    turn: number;
    wander: number;
    /** How strongly this koi swims over to the cursor. */
    curiosity: number;
    /** 0.5 deep and dim to 1 just under the surface. */
    depth: number;
    depthTarget: number;
    depthMax: number;
    nextDive: number;
    nextSurface: number;
    /** When a koi swimming near the surface next sends a small ring off its tail. */
    nextWake: number;
    /** 1 just after food hits the water nearby, fading: the koi sprints and turns harder while it lasts. */
    rush: number;
    /** The pellet this koi is going for. It sticks with it so a burst of clicks doesn't yank it around. */
    food: Pellet | null;
    /** Tail-beat intensity: koi swim in bursts of beats, then coast with the tail still. */
    beat: number;
    burstUntil: number;
    nextBurst: number;
    /** Phase of the pectoral fins, which scull gently while the koi coasts or hovers. */
    finPhase: number;
    /** 1 right after a fright, fading as the koi calms down. */
    startle: number;
    fleeX: number;
    fleeY: number;
    /** How far the mouth is open, as the koi closes in on food. */
    gulp: number;
    /** Set while the koi is out of the water. */
    leap: Leap | null;
}

export interface Pellet {
    x: number;
    y: number;
    born: number;
    /** Seconds after `born` that it hits the water; until then it's falling and koi can't eat it. */
    landAt: number;
    landed: boolean;
    /** Slow drift once it's floating. */
    vx: number;
    vy: number;
}

/** The moment a koi takes a pellet, drawn as a brief flash where it happened. */
export interface Bite {
    x: number;
    y: number;
    born: number;
    /** Omitted for the small flash of a bite. Larger values are splashes, drawn as a crown of droplets that many cells wide. */
    size?: number;
}

/** The shock wave `World.splash` sends out: a front that races from (x, y) to past the farthest corner. */
export interface Wave {
    x: number;
    y: number;
    born: number;
    duration: number;
    /** The radius the front reaches at the end, a little past the farthest corner. */
    maxR: number;
    /** Koi the front has already shoved, so each is pushed once. */
    pushed: Set<Koi>;
}

export interface Ripple {
    x: number;
    y: number;
    born: number;
    strength: number;
}

const push = { x: 0, y: 0 };

/** Sum of pushes away from every box within `margin` of (x, y), each scaled 0..1 by closeness. */
function repel(boxes: Box[], x: number, y: number, margin: number, out: { x: number; y: number }) {
    out.x = 0;
    out.y = 0;
    for (const b of boxes) {
        let ox = x - clamp(x, b.left, b.right);
        let oy = y - clamp(y, b.top, b.bottom);
        let d = Math.hypot(ox, oy);
        if (d > margin) continue;
        if (d < 1e-3) {
            // Inside the box: head for the nearest edge.
            const edges = [b.left - x, x - b.right, b.top - y, y - b.bottom];
            const nearest = edges.indexOf(Math.max(...edges));
            ox = nearest === 0 ? -1 : nearest === 1 ? 1 : 0;
            oy = nearest === 2 ? -1 : nearest === 3 ? 1 : 0;
            d = 0;
        }
        const len = Math.hypot(ox, oy) || 1;
        out.x += (ox / len) * (1 - d / margin);
        out.y += (oy / len) * (1 - d / margin);
    }
    return out;
}

export const PELLET_LIFE = 14;
export const BITE_LIFE = 0.45;
/** Splashes (bites with a `size`) hang in the air longer than the flash of a bite. */
export const SPLASH_LIFE = 0.8;
/** Seconds the splash front takes to cross the pond. */
export const WAVE_DURATION = 0.8;
/** Seconds a leap lasts, from take-off to landing. */
export const LEAP_DURATION = 1.1;
/** The spine node a leap is centred on: the middle of the body. */
export const LEAP_MID = (KOI_NODES - 1) >> 1;
/** Seconds between automatic leaps are drawn from this range. */
const AUTO_LEAP_EVERY: [number, number] = [25, 60];
const RUSH_RANGE = 650;
const FEED_CALM = 2;
/** Uneaten pellets start to sink this many seconds in, fading out by PELLET_LIFE. */
export const PELLET_SINK = 9;
const THROW_RADIUS = 34;
const STARTLE_SPEED = 1100;
const MAX_PELLETS = 24;

export class World {
    width = 0;
    height = 0;
    time = 0;
    koi: Koi[] = [];
    pellets: Pellet[] = [];
    bites: Bite[] = [];
    /** The splash front crossing the pond, if `splash` has been called. It stays once finished. */
    wave: Wave | null = null;
    /** When true, a koi near the surface leaps every 25 to 60 seconds. Off by default. */
    autoLeap = false;
    private nextLeap = -1;
    /** Moving the mouse to throw food isn't a threat, so swipes don't startle koi for a moment after a throw. */
    private lastFeed = -Infinity;
    ripples: Ripple[] = [];
    pointer = { x: 0, y: 0, speed: 0, active: false };
    /** Page content the koi steer around, in canvas space. */
    avoid: Box[] = [];
    /** A temporary attraction point set by `gather`: koi near it swim up and circle, like they do around the cursor. */
    private lure: { x: number; y: number; until: number } | null = null;
    /** 0..1 persistent unrest set by `setUnease`: koi stay deeper, swim slower and ignore the cursor. */
    private unease = 0;

    resize(width: number, height: number) {
        const first = this.width === 0;
        this.width = width;
        this.height = height;
        if (first) this.seed();
    }

    private seed() {
        const { width: W, height: H } = this;
        const minSide = Math.min(W, H);
        const baseLength = clamp(minSide * 0.5, 170, 420);
        const count = clamp(Math.round((W * H) / 240000), 3, 6);
        // Wide screens also get a couple of young koi that keep to the deep water, for a sense of depth.
        const young = W >= 1024 ? 2 : 0;

        this.koi = [];
        for (let i = 0; i < count + young; i++) {
            const isYoung = i >= count;
            const length = baseLength * (isYoung ? rand(0.32, 0.45) : rand(0.6, 1));
            const depthMax = isYoung ? 0.72 : 1;
            const heading = rand(0, TAU);
            const x = rand(W * 0.1, W * 0.9);
            const y = rand(H * 0.1, H * 0.9);
            const nodes = new Float32Array(KOI_NODES * 2);
            const seg = length / (KOI_NODES - 1);
            for (let n = 0; n < KOI_NODES; n++) {
                nodes[n * 2] = x - Math.cos(heading) * seg * n;
                nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
            }
            this.koi.push({
                id: i + 1,
                variety: pickVariety(),
                length,
                nodes,
                heading,
                speed: 20,
                phase: rand(0, TAU),
                turn: 0,
                wander: 0,
                curiosity: rand(0.35, 1),
                depth: rand(0.5, depthMax),
                depthTarget: rand(0.5, depthMax),
                depthMax,
                nextDive: rand(6, 18),
                nextSurface: rand(3, 14),
                nextWake: rand(0, 2),
                beat: 0,
                rush: 0,
                food: null,
                burstUntil: 0,
                nextBurst: rand(0, 3),
                finPhase: rand(0, TAU),
                startle: 0,
                fleeX: 0,
                fleeY: 0,
                gulp: 0,
                leap: null,
            });
        }
    }

    /** A loose handful thrown at (x, y): each pellet lands a beat apart with its own splash, then drifts and sinks. */
    feed(x: number, y: number) {
        this.lastFeed = this.time;
        this.ripples.push({ x, y, born: this.time, strength: 0.35 });
        // A full pond takes no more food, rather than dropping old pellets out from under koi already going for them.
        const count = Math.min(5 + Math.floor(Math.random() * 3), MAX_PELLETS - this.pellets.length);
        for (let k = 0; k < count; k++) {
            const a = rand(0, TAU);
            const r = Math.sqrt(Math.random()) * THROW_RADIUS;
            const drift = rand(2, 6);
            this.pellets.push({
                x: x + Math.cos(a) * r * 1.3,
                y: y + Math.sin(a) * r,
                born: this.time,
                landAt: rand(0.15, 0.45),
                landed: false,
                vx: Math.cos(a) * drift,
                vy: Math.sin(a) * drift,
            });
        }
    }

    /** A heartbeat: one ring of the given strength at (x, y). */
    pulse(x: number, y: number, strength = 0.15) {
        this.ripples.push({ x, y, born: this.time, strength });
    }

    /** Draw the koi toward (x, y) for `seconds`: those within range swim up and circle it. Cursor and food outrank it. */
    gather(x: number, y: number, seconds = 4) {
        this.lure = { x, y, until: this.time + seconds };
    }

    /** Spook every koi within range of (x, y): they bolt away and sink into the dark. */
    scatter(x: number, y: number) {
        const range = 0.6 * Math.min(this.width, this.height);
        for (const k of this.koi) {
            if (Math.hypot(k.nodes[0] - x, k.nodes[1] - y) > range) continue;
            k.startle = 1;
            k.fleeX = x;
            k.fleeY = y;
            k.depthTarget = 0.5;
            // Hold the dive for a while before the next random depth is drawn.
            k.nextDive = Math.max(k.nextDive, this.time + 8);
        }
    }

    /**
     * A stone dropped at (x, y): one strong ring and a splash there, and a shock front that crosses the pond in
     * under a second, much faster than any ripple. Each koi it reaches is shoved outward and dives.
     */
    splash(x: number, y: number) {
        const { width: W, height: H } = this;
        this.wave = {
            x,
            y,
            born: this.time,
            duration: WAVE_DURATION,
            maxR: Math.hypot(Math.max(x, W - x), Math.max(y, H - y)) + 48,
            pushed: new Set(),
        };
        this.ripples.push({ x, y, born: this.time, strength: 1 });
        this.bites.push({ x, y, born: this.time, size: 4 });
    }

    /**
     * Throw a koi out of the water for `LEAP_DURATION` seconds: a small ring where it takes off, a big ring and a
     * splash where it lands, and a dive afterwards. With no argument, picks a koi near the surface that isn't busy,
     * else the shallowest one. Koi within one body length of page content (`avoid`) are never picked, since the leap
     * would happen under it. Returns false, doing nothing, if no koi qualifies.
     */
    leap(k?: Koi): boolean {
        const fish = k ?? this.pickLeaper(true) ?? this.pickLeaper(false);
        if (!fish || fish.leap) return false;
        const mid = LEAP_MID;
        this.ripples.push({ x: fish.nodes[mid * 2], y: fish.nodes[mid * 2 + 1], born: this.time, strength: 0.4 });
        fish.leap = { age: 0, side: Math.random() < 0.5 ? -1 : 1 };
        fish.speed = Math.max(fish.speed, (12 + fish.length * 0.05) * 2.2);
        return true;
    }

    /** A random koi that is near the surface and calm (`idle`), or else simply the shallowest one not in the air. */
    private pickLeaper(idle: boolean) {
        const free = this.koi.filter((k) => !k.leap && !this.nearContent(k));
        const pool = idle
            ? this.unease === 0
                ? free.filter((k) => k.depth > 0.75 && k.startle === 0 && !k.food && k.rush === 0)
                : []
            : [free.reduce<Koi | null>((best, k) => (!best || k.depth > best.depth ? k : best), null)];
        return pool.length === 0 ? null : idle ? pool[Math.floor(Math.random() * pool.length)] : pool[0];
    }

    /** Whether the middle of the koi is within one body length of a content box. */
    private nearContent(k: Koi) {
        const x = k.nodes[LEAP_MID * 2];
        const y = k.nodes[LEAP_MID * 2 + 1];
        return this.avoid.some(
            (b) => x > b.left - k.length && x < b.right + k.length && y > b.top - k.length && y < b.bottom + k.length
        );
    }

    private stepLeap(k: Koi, leap: Leap, dt: number) {
        leap.age += dt;
        // Out of the water the koi is as near the surface as it gets.
        k.depth += (1 - k.depth) * Math.min(1, dt * 6);
        if (leap.age < LEAP_DURATION) return;
        k.leap = null;
        const mid = LEAP_MID;
        const x = k.nodes[mid * 2];
        const y = k.nodes[mid * 2 + 1];
        this.ripples.push({ x, y, born: this.time, strength: 0.9 });
        this.bites.push({ x, y, born: this.time, size: 3 });
        // Back under and down for a few seconds.
        k.depthTarget = 0.5;
        k.nextDive = Math.max(k.nextDive, this.time + rand(4, 7));
    }

    private stepAutoLeap() {
        if (this.nextLeap < 0) {
            this.nextLeap = this.time + rand(...AUTO_LEAP_EVERY);
        } else if (this.time >= this.nextLeap) {
            const k = this.pickLeaper(true);
            if (k) this.leap(k);
            // Nobody suitable right now: look again shortly rather than waiting out another full interval.
            this.nextLeap = this.time + (k ? rand(...AUTO_LEAP_EVERY) : 3);
        }
    }

    /** Persistent unrest, 0 (calm) to 1: koi cap their depth near 0.55, slow down by up to 35% and stop following the cursor. */
    setUnease(level: number) {
        this.unease = clamp(level, 0, 1);
    }

    step(dt: number) {
        this.time += dt;
        this.pointer.speed *= Math.exp(-dt * 8);
        for (const k of this.koi) this.stepKoi(k, dt);
        for (const k of this.koi) if (k.leap) this.stepLeap(k, k.leap, dt);
        if (this.autoLeap) this.stepAutoLeap();
        else this.nextLeap = -1;
        if (this.wave) this.stepWave(this.wave);
        const t = this.time;
        this.pellets = this.pellets.filter((p) => t - p.born < PELLET_LIFE);
        for (const p of this.pellets) {
            if (!p.landed) {
                if (t - p.born < p.landAt) continue;
                p.landed = true;
                this.ripples.push({ x: p.x, y: p.y, born: t, strength: 0.1 });
                // The splash is what koi react to: every koi in range turns and bolts for it at once.
                for (const k of this.koi) {
                    if (Math.hypot(k.nodes[0] - p.x, k.nodes[1] - p.y) < RUSH_RANGE) k.rush = 1;
                }
                continue;
            }
            const damp = Math.exp(-dt * 0.2);
            p.vx *= damp;
            p.vy *= damp;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
        }
        this.ripples = this.ripples.filter((r) => t - r.born < rippleLife(r));
        this.bites = this.bites.filter((b) => t - b.born < (b.size ? SPLASH_LIFE : BITE_LIFE));
    }

    /** Shove each koi the front has just reached: an outward push like a fright, plus a dive. */
    private stepWave(wave: Wave) {
        const r = waveRadius(wave, this.time);
        for (const k of this.koi) {
            if (wave.pushed.has(k)) continue;
            let near = Infinity;
            for (let n = 0; n < KOI_NODES; n++) {
                near = Math.min(near, Math.hypot(k.nodes[n * 2] - wave.x, k.nodes[n * 2 + 1] - wave.y));
            }
            if (near > r) continue;
            wave.pushed.add(k);
            k.startle = 1;
            k.fleeX = wave.x;
            k.fleeY = wave.y;
            k.depthTarget = 0.5;
            k.nextDive = Math.max(k.nextDive, this.time + 8);
            k.speed = Math.max(k.speed, (12 + k.length * 0.05) * 6);
            // Swing the head part-way round to face away from the stone at once; the body follows within its bend limit.
            const away = Math.atan2(k.nodes[1] - wave.y, k.nodes[0] - wave.x);
            k.heading += clamp(angleDiff(k.heading, away), -0.6, 0.6);
        }
    }

    private stepKoi(k: Koi, dt: number) {
        const { width: W, height: H, pointer, time, unease } = this;
        const L = k.length;
        const nodes = k.nodes;
        const hx = nodes[0];
        const hy = nodes[1];

        let dx = Math.cos(k.heading);
        let dy = Math.sin(k.heading);

        k.wander = clamp(k.wander + (Math.random() - 0.5) * dt * 2.4, -0.9, 0.9);
        dx += Math.cos(k.heading + k.wander) * 0.6;
        dy += Math.sin(k.heading + k.wander) * 0.6;

        const food = this.pickFood(k, hx, hy, Math.max(L * 1.6 + 220, k.rush > 0 ? RUSH_RANGE : 0));

        // A fast swipe close by spooks a koi: it bolts away, then calms down over a couple of seconds.
        // A koi already going for food ignores it; feeding beats fear, and clicking to feed moves the mouse fast.
        const pointerD = Math.hypot(pointer.x - hx, pointer.y - hy);
        const feeding = time - this.lastFeed < FEED_CALM;
        if (!food && !feeding && pointer.active && pointer.speed > STARTLE_SPEED && pointerD < L * 0.9) {
            k.startle = 1;
            k.fleeX = pointer.x;
            k.fleeY = pointer.y;
        }
        k.startle = Math.max(0, k.startle - dt * 0.6);
        const fleeing = k.startle > 0.3 && !food;

        let chasing = false;
        let curious = false;
        let lured = false;
        let closing = 0;
        if (fleeing) {
            const ox = hx - k.fleeX;
            const oy = hy - k.fleeY;
            const d = Math.hypot(ox, oy) || 1;
            dx += (ox / d) * 4 * k.startle;
            dy += (oy / d) * 4 * k.startle;
        } else if (food) {
            const tx = food.x - hx;
            const ty = food.y - hy;
            const d = Math.hypot(tx, ty) || 1;
            dx += (tx / d) * 3;
            dy += (ty / d) * 3;
            chasing = true;
            closing = clamp(1 - d / (L * 1.2), 0, 1);
        } else if (pointer.active && unease === 0) {
            const tx = pointer.x - hx;
            const ty = pointer.y - hy;
            const d = Math.hypot(tx, ty) || 1;
            const range = 300;
            if (d < range) {
                // Swim up to the cursor, then circle under it rather than parking.
                const w = k.curiosity * (1 - d / range) * 2.2;
                const near = clamp(d / (L * 0.6), 0, 1);
                dx += ((tx / d) * near - (ty / d) * (1 - near)) * w;
                dy += ((ty / d) * near + (tx / d) * (1 - near)) * w;
                curious = true;
            }
        }

        const lure = this.lure;
        if (lure && time >= lure.until) this.lure = null;
        if (lure && time < lure.until && !fleeing && !food && !curious && unease === 0) {
            const tx = lure.x - hx;
            const ty = lure.y - hy;
            const d = Math.hypot(tx, ty) || 1;
            const range = 0.45 * Math.min(W, H);
            if (d < range) {
                // Unlike the cursor, the lure is far away and short-lived, so its pull doesn't fade to nothing at the rim.
                const w = k.curiosity * (0.5 + 0.5 * (1 - d / range)) * 3.2;
                const near = clamp(d / (L * 0.9), 0, 1);
                dx += ((tx / d) * near - (ty / d) * (1 - near)) * w;
                dy += ((ty / d) * near + (tx / d) * (1 - near)) * w;
                curious = true;
                lured = true;
            }
        }

        for (const other of this.koi) {
            if (other === k) continue;
            const ohx = other.nodes[0];
            const ohy = other.nodes[1];
            if (Math.abs(ohx - hx) > L * 2 || Math.abs(ohy - hy) > L * 2) continue;
            for (let n = 0; n < KOI_NODES; n += 3) {
                const ox = hx - other.nodes[n * 2];
                const oy = hy - other.nodes[n * 2 + 1];
                const d = Math.hypot(ox, oy);
                // Koi going for food jostle in close, so personal space shrinks and never outweighs the pull.
                const range = (L + other.length) * (food ? 0.12 : 0.28);
                if (d < range && d > 1e-3) {
                    const w = (1 - d / range) * 2.4;
                    dx += (ox / d) * w;
                    dy += (oy / d) * w;
                }
            }
            // Loose shoaling: nearby koi drift the same way.
            if (!chasing && Math.hypot(ohx - hx, ohy - hy) < L * 1.6) {
                dx += Math.cos(other.heading) * 0.18;
                dy += Math.sin(other.heading) * 0.18;
            }
        }

        // Drift around page content rather than under it; food and the cursor can still lure them across.
        repel(this.avoid, hx, hy, L * 0.4, push);
        dx += push.x * (chasing || curious ? 0.5 : 1.8);
        dy += push.y * (chasing || curious ? 0.5 : 1.8);

        // Let the body slip off-screen now and then, but always turn back.
        const over = Math.max(-hx, hx - W, -hy, hy - H);
        if (over > -L * 0.25) {
            const w = clamp((over + L * 0.25) / (L * 0.5), 0, 1) * 3.5;
            const toX = W / 2 - hx;
            const toY = H / 2 - hy;
            const d = Math.hypot(toX, toY) || 1;
            dx += (toX / d) * w;
            dy += (toY / d) * w;
        }

        const desired = Math.atan2(dy, dx);
        // Long bodies can't pivot on the spot: the turning circle grows with length.
        const agility =
            (1 + k.rush * 0.6) *
            Math.min(fleeing ? 3 : chasing ? 1.9 + closing : curious ? 1.2 : 0.7, (k.speed / L) * 4);
        const maxTurn = agility * dt;
        const turned = clamp(angleDiff(k.heading, desired), -maxTurn, maxTurn);
        k.heading += turned;
        k.turn += (turned / dt - k.turn) * Math.min(1, dt * 3);

        // Burst and coast: a few strong tail beats, then a long glide that bleeds off speed.
        // Chasing or fleeing koi beat without pause.
        if (time > k.nextBurst && time > k.burstUntil) {
            k.burstUntil = time + rand(0.7, 1.6);
            k.nextBurst = k.burstUntil + rand(1.2, 4);
        }
        const bursting = fleeing || chasing || lured || time < k.burstUntil || k.leap !== null;
        k.beat += ((bursting ? 1 : 0) - k.beat) * Math.min(1, dt * 3);
        // Tail beats near the surface push small rings out behind the koi; gliding or deep koi leave none.
        if (k.beat > 0.6 && k.depth > 0.65 && time > k.nextWake) {
            const tail = (KOI_NODES - 3) * 2;
            this.ripples.push({ x: nodes[tail], y: nodes[tail + 1], born: time, strength: 0.25 + 0.2 * k.depth });
            k.nextWake = time + rand(0.8, 1.6) / k.beat;
        }
        k.rush = Math.max(0, k.rush - dt * 0.7);
        const cruise = 12 + L * 0.05;
        // Unrest only slows the unhurried swimming; fleeing and food keep their full speed.
        const calm = cruise * (1 - 0.35 * unease);
        const target =
            (1 + k.rush * 0.8) *
            (fleeing
                ? cruise * 3.2
                : chasing
                  ? cruise * (1.9 + closing)
                  : bursting
                    ? calm * (lured ? 2.4 : curious ? 1.6 : 1.35)
                    : calm * 0.45);
        k.speed += (target - k.speed) * Math.min(1, dt * (bursting ? 1.6 + k.rush * 3 : 0.35));
        k.phase += dt * (0.6 + k.beat * (2.2 + k.speed / 11));
        k.finPhase += dt * 2.4;
        k.gulp += ((chasing && closing > 0.55 ? 1 : 0) - k.gulp) * Math.min(1, dt * 6);

        // Koi drift between the deep and the surface, and rise for food.
        if (time > k.nextDive) {
            k.depthTarget = rand(0.5, k.depthMax);
            k.nextDive = time + rand(8, 20);
        }
        const depthTarget = unease > 0 ? Math.min(k.depthTarget, lerp(k.depthMax, 0.55, unease)) : k.depthTarget;
        k.depth += ((chasing ? 1 : depthTarget) - k.depth) * Math.min(1, dt * (chasing ? 0.8 : 0.15));

        nodes[0] += Math.cos(k.heading) * k.speed * dt;
        nodes[1] += Math.sin(k.heading) * k.speed * dt;

        const seg = L / (KOI_NODES - 1);
        const maxBend = 0.16;
        let prevAngle = k.heading + Math.PI;
        for (let n = 1; n < KOI_NODES; n++) {
            const px = nodes[(n - 1) * 2];
            const py = nodes[(n - 1) * 2 + 1];
            let angle = Math.atan2(nodes[n * 2 + 1] - py, nodes[n * 2] - px);
            angle = prevAngle + clamp(angleDiff(prevAngle, angle), -maxBend, maxBend);
            nodes[n * 2] = px + Math.cos(angle) * seg;
            nodes[n * 2 + 1] = py + Math.sin(angle) * seg;
            prevAngle = angle;
        }

        const mouthR = L * 0.08 + 6;
        const before = this.pellets.length;
        this.pellets = this.pellets.filter(
            (p) => !p.landed || (p.x - nodes[0]) ** 2 + (p.y - nodes[1]) ** 2 > mouthR * mouthR
        );
        if (this.pellets.length < before) {
            this.ripples.push({ x: nodes[0], y: nodes[1], born: time, strength: 0.6 });
            this.bites.push({ x: nodes[0], y: nodes[1], born: time });
            k.nextSurface = time + rand(6, 16);
        } else if (time > k.nextSurface) {
            this.ripples.push({ x: nodes[0], y: nodes[1], born: time, strength: 0.3 });
            k.nextSurface = time + rand(8, 20);
        }
    }

    /** Keep the current target while it lasts; only switch for a pellet less than half as far away. */
    private pickFood(k: Koi, x: number, y: number, range: number) {
        if (k.food && !this.pellets.includes(k.food)) k.food = null;
        const nearest = this.nearestPellet(x, y, range);
        if (!k.food) return (k.food = nearest);
        const current = Math.hypot(k.food.x - x, k.food.y - y);
        if (current > range * 1.3) k.food = nearest;
        else if (nearest && Math.hypot(nearest.x - x, nearest.y - y) < current * 0.5) k.food = nearest;
        return k.food;
    }

    private nearestPellet(x: number, y: number, range: number) {
        let best: Pellet | null = null;
        let bestD = range * range;
        for (const p of this.pellets) {
            if (!p.landed) continue;
            const d = (p.x - x) ** 2 + (p.y - y) ** 2;
            if (d < bestD) {
                bestD = d;
                best = p;
            }
        }
        return best;
    }
}

/** Progress of the splash front, 0 at the drop to 1 once it has crossed the pond. */
export function waveProgress(w: Wave, time: number) {
    return clamp((time - w.born) / w.duration, 0, 1);
}

/** Radius of the splash front: fast at first, easing out (power 1.7) to `maxR`. */
export function waveRadius(w: Wave, time: number) {
    const p = waveProgress(w, time);
    return w.maxR * (1 - (1 - p) ** 1.7);
}

/** How high above the water a leaping koi is, 0 to 1 and back, for `age` seconds into the leap. */
export function leapHeight(age: number) {
    return Math.sin(Math.PI * clamp(age / LEAP_DURATION, 0, 1));
}

export function rippleLife(r: Ripple) {
    return 2.2 + r.strength * 1.6;
}
