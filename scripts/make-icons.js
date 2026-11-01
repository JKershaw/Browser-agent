#!/usr/bin/env node
/**
 * Render the app icons into `public/icons/`.
 *
 * `node scripts/make-icons.js` — run it after changing the artwork below; the
 * PNGs it writes are committed, so neither the build nor CI needs a browser
 * to produce them.
 *
 * Two shapes, because launchers treat them differently:
 * - **any**: a rounded square with transparent corners, used as-is by desktop
 *   install surfaces (Windows taskbar, the Chrome app list) and the favicon.
 * - **maskable**: full-bleed background with the glyph inside the central 80%
 *   safe zone, so Android can crop it to a circle, squircle or teardrop
 *   without cutting into the artwork.
 *
 * Colours match `--accent` in the light theme of `src/ui/styles.css`.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const ACCENT = '#2563eb';

/**
 * A speech bubble with a prompt chevron in it: a chat that does things.
 * Drawn on a 100×100 grid; `scale` shrinks it about the centre.
 */
function glyph(scale) {
  return `
    <g transform="translate(50 50) scale(${scale}) translate(-50 -50)">
      <path fill="#ffffff" d="M22 20h56a10 10 0 0 1 10 10v32a10 10 0 0 1-10 10H46l-16 13v-13h-8a10 10 0 0 1-10-10V30a10 10 0 0 1 10-10z"/>
      <path fill="none" stroke="${ACCENT}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" d="M34 36l10 10-10 10"/>
      <path fill="none" stroke="${ACCENT}" stroke-width="7" stroke-linecap="round" d="M52 56h16"/>
    </g>`;
}

const SHAPES = {
  any: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="22" fill="${ACCENT}"/>${glyph(0.92)}</svg>`,
  maskable: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" fill="${ACCENT}"/>${glyph(0.72)}</svg>`,
};

const TARGETS = [
  { file: 'icon-192.png', shape: 'any', size: 192 },
  { file: 'icon-512.png', shape: 'any', size: 512 },
  { file: 'icon-maskable-512.png', shape: 'maskable', size: 512 },
  { file: 'apple-touch-icon.png', shape: 'maskable', size: 180 },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
try {
  for (const { file, shape, size } of TARGETS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${SHAPES[shape]}`
    );
    await page.screenshot({ path: join(OUT, file), omitBackground: true });
    await page.close();
    console.log(`wrote public/icons/${file}`);
  }
} finally {
  await browser.close();
}
