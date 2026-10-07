import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeContainerTags, readContainerTags, isTaggableContainer } from '../js/id3.js';
import { parseAiff } from '../js/aiff.js';

let ffmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  ffmpeg = false;
}
const dir = ffmpeg ? mkdtempSync(join(tmpdir(), 'keymix-ct-')) : null;
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const audioMd5 = (file) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-map', '0:a', '-f', 'md5', '-']).toString().trim();
const probeTags = (file) => JSON.parse(execFileSync('ffprobe', ['-loglevel', 'error', '-show_entries', 'format_tags', '-of', 'json', file]).toString()).format.tags || {};
const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

const cases = [
  { name: 'AIFF 16 bits con etiqueta', ext: 'aiff', codec: 'pcm_s16be', tagged: true },
  { name: 'AIFF 24 bits sin etiqueta', ext: 'aiff', codec: 'pcm_s24be', tagged: false },
  { name: 'WAV 24 bits con etiqueta', ext: 'wav', codec: 'pcm_s24le', tagged: true },
  { name: 'WAV 16 bits sin etiqueta', ext: 'wav', codec: 'pcm_s16le', tagged: false },
];

for (const c of cases) {
  test(`${c.name}: escribe etiquetas sin tocar el audio`, { skip: !ffmpeg && 'ffmpeg no disponible' }, () => {
    const src = join(dir, `src-${c.codec}-${c.tagged}.${c.ext}`);
    const meta = c.tagged ? ['-metadata', 'title=Deeply', '-metadata', 'artist=Frink', '-write_id3v2', '1'] : [];
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2:sample_rate=44100', '-ac', '2', '-c:a', c.codec, ...meta, '-y', src]);
    const ab = toAB(readFileSync(src));
    assert.ok(isTaggableContainer(ab));

    // Dos pasadas: la segunda reemplaza el bloque escrito por la primera.
    const once = Buffer.from(writeContainerTagsSync(ab, { key: '7A', bpm: 120, comment: 'old' }));
    const out = join(dir, `out-${c.codec}-${c.tagged}.${c.ext}`);
    const twice = Buffer.from(writeContainerTagsSync(toAB(once), { key: '8A', bpm: 124, comment: '8A - Energy 4' }));
    writeFileSync(out, twice);
    const thrice = writeContainerTagsSync(toAB(twice), { key: '8A', bpm: 124, comment: '8A - Energy 4' });
    assert.equal(thrice.length, twice.length, 'reescribir los mismos valores no debe hacer crecer el archivo');

    assert.equal(audioMd5(out), audioMd5(src), 'el audio cambió');
    const t = lower(probeTags(out));
    assert.equal(t.tkey ?? t.key, '8A');
    assert.equal(t.tbpm ?? t.bpm, '124');
    assert.equal(t.comment, '8A - Energy 4');
    if (c.tagged) {
      assert.equal(t.title, 'Deeply');
      assert.equal(t.artist, 'Frink');
    }
    const ours = readContainerTags(toAB(twice));
    assert.equal(ours.key, '8A');
    if (c.ext === 'aiff') assert.equal(parseAiff(toAB(twice)).channels[0].length, 88200);
  });
}

// writeContainerTags devuelve un Blob; en los tests se lee de forma síncrona con su buffer interno.
function writeContainerTagsSync(ab, values) {
  const blob = writeContainerTags(ab, values);
  return blobBytes.get(blob) ?? (() => { throw new Error('usar await'); })();
}
const blobBytes = new WeakMap();
const OrigBlob = globalThis.Blob;
globalThis.Blob = class extends OrigBlob {
  constructor(parts, opts) {
    super(parts, opts);
    const len = parts.reduce((a, p) => a + p.byteLength, 0);
    const u = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { u.set(new Uint8Array(p.buffer ?? p, p.byteOffset ?? 0, p.byteLength), o); o += p.byteLength; }
    blobBytes.set(this, u);
  }
};

test('rechaza archivos que no son AIFF ni WAV', () => {
  assert.equal(isTaggableContainer(new Uint8Array([0xff, 0xfb, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer), false);
  assert.throws(() => writeContainerTags(new Uint8Array(16).buffer, { key: '1A' }));
});
