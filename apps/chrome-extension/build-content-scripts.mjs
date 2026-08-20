// Builds the manifest-declared content scripts (meet-detector, recording-widget)
// as self-contained IIFE bundles with no top-level import/export statements.
//
// Why this is separate from vite.config.ts: Manifest V3 content_scripts entries
// have no "type": "module" support (unlike background.service_worker), so Chrome
// always injects them as classic scripts. Rollup's iife/umd output formats don't
// support code-splitting across multiple entry points, so each content script
// needs its own single-entry build with every dependency inlined.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const targets = [
  {
    name: 'meet-detector',
    entry: resolve(__dirname, 'src/content/meet-detector.ts'),
    outFile: 'meet-detector.js',
    plugins: [],
  },
  {
    name: 'recording-widget',
    entry: resolve(__dirname, 'src/content/recording-widget.tsx'),
    outFile: 'recording-widget.js',
    plugins: [react()],
  },
];

for (const target of targets) {
  await build({
    configFile: false,
    plugins: target.plugins,
    // configFile: false skips Vite's normal config resolution, which is what
    // otherwise replaces `process.env.NODE_ENV` (React checks this internally)
    // with a literal at build time. Without this, the bundled React code keeps
    // the raw reference, which throws ReferenceError: process is not defined
    // once Chrome runs it as a classic content script (no Node `process` global).
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    build: {
      outDir: 'dist/src/content',
      emptyOutDir: false,
      minify: true,
      lib: {
        entry: target.entry,
        name: target.name.replace(/-/g, '_'),
        formats: ['iife'],
        fileName: () => target.outFile,
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });
}
