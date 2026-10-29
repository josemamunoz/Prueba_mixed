import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVocals, parseVocalsFile, vocalsKey, VOCALS_FILE } from '../js/vocals.js';

// Segmentos de 3 s: -40 dB es instrumental; los valores > -10 dB cuentan como voz.
const track = (n, hits) => {
  const seg = new Array(n).fill(-40);
  for (const [i, db] of hits) seg[i] = db;
  return { seg, segSec: 3 };
};

test('classifyVocals detecta voz cuando los segmentos fuertes vienen seguidos', () => {
  const r = classifyVocals(track(100, [[50, -6], [51, -7], [52, -5]]));
  assert.equal(r.vocal, true);
  assert.equal(r.share, 0.03);
  assert.deepEqual(r.sections, [[150, 159]]);
});

test('classifyVocals ignora segmentos fuertes aislados', () => {
  // Como Find Yourself: golpes sueltos por encima de -10 dB, sin ninguno contiguo.
  const r = classifyVocals(track(100, [[10, -5], [20, -6], [30, -5], [40, -7], [60, -6]]));
  assert.equal(r.vocal, false);
  assert.equal(r.share, 0);
  assert.deepEqual(r.sections, []);
});

test('classifyVocals aplica el umbral del 2,5 % de la pista', () => {
  assert.equal(classifyVocals(track(80, [[5, -8], [6, -8]])).vocal, true); // 2/80 = 2,5 %
  assert.equal(classifyVocals(track(81, [[5, -8], [6, -8]])).vocal, false); // 2/81 < 2,5 %
});

test('classifyVocals exige superar -10 dB y no cuenta los segmentos en silencio', () => {
  assert.equal(classifyVocals(track(40, [[1, -10], [2, -10]])).vocal, false);
  // Los segmentos sin señal (null) no cuentan en el total ni cortan una racha por contigüidad.
  const seg = [-6, -6, ...new Array(38).fill(null)];
  const r = classifyVocals({ seg, segSec: 3 });
  assert.equal(r.share, 1);
  assert.equal(r.vocal, true);
});

test('classifyVocals devuelve null sin medidas', () => {
  assert.equal(classifyVocals(null), null);
  assert.equal(classifyVocals({ seg: [], segSec: 3 }), null);
});

test('parseVocalsFile lee las pistas del archivo del script', () => {
  const text = JSON.stringify({
    format: 'keymix-voces', version: 1, model: 'htdemucs',
    tracks: { 'Sub/a.wav': { name: 'a.wav', size: 123, segSec: 3, seg: [-40, -6] }, 'b.aiff': { name: 'b.aiff', size: 9, segSec: 3, seg: [] } },
  });
  const list = parseVocalsFile(text);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { key: vocalsKey('a.wav', 123), seg: [-40, -6], segSec: 3, model: 'htdemucs' });
  assert.equal(VOCALS_FILE, 'keymix-voces.json');
});

test('parseVocalsFile rechaza archivos que no son del script', () => {
  assert.throws(() => parseVocalsFile('{"tracks": {}}'), /keymix-voces/);
  assert.throws(() => parseVocalsFile('no es json'));
  assert.throws(() => parseVocalsFile(JSON.stringify({ format: 'keymix-voces', version: 2, tracks: {} })), /Versión 2/);
});
