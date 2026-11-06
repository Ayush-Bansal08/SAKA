/**
 * Builds the SAKA marks from plain geometry: no font, no tracing, no raster.
 *
 *   node docs/ui-revamp/brand/generate-logo.mjs
 *
 * Coordinates: x-height 100, baseline y = 100, so the top of the x-height is y = 0.
 * Solid shapes wind clockwise and holes counter-clockwise, so overlaps merge cleanly.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, 'apps/web/public/brand');

const W = 30; // stem weight
const n = (v) => Number(v.toFixed(2));

const circle = (cx, cy, r, ccw = false) => {
  const s = ccw ? 0 : 1;
  return `M${n(cx - r)} ${n(cy)}A${r} ${r} 0 1 ${s} ${n(cx + r)} ${n(cy)}A${r} ${r} 0 1 ${s} ${n(cx - r)} ${n(cy)}Z`;
};

/** A straight stroke with round ends, as exact arcs. */
const capsule = (x1, y1, x2, y2, w) => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const dx = (Math.sin(a) * w) / 2;
  const dy = (-Math.cos(a) * w) / 2;
  const r = w / 2;
  return (
    `M${n(x1 + dx)} ${n(y1 + dy)}L${n(x2 + dx)} ${n(y2 + dy)}` +
    `A${r} ${r} 0 0 1 ${n(x2 - dx)} ${n(y2 - dy)}L${n(x1 - dx)} ${n(y1 - dy)}` +
    `A${r} ${r} 0 0 1 ${n(x1 + dx)} ${n(y1 + dy)}Z`
  );
};

/** Single-storey a: a ring and a round-ended stem. */
const glyphA = (x) =>
  circle(x + 50, 50, 50) + circle(x + 50, 50, 20, true) + capsule(x + 85, 15, x + 85, 85, W);

/** Outline of a stroked centreline, smoothed with Catmull-Rom cubics. */
function outline(points, w) {
  const left = [];
  const right = [];
  points.forEach((p, i) => {
    const a = points[Math.max(i - 1, 0)];
    const b = points[Math.min(i + 1, points.length - 1)];
    const t = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const ox = (Math.sin(t) * w) / 2;
    const oy = (-Math.cos(t) * w) / 2;
    left.push([p[0] + ox, p[1] + oy]);
    right.push([p[0] - ox, p[1] - oy]);
  });
  const smooth = (pts) => {
    let d = '';
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      d += `C${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)} ${n(p2[0] - (p3[0] - p1[0]) / 6)} ${n(p2[1] - (p3[1] - p1[1]) / 6)} ${n(p2[0])} ${n(p2[1])}`;
    }
    return d;
  };
  const r = w / 2;
  const back = [...right].reverse();
  return (
    `M${n(left[0][0])} ${n(left[0][1])}${smooth(left)}` +
    `A${r} ${r} 0 0 1 ${n(back[0][0])} ${n(back[0][1])}${smooth(back)}` +
    `A${r} ${r} 0 0 1 ${n(left[0][0])} ${n(left[0][1])}Z`
  );
}

/** s: two elliptical lobes that meet on a level spine. */
function glyphS(x, { w = 25, width = 80 } = {}) {
  const rx = (width - w) / 2;
  const ry = (100 - w) / 4;
  const cx = x + width / 2;
  const top = w / 2 + ry;
  const bot = 100 - w / 2 - ry;
  const pts = [];
  const step = 15;
  for (let t = -28; t >= -270; t -= step) {
    const r = (t * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(r), top + ry * Math.sin(r)]);
  }
  for (let t = -90 + step; t <= 152; t += step) {
    const r = (t * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(r), bot + ry * Math.sin(r)]);
  }
  return outline(pts, w);
}

/** k: tall stem, a leg, and an arm that keeps climbing past the x-height. */
const ARM_TIP = [76, -6];
const glyphK = (x) =>
  capsule(x + 15, -30, x + 15, 85, W) +
  capsule(x + 26, 63, x + ARM_TIP[0], ARM_TIP[1], 28) +
  capsule(x + 40, 48, x + 74, 86, 28);

/** Four-point sparkle with concave sides. `pinch` is how far the sides pull in. */
function sparkle(cx, cy, r, pinch = 0.14, ccw = false) {
  const k = r * pinch;
  const tips = [
    [cx, cy - r],
    [cx + r, cy],
    [cx, cy + r],
    [cx - r, cy],
  ];
  const ctrl = [
    [cx + k, cy - k],
    [cx + k, cy + k],
    [cx - k, cy + k],
    [cx - k, cy - k],
  ];
  const order = ccw ? [0, 3, 2, 1] : [0, 1, 2, 3];
  const ctrlOrder = ccw ? [3, 2, 1, 0] : [0, 1, 2, 3];
  let d = `M${n(tips[0][0])} ${n(tips[0][1])}`;
  for (let i = 0; i < 4; i += 1) {
    const p = tips[order[(i + 1) % 4]];
    const c = ctrl[ctrlOrder[i]];
    d += `Q${n(c[0])} ${n(c[1])} ${n(p[0])} ${n(p[1])}`;
  }
  return `${d}Z`;
}

/** Scales absolute path data, including arc radii. */
function scalePath(d, s, tx, ty) {
  return d.replace(/([MLCQAZ])([^MLCQAZ]*)/g, (_, c, args) => {
    const v = args
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (c === 'Z') return 'Z';
    if (c === 'A')
      return `A${n(v[0] * s)} ${n(v[1] * s)} ${v[2]} ${v[3]} ${v[4]} ${n(v[5] * s + tx)} ${n(v[6] * s + ty)}`;
    return c + v.map((x, i) => n(x * s + (i % 2 ? ty : tx))).join(' ');
  });
}

