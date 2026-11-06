/**
 * Renders the PNG icons and the share image from the SVGs, with the Playwright the repo already has.
 *
 *   node docs/ui-revamp/brand/render-icons.cjs
 */
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '../../..');
const { chromium } = createRequire(resolve(ROOT, 'apps/web/package.json'))('@playwright/test');
const PUBLIC = resolve(ROOT, 'apps/web/public');

const favicon = readFileSync(resolve(PUBLIC, 'favicon.svg'), 'utf8');
const wordmark = readFileSync(resolve(PUBLIC, 'brand/saka-wordmark.svg'), 'utf8');

const ICONS = [
  ['favicon-16.png', 16],
  ['favicon-32.png', 32],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];

const OG = `<!doctype html><style>
  * { margin: 0 }
  body { width: 1200px; height: 630px; background: #07080c; color: #f4f5f8; position: relative;
    isolation: isolate; display: grid; place-items: center; overflow: hidden }
  body::before, body::after { content: ''; position: absolute; inset: 0; z-index: -1 }
  body::before { background:
    radial-gradient(60% 34% at 82% 16%, rgba(214,222,255,.62), transparent 70%),
    radial-gradient(52% 30% at 8% 80%, rgba(240,225,205,.5), transparent 70%),
    radial-gradient(40% 40% at 94% 62%, rgba(59,79,216,.42), transparent 70%);
    filter: blur(34px) }
  body::after { background: #07080c;
    -webkit-mask: radial-gradient(circle, transparent 1.6px, #000 2.2px) 0 0 / 8px 8px }
  svg { width: 540px; height: auto }
</style>${wordmark}`;

(async () => {
  const browser = await chromium.launch();
  for (const [name, size] of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<!doctype html><style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${favicon}`,
    );
    await page.screenshot({ path: resolve(PUBLIC, name), omitBackground: true });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(OG);
  await page.screenshot({ path: resolve(PUBLIC, 'og-image.png') });
  await browser.close();
  console.log('rendered', ICONS.length + 1, 'images');
})();
