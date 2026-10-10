import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildRekordboxXml, locationUrl, firstDownbeat, kindOf } from '../js/rekordbox.js';

test('Location con formato de rekordbox (Windows y Mac)', () => {
  assert.equal(locationUrl('F:\\06_Musica\\Mi_Musica', 'Frink - Deeply (Original Mix).aiff'),
    'file://localhost/F:/06_Musica/Mi_Musica/Frink%20-%20Deeply%20(Original%20Mix).aiff');
  assert.equal(locationUrl('f:\\Música\\', 'sub/Ñandú & Co.wav'), 'file://localhost/F:/M%C3%BAsica/sub/%C3%91and%C3%BA%20%26%20Co.wav');
  assert.equal(locationUrl('/Users/yo/Music', 'a b.mp3'), 'file://localhost/Users/yo/Music/a%20b.mp3');
});

test('primer tiempo fuerte de la rejilla', () => {
  assert.ok(Math.abs(firstDownbeat({ bpm: 120, firstBeat: 0.1, downbeat: 2 }) - 1.1) < 1e-9);
  assert.equal(firstDownbeat({ bpm: 120, firstBeat: -0.008, downbeat: 0 }), 0);
  assert.ok(Math.abs(firstDownbeat({ bpm: 120, firstBeat: -0.2, downbeat: 0 }) - 1.8) < 1e-9);
  assert.equal(firstDownbeat({ bpm: 0 }), null);
  assert.equal(kindOf('x.AIFF'), 'AIFF File');
});

test('XML válido con pistas, cues, rejilla y lista', () => {
  const tracks = [{
    title: 'Deeply "Original" <Mix>', artist: 'Frink & Co', name: 'Frink - Deeply.aiff', relPath: 'House/Frink - Deeply.aiff', size: 123456,
    keyText: '8A', comment: '8A - Energy 4',
    result: { duration: 401.6, bpm: 124, beatGrid: { bpm: 124, firstBeat: 0.05, downbeat: 1 },
      cues: [{ time: 0.05, label: 'Intro' }, { time: 62.0, label: 'Drop' }] },
  }];
  const xml = buildRekordboxXml(tracks, { basePath: 'F:\\Musica', cueColors: ['#f87171', '#fb923c'], playlists: [{ name: 'KeyMix', ids: [0] }] });
  // Validación con un parser XML independiente (Python).
  const out = execFileSync('python3', ['-I', '-c', `
import sys, xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.read())
t = root.find('COLLECTION/TRACK')
print(t.get('Name')); print(t.get('Artist')); print(t.get('Location')); print(t.get('Tonality')); print(t.get('AverageBpm'))
print(root.find('COLLECTION/TRACK/TEMPO').get('Inizio'))
for m in t.findall('POSITION_MARK'): print(m.get('Name'), m.get('Start'), m.get('Num'), m.get('Red'))
print(root.find('PLAYLISTS/NODE/NODE').get('Name'), root.find('PLAYLISTS/NODE/NODE/TRACK').get('Key'))
`], { input: xml }).toString().trim().split('\n');
  assert.deepEqual(out, [
    'Deeply "Original" <Mix>', 'Frink & Co', 'file://localhost/F:/Musica/House/Frink%20-%20Deeply.aiff', '8A', '124.00',
    '0.534',
    'Intro 0.050 0 248', 'Intro 0.050 -1 None', 'Drop 62.000 1 251', 'Drop 62.000 -1 None',
    'KeyMix 1',
  ]);
  const flat = buildRekordboxXml(tracks, { basePath: 'F:\\Copias', useSubfolders: false });
  assert.ok(flat.includes('Location="file://localhost/F:/Copias/Frink%20-%20Deeply.aiff"'));
});
