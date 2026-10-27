#!/usr/bin/env node
// Bundles gate-preview.tsx into one self-contained HTML file: bench/koi-pond/out/gate-preview.html
//   node bench/koi-pond/build-gate-preview.mjs
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });

// React must be bundled exactly once, or hooks fail with "Cannot read properties of null (reading 'useRef')".
const oneReact = {
    name: "one-react",
    setup(b) {
        b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({
            path: createRequire(join(root, "package.json")).resolve(args.path),
        }));
    },
};
const result = await build({
    entryPoints: [join(here, "gate-preview.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    plugins: [oneReact],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const css = `
html,body{margin:0;height:100%;background:#1a1921;color:#e8e4dc;overflow:hidden;
  font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#root{position:fixed;inset:0}
.bench{position:absolute;inset:0;background:#26333d;display:flex;align-items:center;justify-content:center;
  color:rgba(232,228,220,.55);font-size:14px;letter-spacing:.2em}
.pond{position:absolute;inset:0;width:100%;height:100%;display:block}
.panel{position:absolute;left:50%;top:22%;transform:translateX(-50%);width:360px;box-sizing:border-box;
  padding:16px;border-radius:12px;background:rgba(32,31,40,.82);border:1px solid rgba(255,255,255,.1);
  box-shadow:0 12px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:10px}
.status{display:flex;align-items:center;gap:10px;font-size:15px;margin-bottom:4px}
.led{width:10px;height:10px;border-radius:50%;transition:background .3s,box-shadow .3s;box-shadow:0 0 8px currentColor}
.row{display:flex;align-items:center;gap:10px}
.rowlabel{width:44px;color:rgba(232,228,220,.6);flex:none}
.seg{display:flex;flex:1;border:1px solid rgba(255,255,255,.14);border-radius:8px;overflow:hidden}
.seg button{flex:1;padding:5px 0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;
  border-right:1px solid rgba(255,255,255,.1)}
.seg button:last-child{border-right:0}
.seg button.on{background:rgba(255,255,255,.16)}
.actions{gap:10px;margin-top:2px}
.btn{flex:1;padding:7px 0;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(255,255,255,.06);
  color:inherit;font:inherit;cursor:pointer}
.btn:hover{background:rgba(255,255,255,.14)}
.btn.primary{background:rgba(217,119,87,.28);border-color:rgba(217,119,87,.6)}
.restart{position:absolute;left:50%;top:calc(50% + 40px);transform:translateX(-50%);flex:none;padding:7px 22px}
.panel{transition:opacity .35s}
.panel.gone{opacity:0;pointer-events:none}
.perf{position:absolute;left:12px;bottom:10px;font-size:11px;color:rgba(232,228,220,.55)}
`;
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Koi pond gate preview</title><style>${css}</style></head>
<body><div id="root"></div><script>${js}</script></body></html>`;
const file = join(outDir, "gate-preview.html");
writeFileSync(file, html);
console.log(`wrote ${file} (${(html.length / 1024).toFixed(0)} KB)`);
