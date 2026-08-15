import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Build produces a single self-contained `dist/index.html`:
 * every JS chunk, CSS file and worker is inlined, so the artifact can be
 * dropped on any static host (GitHub Pages) or opened over `file://`.
 */
export default defineConfig({
  base: './',
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // Inline every asset regardless of size; nothing may be emitted next to
    // index.html or the single-file guarantee breaks.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 20000,
  },
});