const svg = (viewBox, d, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}"><title>${title}</title><path fill="currentColor" d="${d}"/></svg>\n`;

// --- Wordmark ---------------------------------------------------------------------------------
const X_A1 = 88;
const X_K = 200;
const X_A2 = 296;
const wordmark =
  glyphS(0) + glyphA(X_A1) + glyphK(X_K) + glyphA(X_A2) + sparkle(X_K + 104, -36, 27);
const WORD_BOX = '-2 -66 400 170';

// --- Symbols (64 grid) ------------------------------------------------------------------------
// A lens, not a stroke: thickest under the spark, tapering to points like the Home horizon.
const horizon = 'M2 54Q32 32 62 54Q32 44 2 54Z';
const option1 = sparkle(32, 22, 21) + horizon;
const option2 = scalePath(glyphS(0, { w: 26, width: 82 }), 0.52, 6, 12) + sparkle(51, 13, 11);
const option3 = sparkle(32, 32, 29, 0.16) + sparkle(32, 32, 8, 0.22, true);

mkdirSync(OUT, { recursive: true });
const write = (name, body) => writeFileSync(resolve(OUT, name), body);
write('saka-wordmark.svg', svg(WORD_BOX, wordmark, 'saka'));
write('saka-symbol-option-1.svg', svg('0 0 64 64', option1, 'SAKA symbol, spark on horizon'));
write('saka-symbol-option-2.svg', svg('0 0 64 64', option2, 'SAKA symbol, monogram'));
write('saka-symbol-option-3.svg', svg('0 0 64 64', option3, 'SAKA symbol, spark'));

// --- Dev-only preview -------------------------------------------------------------------------
const inline = (viewBox, d, style) =>
  `<svg viewBox="${viewBox}" style="${style}" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;

const symbols = [
  ['1', 'Spark on horizon', option1],
  ['2', 'Monogram', option2],
  ['3', 'Spark only', option3],
];

const sizes = (d) =>
  [16, 32, 48, 64, 128]
    .map(
      (s) =>
        `<figure>${inline('0 0 64 64', d, `width:${s}px;height:${s}px`)}<figcaption>${s}</figcaption></figure>`,
    )
    .join('');

const panel = (cls, label) => `
  <section class="${cls}">
    <p class="label">[ ${label} ]</p>
    ${inline(WORD_BOX, wordmark, 'width:min(420px,100%);height:auto')}
    <div class="row">
      ${symbols.map(([, , d]) => inline('0 0 64 64', d, 'width:88px;height:88px')).join('')}
      ${inline(WORD_BOX, wordmark, 'width:72px;height:auto')}
    </div>
  </section>`;

const preview = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SAKA brand preview</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #07080c; color: #f4f5f8; font: 15px/24px system-ui, sans-serif; }
  main { max-width: 1120px; margin: 0 auto; padding: 48px 16px; display: grid; gap: 24px; }
  h1 { font-size: 28px; letter-spacing: -0.02em; margin: 0; }
  p { margin: 0; color: #a3a8b8; }
  .label { font: 11px/16px ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; color: inherit; opacity: .7; margin-bottom: 24px; }
  section { border-radius: 16px; padding: 32px; border: 1px solid rgba(255,255,255,.08); overflow: hidden; }
  .dark { background: #0d0f15; color: #f4f5f8; }
  .light { background: #f7f7fa; color: #07080c; }
  .row { display: flex; flex-wrap: wrap; gap: 32px; align-items: center; margin-top: 32px; }
  figure { margin: 0; display: grid; justify-items: center; gap: 8px; align-content: end; }
  figcaption { font: 11px/16px ui-monospace, monospace; color: #858b9f; }
  .grid { display: grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .matrix { position: relative; isolation: isolate; background: #07080c; color: #f4f5f8; min-height: 360px; display: grid; place-items: center; }
  .matrix::before, .matrix::after { content: ''; position: absolute; inset: 0; z-index: -1; }
  .matrix::before { background:
    radial-gradient(60% 34% at 82% 16%, rgba(214,222,255,.5), transparent 70%),
    radial-gradient(52% 30% at 8% 80%, rgba(240,225,205,.42), transparent 70%),
    radial-gradient(40% 40% at 94% 62%, rgba(59,79,216,.34), transparent 70%);
    filter: blur(26px); }
  .matrix::after { background: #07080c; -webkit-mask: radial-gradient(circle, transparent 1.35px, #000 1.85px) 0 0 / 6px 6px; mask: radial-gradient(circle, transparent 1.35px, #000 1.85px) 0 0 / 6px 6px; }
</style>
</head>
<body>
<main>
  <header><h1>SAKA brand preview</h1><p>Dev-only. Pick a symbol: option 1, 2 or 3.</p></header>
  <div class="grid">${panel('dark', 'On dark')}${panel('light', 'On light')}</div>
  <section class="matrix">${inline(WORD_BOX, wordmark, 'width:min(380px,80%);height:auto')}</section>
  ${symbols
    .map(
      ([id, name, d]) => `<section class="dark">
    <p class="label">[ Option ${id} · ${name} ]</p>
    <div class="row" style="margin-top:0">${sizes(d)}</div>
  </section>`,
    )
    .join('')}
</main>
</body>
</html>
`;
writeFileSync(resolve(ROOT, 'docs/ui-revamp/brand-preview.html'), preview);
console.log('wrote', OUT);
