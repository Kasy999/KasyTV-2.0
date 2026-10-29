import { defineConfig } from 'vite';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';

/**
 * Writes dist/precache-manifest.js after the build: the list of every emitted file plus a content hash.
 * public/sw.js imports it, precaches the files and drops caches of older builds.
 */
function precacheManifest() {
  let outDir = 'dist';
  return {
    name: 'kasy-precache-manifest',
    apply: 'build',
    configResolved(cfg) {
      outDir = resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      const files = [];
      const hash = createHash('sha256');
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full);
            continue;
          }
          const rel = relative(outDir, full).split('\\').join('/');
          if (rel === 'sw.js' || rel === 'precache-manifest.js' || rel.endsWith('.map')) continue;
          // A locally bundled Lampa can be large – it is cached at runtime when it is used.
          if (rel.startsWith('lampa/') && rel !== 'lampa/index.html') continue;
          files.push('./' + rel);
          hash.update(rel + ':' + st.size + ':' + st.mtimeMs);
        }
      };
      walk(outDir);
      const version = hash.digest('hex').slice(0, 12);
      writeFileSync(
        join(outDir, 'precache-manifest.js'),
        `self.__KASY_PRECACHE = ${JSON.stringify({ version, files: ['./', ...files] }, null, 0)};\n`,
      );
      console.log(`[precache] ${files.length} Dateien, Version ${version}`);
    },
  };
}

export default defineConfig(async () => {
  const plugins = [precacheManifest()];
  // Older Smart-TV browsers (Tizen 4 / webOS 4 = Chromium 53–56) don't run ES modules: plugin-legacy adds a
  // SystemJS/ES5 build for them. Optional – if the package is missing the modern build is produced alone.
  try {
    const legacy = (await import('@vitejs/plugin-legacy')).default;
    plugins.push(legacy({ targets: ['chrome >= 53', 'safari >= 12', 'samsung >= 6'], modernPolyfills: false }));
  } catch {
    console.warn('[vite] @vitejs/plugin-legacy nicht installiert – nur moderner Build');
  }
  return {
    base: './',
    plugins,
    build: {
      target: ['es2019', 'safari13', 'chrome64'],
      cssTarget: ['safari13', 'chrome61'],
      assetsInlineLimit: 0,
      sourcemap: false,
      chunkSizeWarningLimit: 800,
    },
    server: { host: true, port: 5173 },
    preview: { host: true, port: 4173 },
  };
});
