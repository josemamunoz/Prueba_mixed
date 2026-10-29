/**
 * Detección de voces a partir de la separación que hace `scripts/vocals.py` (Demucs) fuera del
 * navegador. El script guarda, por cada segmento de 3 s, la energía de la voz separada respecto
 * a la mezcla en dB; aquí se decide si la pista tiene voz.
 *
 * Regla, ajustada con 18 pistas etiquetadas a mano (8 con voz, 10 instrumentales): un segmento
 * cuenta como voz si supera -10 dB y su vecino también (los golpes aislados suelen ser sintes o
 * efectos que Demucs confunde con voz); la pista tiene voz si esos segmentos son al menos el 2,5 %.
 */

export const VOCALS_FILE = 'keymix-voces.json';
export const VOCAL_DB = -10;
export const VOCAL_MIN_SHARE = 0.025;

export const vocalsKey = (name, size) => `${name}|${size}`;

/**
 * Clasifica las medidas de una pista: `{ seg: [dB | null], segSec }`.
 * Devuelve `{ vocal, share, sections: [[inicio, fin] en segundos] }`, o null si no hay medidas.
 * Los segmentos en silencio (null) no cuentan en el total.
 */
export function classifyVocals(v) {
  const idx = [];
  (v?.seg || []).forEach((db, i) => { if (db != null) idx.push(i); });
  if (!idx.length) return null;
  const loud = idx.map((i) => v.seg[i] > VOCAL_DB);
  const inRun = loud.map((x, k) => x && (loud[k - 1] || loud[k + 1]) === true);
  const sections = [];
  inRun.forEach((x, k) => {
    if (!x) return;
    const start = idx[k] * v.segSec;
    const end = (idx[k] + 1) * v.segSec;
    if (inRun[k - 1]) sections[sections.length - 1][1] = end;
    else sections.push([start, end]);
  });
  const share = inRun.filter(Boolean).length / idx.length;
  return { vocal: share >= VOCAL_MIN_SHARE, share, sections };
}

/**
 * Copia en `t.vocals` las medidas de las pistas con el mismo nombre y tamaño.
 * Devuelve cuántas pistas cambiaron (las que ya tenían esas mismas medidas no cuentan).
 */
export function applyVocals(tracks, entries) {
  const byKey = new Map(entries.map((v) => [v.key, v]));
  let changed = 0;
  for (const t of tracks) {
    const v = byKey.get(vocalsKey(t.name, t.size));
    if (!v) continue;
    const vocals = { seg: v.seg, segSec: v.segSec, model: v.model };
    if (JSON.stringify(vocals) === JSON.stringify(t.vocals)) continue;
    t.vocals = vocals;
    changed++;
  }
  return changed;
}

/** Lee `keymix-voces.json` y devuelve `[{ key, seg, segSec, model }]`. */
export function parseVocalsFile(text) {
  const data = JSON.parse(text);
  if (data?.format !== 'keymix-voces' || typeof data.tracks !== 'object') throw new Error(`No es un archivo ${VOCALS_FILE}`);
  if (data.version !== 1) throw new Error(`Versión ${data.version} de ${VOCALS_FILE} no soportada`);
  return Object.values(data.tracks)
    .filter((t) => t && typeof t.name === 'string' && Number.isFinite(t.size) && Array.isArray(t.seg))
    .map((t) => ({ key: vocalsKey(t.name, t.size), seg: t.seg, segSec: t.segSec || 3, model: data.model || null }));
}
