import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';

function copyManifestPlugin(): Plugin {
  return {
    name: 'copy-manifest-plugin',
    writeBundle() {
      const manifestPath = resolve(__dirname, 'manifest.json');
      const distManifestPath = resolve(__dirname, 'dist/manifest.json');

      const rawManifest = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(rawManifest);

      // Convert .ts references to compiled .js files in dist
      if (manifest.background?.service_worker) {
        manifest.background.service_worker = manifest.background.service_worker.replace(/\.ts$/, '.js');
      }

      if (Array.isArray(manifest.content_scripts)) {
        manifest.content_scripts = manifest.content_scripts.map((cs: { matches: string[]; js: string[] }) => ({
          ...cs,
          js: cs.js ? cs.js.map((script: string) => script.replace(/\.ts$/, '.js')) : [],
        }));
      }

      writeFileSync(distManifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}

export default defineConfig({
  plugins: [react(), copyManifestPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        inspector: resolve(__dirname, 'src/inspector/index.html'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        background: resolve(__dirname, 'src/background/service-worker.ts'),
        content: resolve(__dirname, 'src/content/meet-detector.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'src/background/service-worker.js';
          }
          if (chunkInfo.name === 'content') {
            return 'src/content/meet-detector.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
