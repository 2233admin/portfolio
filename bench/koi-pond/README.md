# koi-pond renderer benchmark

Measures `KoiRenderer.render()` in a real (headless) Chromium and compares the pre-change renderer against the
current one in both glyph modes.

## Run

```bash
npm ci
npm i --no-save playwright esbuild      # not added to package.json on purpose
npx playwright install chromium
node bench/koi-pond/run.mjs             # --rounds 3 --frames 300 by default
```

Options: `--rounds N`, `--frames N`, `--only baseline,text,atlas`, `--no-compare`, `--headed`, `--gpu`.
Output goes to `bench/koi-pond/out/` (git-ignored): `results.json` plus one PNG per variant, frame and dpr.
`--headed --gpu` is the one to run on a real machine: the numbers below come from software-rasterised headless
Chromium, where canvas 2D never touches a GPU (the `--gpu` flag is untested here, no GPU available).

## What it does

- `entry.ts` is bundled by esbuild and driven from the page. `Math.random` is replaced by a seeded PRNG (mulberry32)
  only inside the benchmark; each scene owns its generator, so two scenes stepped in turn stay identical.
- Scene: 1920x1080, one `World`, a content box in the middle (exercises dimming), the pointer active, 300 steps
  (5 s) so the school spreads out, food thrown at steps 60 and 180, and again during the measured run.
- Each variant renders 30 warm-up plus 300 timed frames per dpr (1 and 2), the world advancing one 1/60 s step per
  frame. Each frame is timed including a 1x1 `getImageData`, because canvas commands are deferred and would
  otherwise not be charged to `render()`. "JS-side" in the table is the time before that readback.
- Variants: `baseline` is a copy of the original renderer (`baseline/renderer.baseline.ts`, imports rewritten to point at
  the live `world.ts` and `shape.ts`); `text` and `atlas` are the current renderer's two `GlyphMode`s.
- Image comparison: identical worlds rendered by baseline and each variant, frames 60 and 250, dark and light, dpr 1
  and 2, composited over the page background; mean and max absolute difference over RGB. A lifecycle check repeats the
  comparison after `setTheme`, `resize` and dpr changes.

## Results (headless Chromium 156, software raster, 5 rounds, median of per-round medians)

| variant             | dpr | median ms | p95 ms | JS-side median ms |
| ------------------- | --- | --------- | ------ | ----------------- |
| baseline (original) | 1   | 8.70      | 10.60  | 6.60              |
| text (default)      | 1   | 8.70      | 12.80  | 6.60              |
| atlas               | 1   | 13.90     | 17.80  | 7.80              |
| baseline (original) | 2   | 10.10     | 12.00  | 6.60              |
| text (default)      | 2   | 10.10     | 12.30  | 6.60              |
| atlas               | 2   | 17.40     | 23.30  | 8.00              |

Pixel difference against baseline (frames 60 and 250, dark and light, dpr 1 and 2):

- `text`: mean 0, max 0. Byte-identical PNGs.
- `atlas`: mean 0.006 to 0.012, max 6 (of 255), no pixel off by more than 8. That is the 5-bit colour quantisation
  only; glyph positions and shapes match.

`screenshots/` holds frame 250, dark, dpr 1 for baseline (`text` is byte-identical to it) and `atlas`.
`results.json` has the full numbers from the run above.

## Where the frame time goes

A profile of the same scene (software raster, dpr 1): `rasterizeKoi` about 3.4 ms, all cell drawing about 1.5 to
3 ms of which fewer than 1100 `fillText` and 850 `fillRect` calls per frame, the rest simulation-independent
bookkeeping and the raster flush. The glyph path is a minor part of the frame in this scene, and in software
Chromium `drawImage` of a sprite costs about three times a `fillText` (Skia already caches glyph masks), which is why
the atlas loses here.
