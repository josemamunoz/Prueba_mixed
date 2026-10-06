import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTags, writeTags } from '../js/id3.js';

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeMp3(version) {
  const dir = mkdtempSync(join(tmpdir(), 'keymix-'));
  const out = join(dir, `t${version}.mp3`);
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-metadata', 'title=Canción Ñ', '-metadata', 'artist=DJ Prueba', '-metadata', 'comment=original',
    '-metadata', 'album=Álbum', '-id3v2_version', String(version), '-y', out,
  ]);
  return readFileSync(out);
}

const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

for (const version of [3, 4]) {
  test(`ID3v2.${version}: lee y reescribe tonalidad, BPM y comentario`, { skip: !hasFfmpeg() && 'ffmpeg no disponible' }, async () => {
    const src = makeMp3(version);
    const before = readTags(toAB(src));
    assert.equal(before.title, 'Canción Ñ');
    assert.equal(before.artist, 'DJ Prueba');

    const blob = writeTags(toAB(src), { key: '8A', bpm: 126, comment: '8A - Energía 7' });
    const outBuf = await blob.arrayBuffer();
    const after = readTags(outBuf);
    assert.equal(after.title, 'Canción Ñ');
    assert.equal(after.artist, 'DJ Prueba');
    assert.equal(after.key, '8A');
    assert.equal(after.bpm, '126');
    assert.equal(after.comment, '8A - Energía 7');

    // El audio se conserva byte a byte tras la etiqueta.
    const tagLen = (b) => 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
    const a = new Uint8Array(toAB(src)).subarray(tagLen(src));
    const ob = new Uint8Array(outBuf);
    const b = ob.subarray(tagLen(ob));
    assert.deepEqual(Buffer.from(b), Buffer.from(a));
  });
}

test('crea una etiqueta nueva si el archivo no tiene', async () => {
  const fake = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
  const out = await writeTags(fake.buffer, { key: '5A' }).arrayBuffer();
  assert.equal(readTags(out).key, '5A');
  assert.deepEqual([...new Uint8Array(out).slice(-7)], [...fake]);
});
