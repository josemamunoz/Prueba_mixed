// Motor de análisis: tonalidad, BPM, energía, cue points y forma de onda.
// Sin dependencias; funciona en navegador (Web Worker) y en Node.

import { camelotCode, openKeyCode, musicalName } from './camelot.js';

export const ANALYSIS_SAMPLE_RATE = 22050;

// ---------------------------------------------------------------- FFT ----

const fftCache = new Map();

function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const levels = Math.round(Math.log2(n));
  if (1 << levels !== n) throw new Error('El tamaño de la FFT debe ser potencia de 2');
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    let x = i;
    for (let j = 0; j < levels; j++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  fftCache.set(n, t);
  return t;
}

/** FFT compleja radix-2 in situ (signo negativo). */
export function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const l = j + half;
        const tre = re[l] * cos[k] + im[l] * sin[k];
        const tim = im[l] * cos[k] - re[l] * sin[k];
        re[l] = re[j] - tre;
        im[l] = im[j] - tim;
        re[j] += tre;
        im[j] += tim;
      }
    }
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const db = (p) => 10 * Math.log10(p + 1e-12);

function interp(arr, x) {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= arr.length) return 0;
  const f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

// ------------------------------------------------- Características STFT ----

function shortTimeFeatures(x, sr, progress) {
  const N = 1024;
  const H = 256;
  const half = N / 2;
  const n = Math.max(1, Math.floor((x.length - N) / H) + 1);
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const prev = new Float64Array(half);
  const odf = new Float32Array(n);
  const lowOdf = new Float32Array(n);
  const rms = new Float32Array(n);
  const low = new Float32Array(n);
  const mid = new Float32Array(n);
  const high = new Float32Array(n);
  const centroid = new Float32Array(n);
  const binHz = sr / N;
  const lowEnd = Math.round(200 / binHz);
  const kickEnd = Math.max(2, Math.round(160 / binHz));
  const midEnd = Math.round(4000 / binHz);

  for (let f = 0; f < n; f++) {
    const off = f * H;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const s = x[off + i] || 0;
      sq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sq / N);
    fft(re, im);
    let flux = 0, kflux = 0, lo = 0, mi = 0, hi = 0, num = 0, den = 0;
    for (let k = 1; k < half; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      const m = Math.sqrt(p);
      const lm = Math.log1p(100 * m);
      const d = lm - prev[k];
      if (d > 0) {
        flux += d;
        if (k < kickEnd) kflux += d;
      }
      prev[k] = lm;
      if (k < lowEnd) lo += p;
      else if (k < midEnd) mi += p;
      else hi += p;
      num += k * binHz * m;
      den += m;
    }
    odf[f] = f === 0 ? 0 : flux;
    lowOdf[f] = f === 0 ? 0 : kflux;
    low[f] = lo;
    mid[f] = mi;
    high[f] = hi;
    centroid[f] = den > 0 ? num / den : 0;
    if ((f & 2047) === 0) progress(f / n);
  }
  return { odf, lowOdf, rms, low, mid, high, centroid, n, hop: H, frameSize: N, fps: sr / H, sr };
}

const frameTime = (feat, f) => (f * feat.hop + feat.frameSize / 2) / feat.sr;
const timeFrame = (feat, t) => (t * feat.sr - feat.frameSize / 2) / feat.hop;

// -------------------------------------------------------------- Tempo ----

export const MIN_BPM = 80;
export const MAX_BPM = 180;

function combScore(sm, period, phaseStep = 1) {
  let best = -Infinity;
  let bestPhase = 0;
  const n = sm.length;
  for (let ph = 0; ph < period; ph += phaseStep) {
    let s = 0;
    let c = 0;
    for (let t = ph; t < n - 1; t += period) {
      const i = t | 0;
      const fr = t - i;
      s += sm[i] * (1 - fr) + sm[i + 1] * fr;
      c++;
    }
    if (c && s / c > best) {
      best = s / c;
      bestPhase = ph;
    }
  }
  return { score: best, phase: bestPhase };
}

