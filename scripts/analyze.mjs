#!/usr/bin/env node
// Analiza archivos WAV o AIFF desde la terminal y muestra tonalidad, BPM, energía, cues y el
// diagnóstico del tempo. Uso:
//   node scripts/analyze.mjs "F:\Música\tema.aiff" [otro.wav ...]
//   node scripts/analyze.mjs --bpm 120 tema.aiff      (fuerza un tempo, como el botón «Fijar»)
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { analyzeTrack, ANALYSIS_SAMPLE_RATE } from '../js/dsp.js';
import { isAiff, parseAiff } from '../js/aiff.js';
import { decodeWav, resample } from './wav.mjs';

const args = process.argv.slice(2);
let bpmHint = null;
const bi = args.indexOf('--bpm');
if (bi >= 0) {
  bpmHint = Number(args[bi + 1]);
  args.splice(bi, 2);
}
if (!args.length) {
  console.error('Uso: node scripts/analyze.mjs [--bpm 120] pista.aiff|pista.wav [...]');
  process.exit(1);
}

function load(file) {
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (isAiff(ab)) {
    const a = parseAiff(ab);
    const n = a.channels[0].length;
    const mono = new Float32Array(n);
    for (const ch of a.channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / a.channels.length;
    return { samples: mono, sampleRate: a.sampleRate };
  }
  return decodeWav(buf);
}

for (const file of args) {
  try {
    const { samples, sampleRate } = load(file);
    const t0 = performance.now();
    const r = analyzeTrack(resample(samples, sampleRate, ANALYSIS_SAMPLE_RATE), ANALYSIS_SAMPLE_RATE, () => {}, { bpmHint });
    const ms = Math.round(performance.now() - t0);
    console.log(`\n${basename(file)}`);
    console.log(`  Tonalidad ${r.key?.camelot ?? '?'} (${r.key?.musical ?? '?'}) · ${r.bpm} BPM · Energía ${r.energy} · ${ms} ms`);
    console.log(`  Cues: ${r.cues.map((c) => `${c.label}@${c.time.toFixed(1)}s`).join(' ')}`);
    console.log(`  Diagnóstico del tempo: ${JSON.stringify(r.tempoInfo)}`);
  } catch (err) {
    console.error(`\n${basename(file)}: ${err.message}`);
  }
}
