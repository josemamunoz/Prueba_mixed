import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAiff, isAiff, encodeWav } from '../js/aiff.js';
import { readTags } from '../js/id3.js';
import { decodeWav } from '../scripts/wav.mjs';

let ffmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  ffmpeg = false;
}
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

const dir = ffmpeg ? mkdtempSync(join(tmpdir(), 'keymix-aiff-')) : null;
const src = dir && join(dir, 'src.wav');
if (ffmpeg) {
  // Estéreo: 440 Hz a la izquierda, 660 Hz a la derecha, 44,1 kHz.
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1:sample_rate=44100', '-filter_complex', '[0][1]join=inputs=2:channel_layout=stereo',
    '-c:a', 'pcm_s16le', '-y', src]);
}

for (const codec of ['pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_f32be', 'pcm_s16le']) {
  test(`AIFF ${codec}: coincide con el audio original`, { skip: !ffmpeg && 'ffmpeg no disponible' }, () => {
    const out = join(dir, `${codec}.aiff`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', src, '-c:a', codec, '-metadata', 'title=Mi tema', '-metadata', 'artist=DJ Prueba', '-write_id3v2', '1', '-y', out]);
    const ab = toAB(readFileSync(out));
    assert.ok(isAiff(ab));
    const a = parseAiff(ab);
    assert.equal(a.sampleRate, 44100);
    assert.equal(a.channels.length, 2);
    // Mezcla izquierda + derecha del WAV de referencia (decodeWav promedia los canales).
    const ref = decodeWav(readFileSync(src)).samples;
    assert.equal(a.channels[0].length, ref.length);
    let maxErr = 0;
    for (let i = 0; i < ref.length; i++) maxErr = Math.max(maxErr, Math.abs((a.channels[0][i] + a.channels[1][i]) / 2 - ref[i]));
    assert.ok(maxErr < 1e-3, `error máximo ${maxErr}`);
    assert.ok(a.id3, 'sin bloque ID3');
    const tags = readTags(toAB(Buffer.from(a.id3)));
    assert.equal(tags.title, 'Mi tema');
    assert.equal(tags.artist, 'DJ Prueba');
  });
}

test('encodeWav produce un WAV válido', async () => {
  const l = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.5);
  const r = l.map((v) => -v);
  const wav = Buffer.from(await encodeWav([l, r], 48000).arrayBuffer());
  const d = decodeWav(wav);
  assert.equal(d.sampleRate, 48000);
  assert.equal(d.samples.length, 100);
  assert.ok(d.samples.every((v) => Math.abs(v) < 1e-4)); // L y R opuestos se anulan al promediar
});

test('rechaza archivos que no son AIFF', () => {
  assert.equal(isAiff(new ArrayBuffer(4)), false);
  assert.throws(() => parseAiff(new Uint8Array(20).buffer));
});
