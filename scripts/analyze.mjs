#!/usr/bin/env node
// Uso: node scripts/analyze.mjs pista.wav [otra.wav ...]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { analyzeTrack, ANALYSIS_SAMPLE_RATE } from '../js/dsp.js';
import { decodeWav, resample } from './wav.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Uso: node scripts/analyze.mjs pista.wav [...]');
  process.exit(1);
}
for (const file of files) {
  const { samples, sampleRate } = decodeWav(readFileSync(file));
  const t0 = performance.now();
  const r = analyzeTrack(resample(samples, sampleRate, ANALYSIS_SAMPLE_RATE));
  const ms = Math.round(performance.now() - t0);
  const cues = r.cues.map((c) => `${c.label}@${c.time.toFixed(1)}s`).join(' ');
  console.log(
    `${basename(file)}\t${r.key?.camelot ?? '?'} (${r.key?.musical ?? '?'})\t${r.bpm} BPM\tEnergía ${r.energy}\t[${cues}]\t${ms} ms`,
  );
}