/** Resta de la media local (±0,5 s) + rectificación de media onda. */
function detrend(raw, fps) {
  const n = raw.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + raw[i];
  const w = Math.max(1, Math.round(fps * 0.5));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    const v = raw[i] - (prefix[b] - prefix[a]) / (b - a);
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

function smooth3(x) {
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.25 * (x[i - 1] || 0) + 0.5 * x[i] + 0.25 * (x[i + 1] || 0);
  return out;
}

function mean(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / Math.max(1, x.length);
}

function estimateTempo(feat) {
  const fps = feat.fps;
  const odf = detrend(feat.odf, fps);
  const n = odf.length;

  // Autocorrelación.
  const maxLag = Math.min(n - 1, Math.ceil(((fps * 60) / MIN_BPM) * 4) + 2);
  const ac = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += odf[i] * odf[i + lag];
    ac[lag] = s / (n - lag);
  }
  if (ac[0] <= 0) return { bpm: 0, period: 0, phase: 0, confidence: 0, odf };
  for (let lag = maxLag; lag >= 0; lag--) ac[lag] /= ac[0];

  // Búsqueda gruesa con refuerzo de armónicos del periodo.
  let coarse = 120;
  let coarseScore = -Infinity;
  for (let bpm = MIN_BPM; bpm < MAX_BPM; bpm += 0.25) {
    const L = (60 * fps) / bpm;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 125) / 1.2) ** 2);
    const s = (interp(ac, L) + 0.5 * interp(ac, 2 * L) + 0.25 * interp(ac, 4 * L)) * (0.85 + 0.15 * prior);
    if (s > coarseScore) {
      coarseScore = s;
      coarse = bpm;
    }
  }

  // Error de octava: si el doble de tempo también tiene periodicidad fuerte, se prefiere
  // (p. ej. drum & bass a 174 en lugar de 87).
  const Lc = (60 * fps) / coarse;
  if (coarse * 2 < MAX_BPM && interp(ac, Lc / 2) >= 0.75 * interp(ac, Lc)) coarse *= 2;

  // Refinado con filtro peine sobre toda la pista.
  const sm = smooth3(smooth3(odf));
  let bestBpm = coarse;
  let best = { score: -Infinity, phase: 0 };
  for (let bpm = coarse - 1; bpm <= coarse + 1; bpm += 0.02) {
    const r = combScore(sm, (60 * fps) / bpm, 0.5);
    if (r.score > best.score) {
      best = r;
      bestBpm = bpm;
    }
  }
  // Preferir el entero cercano si puntúa casi igual (la mayoría de producciones usan BPM enteros).
  const rounded = Math.round(bestBpm);
  if (Math.abs(rounded - bestBpm) < 0.15) {
    const r = combScore(sm, (60 * fps) / rounded, 0.5);
    if (r.score >= best.score * 0.97) {
      best = r;
      bestBpm = rounded;
    }
  }
  const period = (60 * fps) / bestBpm;
  const confidence = clamp01((combScore(sm, period, 0.5).score / (mean(sm) + 1e-9) - 1) / 3);
  // Fase: el bombo (flujo de graves) marca el tiempo mejor que los charles a contratiempo.
  const kick = smooth3(detrend(feat.lowOdf, fps));
  const kickFit = combScore(kick, period, 0.25);
  const phase = kickFit.score / (mean(kick) + 1e-9) > 1.5 ? kickFit.phase : combScore(sm, period, 0.25).phase;
  return { bpm: Math.round(bestBpm * 100) / 100, period, phase, confidence };
}

// --------------------------------------------------------- Tonalidad ----

// Perfiles de Krumhansl-Kessler y Temperley (C como tónica).
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const TP_MAJOR = [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4];
const TP_MINOR = [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33];

function pearson(a, b, rot) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma;
    const y = b[i] - mb;
    num += x * y; da += x * x; dbb += y * y;
  }
  return num / Math.sqrt(da * dbb + 1e-12);
}

