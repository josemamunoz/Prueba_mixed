// Pistas de demostración generadas en el navegador (sin descargar nada).
import { synthTrack } from './synth.js';

const minor = (r) => [r, r + 3, r + 7];
const major = (r) => [r, r + 4, r + 7];

const DEMOS = [
  { title: 'Midnight Signal', key: 'Am', bpm: 126, chords: [minor(57), minor(62), major(52), minor(57)], bass: [45, 50, 40, 45], gain: 0.9 },
  { title: 'Glass Horizon', key: 'Em', bpm: 128, chords: [minor(52), minor(57), major(59), minor(52)], bass: [40, 45, 47, 40], gain: 1 },
  { title: 'Daylight Loop', key: 'C', bpm: 124, chords: [major(60), major(65), major(67), major(60)], bass: [36, 41, 43, 36], gain: 0.6 },
  { title: 'Tidal Drift', key: 'F#m', bpm: 124, chords: [minor(54), minor(59), major(61), minor(54)], bass: [42, 47, 37, 42], gain: 0.8 },
  { title: 'Velocity Run', key: 'D', bpm: 174, chords: [major(62), major(67), major(69), major(62)], bass: [38, 43, 45, 38], gain: 1 },
];

function wavFile(samples, sr, name) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, Math.round(samples[i] * 20000))), true);
  return new File([buf], name, { type: 'audio/wav', lastModified: 1 });
}

/** Crea 5 pistas WAV de ~1 minuto con estructura intro / drop / break / drop. */
export function makeDemoFiles() {
  const sr = 22050;
  return DEMOS.map((d) => {
    const bar = (60 / d.bpm) * 4;
    const x = synthTrack({
      bpm: d.bpm, sr, seconds: bar * 40, chords: d.chords, bass: d.bass,
      sections: [
        { fromBar: 0, toBar: 8, gain: 0.4 * d.gain, kick: true },
        { fromBar: 8, toBar: 24, gain: d.gain, kick: true },
        { fromBar: 24, toBar: 32, gain: 0.3 * d.gain, kick: false },
        { fromBar: 32, toBar: 40, gain: d.gain, kick: true },
      ],
    });
    return wavFile(x, sr, `Demo - ${d.title}.wav`);
  });
}
