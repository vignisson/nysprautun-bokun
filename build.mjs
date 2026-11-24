// Býr til src/assets.js úr public/ og pakkar worker í dist/worker.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const r = (f) => readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');
writeFileSync(new URL('./src/assets.js', import.meta.url),
  `// SJÁLFVIRKT BÚIÐ TIL AF build.mjs — ekki breyta\n` +
  `export const appHtml = ${JSON.stringify(r('app.html'))};\n` +
  `export const appJs = ${JSON.stringify(r('app.js'))};\n` +
  `export const appCss = ${JSON.stringify(r('app.css'))};\n` +
  `export const bokaHtml = ${JSON.stringify(r('boka.html'))};\n`);

mkdirSync(new URL('./dist', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/worker.js',
  minify: false,
  legalComments: 'none',
});
console.log('dist/worker.js tilbúið');
