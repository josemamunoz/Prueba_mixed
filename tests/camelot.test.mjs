import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelotCode, openKeyCode, musicalName, fromCamelot, compatibility, compatibleCodes } from '../js/camelot.js';

test('mapeo Camelot de referencia', () => {
  const cases = [
    [0, 'major', '8B', '1d', 'C'], [9, 'minor', '8A', '1m', 'Am'],
    [7, 'major', '9B', '2d', 'G'], [4, 'minor', '9A', '2m', 'Em'],
    [11, 'major', '1B', '6d', 'B'], [8, 'minor', '1A', '6m', 'G#m'],
    [5, 'major', '7B', '12d', 'F'], [2, 'minor', '7A', '12m', 'Dm'],
    [6, 'major', '2B', '7d', 'F#'], [3, 'minor', '2A', '7m', 'Ebm'],
    [1, 'minor', '12A', '5m', 'C#m'], [0, 'minor', '5A', '10m', 'Cm'],
  ];
  for (const [t, m, cam, ok, mus] of cases) {
    assert.equal(camelotCode(t, m), cam);
    assert.equal(openKeyCode(t, m), ok);
    assert.equal(musicalName(t, m), mus);
    assert.deepEqual(fromCamelot(cam), { tonic: t, mode: m });
  }
});

test('reglas de mezcla armónica', () => {
  assert.equal(compatibility('8A', '8A').type, 'perfect');
  assert.equal(compatibility('8A', '9A').type, 'perfect');
  assert.equal(compatibility('12A', '1A').type, 'perfect');
  assert.equal(compatibility('1A', '12A').type, 'perfect');
  assert.equal(compatibility('8A', '8B').type, 'perfect');
  assert.equal(compatibility('8A', '10A').type, 'boost');
  assert.equal(compatibility('8A', '3A').type, 'boost');
  assert.equal(compatibility('8A', '9B').type, 'diagonal');
  assert.equal(compatibility('8B', '7A').type, 'diagonal');
  assert.equal(compatibility('8A', '2B').type, 'clash');
  assert.equal(compatibleCodes('8A').length, 7);
});
