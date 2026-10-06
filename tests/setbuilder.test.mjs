import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSet, bpmDistance, pathCost } from '../js/setbuilder.js';

test('bpmDistance contempla doble y mitad de tempo', () => {
  assert.equal(bpmDistance(128, 128), 0);
  assert.ok(bpmDistance(87, 174) < 0.01);
  assert.ok(Math.abs(bpmDistance(125, 128) - 2.4) < 0.01);
});

test('buildSet encadena tonalidades compatibles y no pierde pistas', () => {
  const t = (id, camelot, bpm, energy) => ({ id, camelot, bpm, energy });
  const tracks = [t('a', '8A', 124, 5), t('b', '3B', 126, 7), t('c', '9A', 125, 6), t('d', '10A', 126, 6), t('e', '8B', 124, 5), t('f', '2B', 126, 7), t('g', '11A', 126, 7), t('h', '12A', 127, 7)];
  const order = buildSet(tracks, 'a');
  assert.equal(order.length, tracks.length);
  assert.equal(order[0].id, 'a');
  assert.deepEqual(new Set(order.map((x) => x.id)), new Set(tracks.map((x) => x.id)));
  const shuffled = [tracks[0], ...tracks.slice(1).reverse()];
  assert.ok(pathCost(order) <= pathCost(shuffled));
});
