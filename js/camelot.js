// Notaciones de tonalidad (Camelot, Open Key, musical) y reglas de mezcla armónica.

const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

/** Número Camelot (1-12) de una tonalidad. tonic: clase de altura 0-11 (C=0). */
export function camelotNumber(tonic, mode) {
  const majorPc = mode === 'major' ? tonic : (tonic + 3) % 12;
  return ((majorPc * 7) % 12 + 7) % 12 + 1;
}

export function camelotCode(tonic, mode) {
  return `${camelotNumber(tonic, mode)}${mode === 'major' ? 'B' : 'A'}`;
}

export function openKeyCode(tonic, mode) {
  const n = camelotNumber(tonic, mode);
  return `${((n - 8 + 12) % 12) + 1}${mode === 'major' ? 'd' : 'm'}`;
}

export function musicalName(tonic, mode) {
  return mode === 'major' ? MAJOR_NAMES[tonic] : `${MINOR_NAMES[tonic]}m`;
}

/** Convierte "8A" -> { tonic: 9, mode: 'minor' }. */
export function fromCamelot(code) {
  const m = /^(\d{1,2})([AB])$/i.exec(String(code).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 12) return null;
  const majorPc = (((n - 8) * 7) % 12 + 12) % 12;
  if (m[2].toUpperCase() === 'B') return { tonic: majorPc, mode: 'major' };
  return { tonic: (majorPc + 9) % 12, mode: 'minor' };
}

export function formatKey(tonic, mode, notation = 'camelot') {
  if (notation === 'openkey') return openKeyCode(tonic, mode);
  if (notation === 'musical') return musicalName(tonic, mode);
  return camelotCode(tonic, mode);
}

/** Color de la rueda Camelot para un número y letra. */
export function keyColor(n, letter, alpha = 1) {
  const hue = ((n - 1) * 30 + 75) % 360;
  const light = letter === 'B' ? 62 : 50;
  return `hsla(${hue}, 78%, ${light}%, ${alpha})`;
}

function parse(code) {
  const m = /^(\d{1,2})([AB])$/.exec(code || '');
  return m ? { n: Number(m[1]), l: m[2] } : null;
}

/**
 * Relación armónica entre dos claves Camelot (de a hacia b).
 * type: perfect | boost | diagonal | clash
 */
export function compatibility(fromCode, toCode) {
  const a = parse(fromCode);
  const b = parse(toCode);
  if (!a || !b) return { type: 'unknown', label: '—', cost: 5 };
  const d = (((b.n - a.n) % 12) + 12) % 12;
  if (a.l === b.l) {
    if (d === 0) return { type: 'perfect', label: 'Misma tonalidad', cost: 0 };
    if (d === 1) return { type: 'perfect', label: '+1 (dominante)', cost: 1 };
    if (d === 11) return { type: 'perfect', label: '−1 (subdominante)', cost: 1 };
    if (d === 2) return { type: 'boost', label: 'Energy boost +2', cost: 2 };
    if (d === 7) return { type: 'boost', label: 'Subida de semitono +7', cost: 2.5 };
  } else {
    if (d === 0) return { type: 'perfect', label: 'Relativa (mayor/menor)', cost: 1 };
    if (a.l === 'A' && d === 1) return { type: 'diagonal', label: 'Diagonal', cost: 2.5 };
    if (a.l === 'B' && d === 11) return { type: 'diagonal', label: 'Diagonal', cost: 2.5 };
  }
  return { type: 'clash', label: 'Choque armónico', cost: 8 };
}

/** Todas las claves Camelot compatibles con una dada (incluida ella misma). */
export function compatibleCodes(code) {
  const out = [];
  for (let n = 1; n <= 12; n++) {
    for (const l of ['A', 'B']) {
      const c = `${n}${l}`;
      const r = compatibility(code, c);
      if (r.type !== 'clash' && r.type !== 'unknown') out.push({ code: c, ...r });
    }
  }
  return out;
}

/** Relativa mayor/menor (mismo número, otra letra): 8A ↔ 8B. */
export function relativeCode(code) {
  const m = /^(\d{1,2})([AB])$/.exec(code || '');
  return m ? `${m[1]}${m[2] === 'A' ? 'B' : 'A'}` : null;
}

/**
 * Notas MIDI del tono de referencia de una tonalidad Camelot.
 * mode 'note': tónica en dos octavas. mode 'chord': tónica grave + tríada (mayor o menor).
 * La tónica se sitúa entre Do3 y Si3 (MIDI 48-59), un registro que se oye bien sobre la mezcla.
 */
export function referenceMidi(code, mode = 'chord') {
  const k = fromCamelot(code);
  if (!k) return [];
  const root = 48 + k.tonic;
  if (mode === 'note') return [root - 12, root];
  return [root - 12, root, root + (k.mode === 'major' ? 4 : 3), root + 7];
}
