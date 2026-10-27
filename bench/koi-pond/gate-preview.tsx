/* Preview page for the koi pond's connection moods, leaps and the splash into the workbench. Built by build-gate-preview.mjs. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import KoiPond, { type KoiPondHandle, type PondMood } from "../../src/app/components/koi-pond/koi-pond";

const MOODS: { id: PondMood; label: string; text: string; led: string }[] = [
    { id: "checking", label: "检查中", text: "正在检查连接", led: "#8a8794" },
    { id: "connected", label: "已连接", text: "已连接", led: "#d97757" },
    { id: "disconnected", label: "断开", text: "连接已断开", led: "#7a2a2a" },
    { id: "unregistered", label: "未登记", text: "未登记", led: "#8a8794" },
    { id: "absent", label: "无服务", text: "未发现本机服务", led: "#8a8794" },
];

// Cell size 8 and an opaque pond, so the splash has something to uncover.
const ART = { cell: 8, backdrop: true };

declare global {
    interface Window {
        /** Frames rendered so far, and how long the last splash took (ms), for verify-gate.mjs. */
        __renders: number;
        __splashMs: number;
    }
}
window.__renders = 0;

function Segmented<T extends string | number | boolean>(props: {
    label: string;
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <div className="row">
            <span className="rowlabel">{props.label}</span>
            <div className="seg" role="group" aria-label={props.label}>
                {props.options.map((o) => (
                    <button
                        key={String(o.value)}
                        type="button"
                        className={o.value === props.value ? "on" : ""}
                        aria-pressed={o.value === props.value}
                        onClick={() => props.onChange(o.value)}
                    >
                        {o.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

type Phase = "idle" | "splashing" | "done";

function App() {
    const [mood, setMood] = useState<PondMood>("absent");
    const [leaps, setLeaps] = useState(true);
    const [phase, setPhase] = useState<Phase>("idle");
    // A new key mounts a fresh pond, which is how "重新开始" brings it back after a splash has released the old one.
    const [run, setRun] = useState(0);
    const pond = useRef<KoiPondHandle>(null);
    const phaseRef = useRef(phase);
    phaseRef.current = phase;

    const samples = useRef<number[]>([]);
    const [ms, setMs] = useState({ median: 0, p95: 0 });
    useEffect(() => {
        const id = setInterval(() => {
            const xs = [...samples.current].sort((a, b) => a - b);
            if (xs.length) setMs({ median: xs[Math.floor(xs.length * 0.5)], p95: xs[Math.floor(xs.length * 0.95)] });
        }, 500);
        return () => clearInterval(id);
    }, []);

    const enter = () => {
        if (phaseRef.current !== "idle") return;
        setPhase("splashing");
        const t0 = performance.now();
        void pond.current?.splash().then(() => {
            window.__splashMs = performance.now() - t0;
            setPhase("done");
        });
    };
    const enterRef = useRef(enter);
    enterRef.current = enter;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Enter" || (e.target instanceof Element && e.target.closest("button"))) return;
            enterRef.current();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const current = MOODS.find((m) => m.id === mood)!;
    return (
        <>
            <div className="bench" data-testid="bench">
                工作台
            </div>
            <KoiPond
                key={run}
                ref={pond}
                isLight={false}
                className="pond"
                mood={mood}
                art={ART}
                leaps={leaps}
                onRenderMs={(t) => {
                    window.__renders++;
                    const xs = samples.current;
                    xs.push(t);
                    if (xs.length > 120) xs.shift();
                }}
            />
            <div className={`panel${phase === "idle" ? "" : " gone"}`} data-koi-avoid data-testid="panel">
                <div className="status">
                    <span className="led" style={{ background: current.led }} data-testid="led" />
                    <span data-testid="status-text">{current.text}</span>
                </div>
                <Segmented
                    label="状态"
                    value={mood}
                    onChange={setMood}
                    options={MOODS.map((m) => ({ value: m.id, label: m.label }))}
                />
                <Segmented
                    label="自动跃"
                    value={leaps}
                    onChange={setLeaps}
                    options={[
                        { value: false, label: "关" },
                        { value: true, label: "开" },
                    ]}
                />
                <div className="row actions">
                    <button type="button" className="btn" onClick={() => pond.current?.leap()}>
                        跳一条
                    </button>
                    <button type="button" className="btn" onClick={() => pond.current?.spawnGolden()}>
                        放一条金鲤
                    </button>
                    <button type="button" className="btn primary" onClick={enter}>
                        进入 ⏎
                    </button>
                </div>
            </div>
            {phase === "done" && (
                <button
                    type="button"
                    className="btn restart"
                    onClick={() => {
                        setRun((n) => n + 1);
                        setPhase("idle");
                    }}
                >
                    重新开始
                </button>
            )}
            <div className="perf" data-testid="perf">
                render 中位 {ms.median.toFixed(2)} ms / p95 {ms.p95.toFixed(2)} ms
            </div>
        </>
    );
}

createRoot(document.getElementById("root")!).render(<App />);
