// Generador de pistas sintéticas para los tests: bombo a tempo fijo + acordes de una tonalidad.

const NOTE = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const freq = (midi) => 440 * 2 ** ((midi - 69) / 12);

/**
 * chords: lista de arrays de notas MIDI que se alternan cada compás.
 * sections: opcional, [{ fromBar, toBar, gain, kick }] para crear breaks.
 */
/**
 * arp: opcional, { everyBeats, notes, gain, attack } — notas cortas y brillantes cada `everyBeats` tiempos
 * (0.75 = corcheas con puntillo, típico del delay en melodic/progressive house).
 */
export function synthTrack({ bpm, chords, bass, seconds = 40, sr = 22050, sections = [], arp = null, kickGain = 1 }) {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  const beat = 60 / bpm;
  const bar = beat * 4;
  const sectionAt = (t) => sections.find((s) => t >= s.fromBar * bar && t < s.toBar * bar) || { gain: 1, kick: true };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const sec = sectionAt(t);
    const barIdx = Math.floor(t / bar);
    const chord = chords[barIdx % chords.length];
    let s = 0;
    for (const m of chord) {
      const f = freq(m);
      s += 0.08 * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) + 0.2 * Math.sin(6 * Math.PI * f * t));
    }
    if (bass != null) {
      const bm = Array.isArray(bass) ? bass[barIdx % bass.length] : bass;
      s += 0.15 * Math.sin(2 * Math.PI * freq(bm) * t);
    }
    if (sec.kick) {
      const tb = t % beat;
      const env = Math.exp(-tb * 30);
      s += 0.6 * kickGain * env * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb);
      const th = (t + beat / 2) % beat; // charles a contratiempo
      s += 0.05 * Math.exp(-th * 80) * (Math.sin(t * 52000) * Math.sin(t * 31337));
    }
    if (arp) {
      const step = beat * arp.everyBeats;
      const k = Math.floor(t / step);
      const ta = t - k * step;
      const f = freq(arp.notes[k % arp.notes.length]);
      // attack (s): 0 = ataque seco con clic (caso difícil); 0.004 = pluck realista.
      const env = (arp.attack ? Math.min(1, ta / arp.attack) : 1) * Math.exp(-ta * 9);
      s += arp.gain * env * (Math.sin(2 * Math.PI * f * ta) + 0.5 * Math.sin(4 * Math.PI * f * ta) + 0.3 * Math.sin(6 * Math.PI * f * ta));
    }
    out[i] = s * sec.gain;
  }
  return out;
}

export { NOTE };
