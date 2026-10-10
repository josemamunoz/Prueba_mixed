#!/usr/bin/env node
// Genera una versión de un solo archivo que se abre con doble clic (file://), sin servidor:
//   dist/KeyMix Pro.html  → toda la app (CSS, JS y el analizador en un Web Worker desde un Blob)
//   dist/KeyMix Pro.bat   → lanzador de Windows: la abre en una ventana propia de Edge o Chrome
// Uso: node scripts/build-standalone.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Convierte un módulo ES en una función que devuelve sus exportaciones.
 * Soporta lo que usa este proyecto: `import { a, b } from './x.js'`, `export function`,
 * `export async function`, `export const` y `export { a, b }`.
 */
function wrapModule(name, src) {
  const exports = [];
  let code = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+)\.js';?\s*$/gm, (_, names, mod) => `const {${names}} = __mods[${JSON.stringify(mod)}];`);
  code = code.replace(/^export\s+(async\s+function|function|const|let|class)\s+([\w$]+)/gm, (_, kind, id) => {
    exports.push(id);
    return `${kind} ${id}`;
  });
  code = code.replace(/^export\s*\{([^}]*)\};?\s*$/gm, (_, names) => {
    exports.push(...names.split(',').map((s) => s.trim()).filter(Boolean));
    return '';
  });
  if (/^\s*(import|export)\b/m.test(code)) throw new Error(`Sintaxis de módulo no soportada en ${name}.js`);
  return `__mods[${JSON.stringify(name)}] = (() => {\n${code}\nreturn { ${[...new Set(exports)].join(', ')} };\n})();\n`;
}

const bundle = (names) => `(() => {\n'use strict';\nconst __mods = {};\n${names.map((n) => wrapModule(n, read(`js/${n}.js`))).join('\n')}\n})();\n`;

// Analizador (Web Worker clásico, creado desde un Blob: funciona en file://).
const workerSrc = bundle(['camelot', 'dsp', 'worker']);

// App: el worker se crea desde el código incrustado en lugar de desde ./worker.js.
let appSrc = bundle(['camelot', 'dsp', 'id3', 'aiff', 'setbuilder', 'synth', 'demo', 'rekordbox', 'app']);
const workerExpr = "new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })";
if (!appSrc.includes(workerExpr)) throw new Error('No se encontró la creación del worker en app.js');
appSrc = appSrc.replace(workerExpr, 'new Worker(KEYMIX_WORKER_URL)');
appSrc = `const KEYMIX_WORKER_URL = URL.createObjectURL(new Blob([${JSON.stringify(workerSrc)}], { type: 'text/javascript' }));\n${appSrc}`;
if (appSrc.includes('import.meta')) throw new Error('Queda import.meta en el paquete');

const safe = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1');
let html = read('index.html');
const css = read('css/styles.css');
html = html.replace(/<link rel="stylesheet" href="css\/styles\.css"\s*\/?>/, () => `<style>\n${safe(css)}\n</style>`);
html = html.replace(/<script type="module" src="js\/app\.js"><\/script>/, () => `<script>\n${safe(appSrc)}\n</script>`);
if (/src="js\/|href="css\//.test(html)) throw new Error('Quedan referencias a archivos externos en el HTML');

const bat = [
  '@echo off',
  'rem Abre KeyMix Pro en una ventana propia (sin barra de direcciones). No necesita servidor.',
  'setlocal',
  'set "APP=%~dp0KeyMix Pro.html"',
  'set "URL=file:///%APP:\\=/%"',
  'for %%B in (msedge.exe chrome.exe) do (',
  '  reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\%%B" >nul 2>&1 && (start "" %%~nB --app="%URL%" & exit /b)',
  '  reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\%%B" >nul 2>&1 && (start "" %%~nB --app="%URL%" & exit /b)',
  ')',
  'rem Sin Edge ni Chrome: se abre con el navegador predeterminado.',
  'start "" "%APP%"',
  '',
].join('\r\n');

mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist', 'KeyMix Pro.html'), html);
writeFileSync(join(ROOT, 'dist', 'KeyMix Pro.bat'), bat);
console.log(`dist/KeyMix Pro.html (${Math.round(html.length / 1024)} KB) y dist/KeyMix Pro.bat generados`);