export function keyFromChroma(chroma) {
  const scores = [];
  for (let t = 0; t < 12; t++) {
    scores.push({ tonic: t, mode: 'major', score: 0.5 * pearson(chroma, KK_MAJOR, t) + 0.5 * pearson(chroma, TP_MAJOR, t) });
    scores.push({ tonic: t, mode: 'minor', score: 0.5 * pearson(chroma, KK_MINOR, t) + 0.5 * pearson(chroma, TP_MINOR, t) });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

function estimateKey(x, sr, progress) {
  const N = 1 << Math.round(Math.log2(sr / 1.35));
  const H = N / 2;
  const binHz = sr / N;
  const kMin = Math.max(2, Math.ceil(52 / binHz));
  const kMax = Math.min(N / 2 - 2, Math.floor(1800 / binHz));
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(N / 2);
  const nFrames = Math.max(1, Math.floor((x.length - N) / H) + 1);
  const frames = [];
  let tc = 0, ts = 0;

  for (let f = 0; f < nFrames; f++) {
    const off = f * H;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const s = x[off + i] || 0;
      sq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    if (sq / N < 1e-6) continue; // silencio (< -60 dBFS)
    fft(re, im);
    let maxM = 0;
    for (let k = kMin - 1; k <= kMax + 1; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      if (mag[k] > maxM) maxM = mag[k];
    }
    const thr = maxM * 0.02;
    const peaks = [];
    for (let k = kMin; k <= kMax; k++) {
      const b = mag[k];
      if (b < thr || b <= mag[k - 1] || b < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-12);
      const c = Math.log(mag[k + 1] + 1e-12);
      const lb = Math.log(b);
      const den = a - 2 * lb + c;
      const delta = den !== 0 ? (0.5 * (a - c)) / den : 0;
      const freq = (k + delta) * binHz;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const w = Math.sqrt(b);
      peaks.push(midi, w);
      const ang = 2 * Math.PI * (midi - Math.round(midi));
      tc += w * Math.cos(ang);
      ts += w * Math.sin(ang);
    }
    if (peaks.length) frames.push(peaks);
    if ((f & 31) === 0) progress(f / nFrames);
  }

  // Desafinación global (en semitonos) respecto a A=440.
  const tuning = Math.atan2(ts, tc) / (2 * Math.PI);
  const chroma = new Float64Array(12);
  const bass = new Float64Array(12);
  for (const peaks of frames) {
    const fc = new Float64Array(12);
    const fb = new Float64Array(12);
    let sum = 0;
    for (let i = 0; i < peaks.length; i += 2) {
      const m = peaks[i] - tuning;
      const r = Math.round(m);
      const closeness = Math.cos(Math.PI * (m - r)) ** 2;
      const w = peaks[i + 1] * closeness;
      const pc = ((r % 12) + 12) % 12;
      fc[pc] += w;
      if (r < 55) fb[pc] += w; // por debajo de G3: línea de bajo
      sum += w;
    }
    if (sum <= 0) continue;
    for (let i = 0; i < 12; i++) {
      chroma[i] += fc[i] / sum;
      bass[i] += fb[i] / sum;
    }
  }
  const total = chroma.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  // La línea de bajo refuerza la tónica.
  const combined = new Float64Array(12);
  for (let i = 0; i < 12; i++) combined[i] = chroma[i] + 0.35 * bass[i];
  const bassMax = Math.max(...bass) || 1;
  const ranking = keyFromChroma(combined)
    .map((r) => ({ ...r, score: r.score + 0.08 * (bass[r.tonic] / bassMax) }))
    .sort((a, b) => b.score - a.score);
  const best = ranking[0];
  const second = ranking[1];
  const confidence = clamp01((best.score - second.score) / 0.12) * 0.6 + clamp01(best.score) * 0.4;
  const mx = Math.max(...combined);
  return {
    tonic: best.tonic,
    mode: best.mode,
    score: best.score,
    confidence,
    tuningCents: Math.round(tuning * 100),
    chroma: Array.from(combined, (v) => v / mx),
    alternatives: ranking.slice(1, 3).map((r) => camelotCode(r.tonic, r.mode)),
  };
}

// ------------------------------------------------------ Rejilla de beats ----

function buildBeatGrid(tempo, feat, duration) {
  if (!tempo.bpm) return { bpm: 0, beats: [], firstBeat: 0, downbeat: 0, beatLoud: [], beatLow: [] };
  const beatSec = 60 / tempo.bpm;
  let first = frameTime(feat, tempo.phase);
  first -= Math.floor((first + 0.05) / beatSec) * beatSec; // tolera un beat detectado unos ms antes de 0
  const beats = [];
  for (let t = first; t + beatSec <= duration; t += beatSec) beats.push(t);

  // Volumen y graves por beat.
  const beatLoud = [];
  const beatLow = [];
  for (let i = 0; i < beats.length; i++) {
    const a = Math.max(0, Math.round(timeFrame(feat, beats[i])));
    const b = Math.min(feat.n, Math.round(timeFrame(feat, beats[i] + beatSec)));
    let p = 0, l = 0, c = 0;
    for (let f = a; f < b; f++) {
      p += feat.rms[f] * feat.rms[f];
      l += feat.low[f];
      c++;
    }
    beatLoud.push(c ? db(p / c) : -120);
    beatLow.push(c ? db(l / c) : -120);
  }
  const maxLoud = Math.max(...beatLoud);
  const maxLow = Math.max(...beatLow);
  for (let i = 0; i < beats.length; i++) {
    beatLoud[i] = Math.max(maxLoud - 60, beatLoud[i]);
    beatLow[i] = Math.max(-60, beatLow[i] - maxLow);
  }

  // Primer tiempo de compás: el desplazamiento cuyos límites de compás concentran más cambios.
  let downbeat = 0;
  let bestScore = -Infinity;
  for (let o = 0; o < 4; o++) {
    let s = 0;
    let prev = null;
    for (let i = o; i + 4 <= beats.length; i += 4) {
      let e = 0;
      for (let j = 0; j < 4; j++) e += beatLoud[i + j] + beatLow[i + j];
      e /= 4;
      if (prev !== null) s += (e - prev) ** 2; // cuadrado: premia cambios nítidos en el límite de compás
      prev = e;
    }
    if (s > bestScore) {
      bestScore = s;
      downbeat = o;
    }
  }
  return { bpm: tempo.bpm, beats, firstBeat: first, downbeat, beatLoud, beatLow };
}

// ------------------------------------------------------------ Energía ----

function estimateEnergy(feat, bpm, duration) {
  const n = feat.n;
  const powers = new Float64Array(n);
  for (let i = 0; i < n; i++) powers[i] = feat.rms[i] * feat.rms[i];
  const sorted = Float64Array.from(powers).sort();
  const top = sorted.subarray(Math.floor(n * 0.5));
  let mp = 0;
  for (let i = 0; i < top.length; i++) mp += top[i];
  const loudDb = db(mp / Math.max(1, top.length));

  // Proporción de la pista cerca del nivel máximo (secciones intensas).
  const thr = Math.pow(10, (loudDb - 6) / 10);
  let loudFrames = 0;
  let cSum = 0;
  for (let i = 0; i < n; i++) {
    if (powers[i] >= thr) {
      loudFrames++;
      cSum += feat.centroid[i];
    }
  }
  const fullness = loudFrames / n;
  const centroid = loudFrames ? cSum / loudFrames : 0;

  // Densidad de ataques por segundo.
  const odf = feat.odf;
  const so = Float32Array.from(odf).sort();
  const median = so[Math.floor(n / 2)] || 0;
  const p90 = so[Math.floor(n * 0.9)] || 0;
  const onsetThr = median + 0.5 * (p90 - median);
  const minGap = Math.round(feat.fps * 0.08);
  let onsets = 0;
  let last = -minGap;
  for (let i = 1; i < n - 1; i++) {
    if (odf[i] > onsetThr && odf[i] >= odf[i - 1] && odf[i] >= odf[i + 1] && i - last >= minGap) {
      onsets++;
      last = i;
    }
  }
  const density = onsets / Math.max(1, duration);

  return energyFromFeatures({ loudnessDb: loudDb, onsetsPerSec: density, centroidHz: centroid, fullness, bpm });
}

/**
 * Nivel de energía 1-10 a partir de las medidas de la pista. Separado del análisis para poder
 * recalcular pistas ya analizadas cuando cambia la fórmula.
 *
 * Calibración: los másteres modernos suenan todos fuertes, así que el volumen pesa poco y lo que
 * más distingue es el brillo (un deep house es oscuro, un peak-time techno brillante) y el tempo
 * dentro del rango de baile. La curva final (^1,3) reserva los valores altos para pistas que
 * puntúan alto en casi todo. Referencia: «Frink - Deeply» (deep house, 124 BPM, energía baja) → 4.
 */
export function energyFromFeatures({ loudnessDb, onsetsPerSec, centroidHz, fullness, bpm }) {
  const L = clamp01((loudnessDb + 22) / 16);
  const D = clamp01((onsetsPerSec - 2) / 7);
  const C = clamp01((centroidHz - 1200) / 2000);
  const B = clamp01((bpm - 110) / 40);
  const F = clamp01(fullness / 0.7);
  const score = 0.2 * L + 0.15 * D + 0.3 * C + 0.2 * B + 0.15 * F;
  const level = Math.max(1, Math.min(10, Math.round(1 + 9 * score ** 1.3)));
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    level,
    score: r2(score),
    loudnessDb: Math.round(loudnessDb * 10) / 10,
    onsetsPerSec: Math.round(onsetsPerSec * 10) / 10,
    centroidHz: Math.round(centroidHz),
    fullness: r2(fullness),
    parts: { L: r2(L), D: r2(D), C: r2(C), B: r2(B), F: r2(F) },
    weights: { L: 20, D: 15, C: 30, B: 20, F: 15 },
  };
}

// --------------------------------------------------------- Cue points ----

function detectCues(grid, duration, maxCues = 8) {
  const { beats, downbeat, beatLoud, beatLow } = grid;
  if (!beats.length) return [{ time: 0, label: 'Inicio', kind: 'intro' }];
  const bars = [];
  for (let i = downbeat; i + 4 <= beats.length; i += 4) {
    let e = 0;
    for (let j = 0; j < 4; j++) e += 0.5 * beatLoud[i + j] + 0.5 * beatLow[i + j];
    bars.push({ beat: i, time: beats[i], e: e / 4 });
  }
  // Primer compás con sonido.
  const peak = Math.max(...bars.map((b) => b.e), -120);
  let startBar = bars.findIndex((b) => b.e > peak - 30);
  if (startBar < 0) startBar = 0;
  const cues = [{ time: bars.length ? bars[startBar].time : beats[0], label: 'Intro', kind: 'intro', bar: startBar }];

  const W = 8;
  const cands = [];
  for (let b = startBar + 2; b < bars.length - 1; b++) {
    const pa = Math.max(startBar, b - W);
    const nb = Math.min(bars.length, b + W);
    if (b - pa < 2 || nb - b < 4) continue;
    let before = 0, after = 0;
    for (let i = pa; i < b; i++) before += bars[i].e;
    for (let i = b; i < nb; i++) after += bars[i].e;
    const nov = after / (nb - b) - before / (b - pa);
    const rel = b - startBar;
    const bonus = rel % 8 === 0 ? 1.3 : rel % 4 === 0 ? 1.12 : 1;
    cands.push({ b, nov, score: Math.abs(nov) * bonus });
  }
  // Solo máximos locales de novedad (±3 compases).
  const byBar = new Map(cands.map((c) => [c.b, c]));
  for (const c of cands) {
    for (let d = -3; d <= 3; d++) {
      const o = byBar.get(c.b + d);
      if (d && o && Math.abs(o.nov) > Math.abs(c.nov)) c.score = 0;
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= maxCues - 1) break;
    if (Math.abs(c.nov) < 1.5) break;
    if (Math.abs(c.b - startBar) < 8) continue;
    if (chosen.some((o) => Math.abs(o.b - c.b) < 8)) continue;
    chosen.push(c);
  }
  chosen.sort((x, y) => x.b - y.b);
  for (const c of chosen) {
    const t = bars[c.b].time;
    let label, kind;
    if (c.nov > 0) {
      if (c.nov >= 4) { label = 'Drop'; kind = 'drop'; }
      else { label = 'Subida'; kind = 'build'; }
    } else if (t > duration * 0.8) { label = 'Outro'; kind = 'outro'; }
    else { label = 'Break'; kind = 'break'; }
    cues.push({ time: t, label, kind, bar: c.b });
  }
  return cues.map((c) => ({ ...c, time: Math.max(0, Math.round(c.time * 1000) / 1000) }));
}

// ----------------------------------------------------- Forma de onda ----

function buildWaveform(x, feat, cols = 1000) {
  const peaks = new Uint8Array(cols);
  const low = new Uint8Array(cols);
  const mid = new Uint8Array(cols);
  const high = new Uint8Array(cols);
  const spc = x.length / cols;
  let gmax = 1e-9;
  const raw = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * spc);
    const b = Math.min(x.length, Math.floor((c + 1) * spc));
    let m = 0;
    for (let i = a; i < b; i++) {
      const v = x[i] < 0 ? -x[i] : x[i];
      if (v > m) m = v;
    }
    raw[c] = m;
    if (m > gmax) gmax = m;
    const fa = Math.max(0, Math.floor(timeFrame(feat, a / feat.sr)));
    const fb = Math.min(feat.n, Math.max(fa + 1, Math.ceil(timeFrame(feat, b / feat.sr))));
    let l = 0, md = 0, h = 0;
    for (let f = fa; f < fb; f++) { l += feat.low[f]; md += feat.mid[f]; h += feat.high[f]; }
    l = Math.sqrt(l); md = Math.sqrt(md) * 1.6; h = Math.sqrt(h) * 4;
    const s = l + md + h || 1;
    low[c] = Math.round((l / s) * 255);
    mid[c] = Math.round((md / s) * 255);
    high[c] = Math.round((h / s) * 255);
  }
  for (let c = 0; c < cols; c++) peaks[c] = Math.round((raw[c] / gmax) * 255);
  return { peaks, low, mid, high };
}

