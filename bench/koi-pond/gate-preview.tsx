/* Preview page for the koi pond's connection moods and art options. Built by build-gate-preview.mjs. */
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import KoiPond, { type PondMood } from "../../src/app/components/koi-pond/koi-pond";

const MOODS: { id: PondMood; label: string; text: string; led: string }[] = [
    { id: "checking", label: "检查中", text: "正在检查连接", led: "#8a8794" },
    { id: "connected", label: "已连接", text: "已连接", led: "#d97757" },
    { id: "disconnected", label: "断开", text: "连接已断开", led: "#7a2a2a" },
    { id: "unregistered", label: "未登记", text: "未登记", led: "#8a8794" },
    { id: "absent", label: "无服务", text: "未发现本机服务", led: "#8a8794" },
];

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

const onOff = [
    { value: false, label: "关" },
    { value: true, label: "开" },
];

function App() {
    const [mood, setMood] = useState<PondMood>("absent");
    const [cell, setCell] = useState(8);
    const [style, setStyle] = useState<"tile" | "ink">("tile");
    const [halo, setHalo] = useState(true);
    const [edge, setEdge] = useState(false);
    const [wake, setWake] = useState(1);
    const art = useMemo(() => ({ cell, style, halo, edge, wake }), [cell, style, halo, edge, wake]);

    const samples = useRef<number[]>([]);
    const [ms, setMs] = useState({ median: 0, p95: 0 });
    useEffect(() => {
        const id = setInterval(() => {
            const xs = [...samples.current].sort((a, b) => a - b);
            if (xs.length) setMs({ median: xs[Math.floor(xs.length * 0.5)], p95: xs[Math.floor(xs.length * 0.95)] });
        }, 500);
        return () => clearInterval(id);
    }, []);

    const current = MOODS.find((m) => m.id === mood)!;
    return (
        <>
            <KoiPond
                isLight={false}
                className="pond"
                mood={mood}
                art={art}
                onRenderMs={(t) => {
                    const xs = samples.current;
                    xs.push(t);
                    if (xs.length > 120) xs.shift();
                }}
            />
            <div className="panel" data-koi-avoid>
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
                    label="格子"
                    value={cell}
                    onChange={setCell}
                    options={[8, 7, 6].map((v) => ({ value: v, label: String(v) }))}
                />
                <Segmented
                    label="风格"
                    value={style}
                    onChange={setStyle}
                    options={[
                        { value: "tile", label: "tile" },
                        { value: "ink", label: "ink" },
                    ]}
                />
                <Segmented label="halo" value={halo} onChange={setHalo} options={onOff} />
                <Segmented label="edge" value={edge} onChange={setEdge} options={onOff} />
                <Segmented
                    label="尾流"
                    value={wake}
                    onChange={setWake}
                    options={[1, 1.6, 2.2].map((v) => ({ value: v, label: String(v) }))}
                />
            </div>
            <div className="perf" data-testid="perf">
                render 中位 {ms.median.toFixed(2)} ms / p95 {ms.p95.toFixed(2)} ms
            </div>
        </>
    );
}

createRoot(document.getElementById("root")!).render(<App />);
