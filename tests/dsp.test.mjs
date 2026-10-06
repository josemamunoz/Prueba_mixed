import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../js/dsp.js';
import { synthTrack } from './synth.mjs';

// Progresión i–iv–V–i en La menor: Am, Dm, E, Am.
const A_MINOR = [[57, 60, 64], [57, 62, 65], [56, 59, 64], [57, 60, 64]];
const A_MINOR_BASS = [45, 50, 40, 45];
// I–IV–V–I en Re mayor.
const D_MAJOR = [[62, 66, 69], [55, 59, 62], [57, 61, 64], [62, 66, 69]];
const D_MAJOR_BASS = [38, 43, 45, 38];

test('detecta La menor (8A) y 126 BPM', () => {
  const r = analyzeTrack(synthTrack({ bpm: 126, chords: A_MINOR, bass: A_MINOR_BASS }));
  assert.equal(r.key.camelot, '8A');
  assert.equal(r.key.musical, 'Am');
  assert.ok(Math.abs(r.bpm - 126) < 0.5, `bpm=${r.bpm}`);
});

test('detecta Re mayor (10B) y 174 BPM', () => {
  const r = analyzeTrack(synthTrack({ bpm: 174, chords: D_MAJOR, bass: D_MAJOR_BASS }));
  assert.equal(r.key.camelot, '10B');
  assert.ok(Math.abs(r.bpm - 174) < 0.5, `bpm=${r.bpm}`);
});

test('detecta un tempo no entero (122.5 BPM)', () => {
  const r = analyzeTrack(synthTrack({ bpm: 122.5, chords: A_MINOR, bass: A_MINOR_BASS, seconds: 60 }));
  assert.ok(Math.abs(r.bpm - 122.5) < 0.2, `bpm=${r.bpm}`);
});

test('genera cues en el break y en el drop', () => {
  const bpm = 128;
  const bar = (60 / bpm) * 4;
  const r = analyzeTrack(
    synthTrack({
      bpm,
      chords: A_MINOR,
      bass: A_MINOR_BASS,
      seconds: bar * 48,
      sections: [{ fromBar: 16, toBar: 32, gain: 0.25, kick: false }],
    }),
  );
  const near = (t) => r.cues.some((c) => Math.abs(c.time - t) < bar * 0.6);
  assert.equal(r.cues[0].label, 'Intro');
  assert.ok(near(16 * bar), `sin cue en el break: ${JSON.stringify(r.cues)}`);
  assert.ok(near(32 * bar), `sin cue en el drop: ${JSON.stringify(r.cues)}`);
  assert.ok(r.energy >= 1 && r.energy <= 10);
});

test('una pista más fuerte y rápida tiene más energía', () => {
  const quiet = synthTrack({ bpm: 90, chords: A_MINOR, seconds: 30, sections: [{ fromBar: 0, toBar: 999, gain: 0.08, kick: false }] });
  const loud = synthTrack({ bpm: 140, chords: A_MINOR, bass: A_MINOR_BASS, seconds: 30 });
  assert.ok(analyzeTrack(loud).energy > analyzeTrack(quiet).energy);
});

test('rechaza audio demasiado corto', () => {
  assert.throws(() => analyzeTrack(new Float32Array(1000)));
});