// ------------------------------------------------------------- API ----

/**
 * Analiza una señal mono (Float32Array) y devuelve tonalidad, BPM, energía, cues y forma de onda.
 */
export function analyzeTrack(samples, sampleRate = ANALYSIS_SAMPLE_RATE, onProgress = () => {}) {
  if (samples.length < sampleRate * 3) throw new Error('El audio es demasiado corto (mínimo 3 segundos).');
  const duration = samples.length / sampleRate;
  onProgress(0.01, 'Extrayendo características');
  const feat = shortTimeFeatures(samples, sampleRate, (p) => onProgress(0.01 + p * 0.39, 'Extrayendo características'));
  onProgress(0.4, 'Detectando tempo');
  const tempo = estimateTempo(feat);
  onProgress(0.5, 'Detectando tonalidad');
  const key = estimateKey(samples, sampleRate, (p) => onProgress(0.5 + p * 0.4, 'Detectando tonalidad'));
  onProgress(0.92, 'Calculando energía y cue points');
  const grid = buildBeatGrid(tempo, feat, duration);
  const energy = estimateEnergy(feat, tempo.bpm, duration);
  const cues = detectCues(grid, duration);
  const waveform = buildWaveform(samples, feat);
  onProgress(1, 'Listo');
  return {
    version: 1,
    duration,
    bpm: tempo.bpm,
    bpmConfidence: Math.round(tempo.confidence * 100) / 100,
    key: key && {
      tonic: key.tonic,
      mode: key.mode,
      camelot: camelotCode(key.tonic, key.mode),
      openKey: openKeyCode(key.tonic, key.mode),
      musical: musicalName(key.tonic, key.mode),
      confidence: Math.round(key.confidence * 100) / 100,
      tuningCents: key.tuningCents,
      chroma: key.chroma.map((v) => Math.round(v * 1000) / 1000),
      alternatives: key.alternatives,
    },
    energy: energy.level,
    energyDetail: energy,
    beatGrid: { firstBeat: Math.round(grid.firstBeat * 1000) / 1000, downbeat: grid.downbeat, bpm: grid.bpm },
    cues,
    waveform,
  };
}
