// Býr til src/assets.js úr public/ og pakkar worker í dist/worker.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build, transform } from 'esbuild';
const MIN = process.env.MINIFY === '1';

const r = (f) => readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');
const js = MIN ? (await transform(r('app.js'), { minify: true, format: 'esm' })).code : r('app.js');
const css = MIN ? (await transform(r('app.css'), { minify: true, loader: 'css' })).code : r('app.css');
writeFileSync(new URL('./src/assets.js', import.meta.url),
  `// SJÁLFVIRKT BÚIÐ TIL AF build.mjs — ekki breyta\n` +
  `export const appHtml = ${JSON.stringify(r('app.html'))};\n` +
  `export const appJs = ${JSON.stringify(js)};\n` +
  `export const appCss = ${JSON.stringify(css)};\n` +
  `export const bokaHtml = ${JSON.stringify(r('boka.html'))};\n`);

mkdirSync(new URL('./dist', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/worker.js',
  minify: MIN,
  legalComments: 'none',
});
console.log('dist/worker.js tilbúið');
