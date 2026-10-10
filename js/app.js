import { ANALYSIS_SAMPLE_RATE, energyFromFeatures } from './dsp.js';
import { formatKey, keyColor, compatibility, fromCamelot, relativeCode, referenceMidi } from './camelot.js';
import { readTags, writeTags, writeContainerTags, readContainerTags } from './id3.js';
import { isAiff, parseAiff, encodeWav } from './aiff.js';
import { makeDemoFiles } from './demo.js';
import { buildRekordboxXml } from './rekordbox.js';
import { buildSet, describeTransition, transitionCost, bpmDistance, pathCost } from './setbuilder.js';

// ------------------------------------------------------------- Estado ----

const STORAGE_KEY = 'keymix.library.v1';
const SETTINGS_KEY = 'keymix.settings.v1';
const TAGGABLE_EXT = /\.(mp3|wav|wave|aif|aiff|aifc)$/i;
const isTaggable = (name) => TAGGABLE_EXT.test(name);
const AUDIO_EXT = /\.(mp3|wav|wave|flac|m4a|mp4|aac|ogg|oga|opus|aif|aiff|webm)$/i;
const CUE_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#60a5fa', '#c084fc'];
const PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const state = {
  tracks: [],
  selectedId: null,
  playingId: null,
  checked: new Set(),
  sort: { key: 'index', dir: 1 },
  search: '',
  compatOnly: false,
  keyFilter: null,
  view: 'library',
  set: [],
  settings: {
    notation: 'camelot',
    tagComment: true,
    tagKeyField: true,
    tagBpm: true,
    tagNotation: 'camelot',
    renamePrefix: false,
    volume: 0.9,
    droneMode: 'chord',
    droneVolume: 0.25,
    rbBasePath: '',
    rbBeatgrid: true,
  },
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const fmtBpm = (b) => (b ? (Number.isInteger(b) ? String(b) : b.toFixed(1)) : '—');
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified || 0}`;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function toast(msg, type = 'info', ms = 4000) {
  const t = el('div', { class: `toast ${type}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// ----------------------------------------------------- Persistencia ----

const b64 = {
  enc(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  },
  dec(str) {
    const s = atob(str);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  },
};

function serializeTrack(t) {
  const r = t.result;
  return {
    id: t.id, fileKey: t.fileKey, name: t.name, relPath: t.relPath || null, title: t.title, artist: t.artist, size: t.size, addedAt: t.addedAt, index: t.index,
    result: { ...r, waveform: Object.fromEntries(Object.entries(r.waveform).map(([k, v]) => [k, b64.enc(v)])) },
  };
}

function deserializeTrack(o) {
  const r = o.result;
  // Recalcula la energía con la fórmula actual si la pista guardó sus medidas.
  const e = r.energyDetail;
  if (e?.centroidHz != null && e.fullness != null) {
    r.energyDetail = energyFromFeatures({ ...e, bpm: r.bpm });
    r.energy = r.energyDetail.level;
  }
  return {
    ...o, status: 'done', progress: 1, file: null, handle: null,
    result: { ...r, waveform: Object.fromEntries(Object.entries(r.waveform).map(([k, v]) => [k, b64.dec(v)])) },
  };
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const data = {
      tracks: state.tracks.filter((t) => t.status === 'done').map(serializeTrack),
      set: state.set,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    console.warn('No se pudo guardar la biblioteca', err);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // almacenamiento no disponible
  }
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) Object.assign(state.settings, s);
  } catch {
    // ignorar
  }
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (data) {
      state.tracks = (data.tracks || []).map(deserializeTrack);
      const ids = new Set(state.tracks.map((t) => t.id));
      state.set = (data.set || []).filter((id) => ids.has(id));
    }
  } catch (err) {
    console.warn('Biblioteca guardada ilegible', err);
  }
}

// ------------------------------------------------------- Análisis ----

const MAX_WORKERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
const workers = [];
const queue = [];
let active = 0;

function getWorker() {
  let w = workers.find((x) => !x.busy);
  if (!w) {
    w = { worker: new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), busy: false };
    workers.push(w);
  }
  w.busy = true;
  return w;
}

function analyzeInWorker(samples, onProgress) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = uid();
    w.worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onProgress(m.progress, m.stage);
      else {
        w.busy = false;
        if (m.type === 'done') resolve(m.result);
        else reject(new Error(m.error));
      }
    };
    w.worker.onerror = (e) => {
      w.busy = false;
      reject(new Error(e.message || 'Error en el worker'));
    };
    w.worker.postMessage({ id, samples, sampleRate: ANALYSIS_SAMPLE_RATE }, [samples.buffer]);
  });
}

const isAiffName = (name) => /\.aiff?$|\.aifc$/i.test(name);

/** Remuestrea con el motor de audio del navegador (filtro antialiasing incluido). */
async function resampleMono(mono, fromRate) {
  if (fromRate === ANALYSIS_SAMPLE_RATE) return mono;
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, Math.ceil((mono.length * ANALYSIS_SAMPLE_RATE) / fromRate), ANALYSIS_SAMPLE_RATE);
  const buf = ctx.createBuffer(1, mono.length, fromRate);
  buf.copyToChannel(mono, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return out.getChannelData(0).slice();
}

/** AIFF: decodificación propia (los navegadores no lo soportan) + WAV en memoria para reproducir. */
async function decodeAiff(arrayBuffer, t) {
  const a = parseAiff(arrayBuffer);
  if (a.id3) {
    const tags = readTags(a.id3.slice().buffer);
    if (tags.title) t.title = tags.title;
    if (tags.artist) t.artist = tags.artist;
  }
  t.playFile = encodeWav(a.channels, a.sampleRate);
  const n = a.channels[0].length;
  const mono = new Float32Array(n);
  for (const ch of a.channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / a.channels.length;
  return resampleMono(mono, a.sampleRate);
}

async function preparePlayback(t) {
  if (t.playFile || !t.file || !isAiffName(t.name)) return;
  try {
    const a = parseAiff(await t.file.arrayBuffer());
    t.playFile = encodeWav(a.channels, a.sampleRate);
  } catch (err) {
    console.warn('No se pudo preparar el AIFF para reproducir', err);
  }
}

async function decodeToMono(arrayBuffer) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, ANALYSIS_SAMPLE_RATE);
  const buf = await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(arrayBuffer, res, rej);
    if (p && p.then) p.then(res, rej);
  });
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  if (buf.sampleRate !== ANALYSIS_SAMPLE_RATE) throw new Error('El navegador no remuestreó el audio');
  return out;
}

function guessFromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = /^(?:\d+[\s.-]+)?(.+?)\s+[-–]\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

async function processTrack(t) {
  try {
    t.status = 'decoding';
    t.stage = 'Decodificando';
    scheduleRender();
    const ab = await t.file.arrayBuffer();
    if (/\.(mp3|wav|wave)$/i.test(t.name)) {
      const tags = /\.mp3$/i.test(t.name) ? readTags(ab) : readContainerTags(ab);
      if (tags.title) t.title = tags.title;
      if (tags.artist) t.artist = tags.artist;
    }
    const mono = isAiff(ab) ? await decodeAiff(ab, t) : await decodeToMono(ab);
    t.status = 'analyzing';
    t.stage = 'Analizando';
    scheduleRender();
    t.result = await analyzeInWorker(mono, (p, stage) => {
      t.progress = p;
      t.stage = stage;
      scheduleRender(true);
    });
    t.status = 'done';
    t.progress = 1;
    save();
  } catch (err) {
    console.error(err);
    t.status = 'error';
    t.error = /decod|Unable|EncodingError|null/i.test(err.message || '')
      ? 'Formato no soportado por este navegador'
      : err.message;
  }
  scheduleRender();
}

function pump() {
  while (active < MAX_WORKERS && queue.length) {
    const t = queue.shift();
    active++;
    processTrack(t).finally(() => {
      active--;
      pump();
      if (!active && !queue.length) {
        const done = state.tracks.filter((x) => x.status === 'done').length;
        toast(`Análisis completado · ${done} pistas en la biblioteca`);
      }
    });
  }
  renderQueueStatus();
}

// Ruta relativa de cada archivo dentro de la carpeta abierta o arrastrada (para rekordbox XML).
const filePaths = new WeakMap();

function addFiles(files, handles = []) {
  const list = [...files].filter((f) => AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
  if (!list.length) {
    toast('No se encontraron archivos de audio', 'error');
    return;
  }
  let cached = 0;
  list.forEach((file, i) => {
    const key = fileKey(file);
    const existing = state.tracks.find((t) => t.fileKey === key);
    if (existing) {
      // Ya analizada: solo se vuelve a vincular el archivo (para reproducir/etiquetar).
      existing.file = file;
      existing.playFile = null;
      existing.handle = handles[i] || existing.handle;
      existing.relPath = filePaths.get(file) || existing.relPath || null;
      preparePlayback(existing);
      if (existing.status === 'error') {
        existing.status = 'queued';
        queue.push(existing);
      } else cached++;
      return;
    }
    const guess = guessFromFilename(file.name);
    const t = {
      id: uid(),
      fileKey: key,
      name: file.name,
      title: guess.title,
      artist: guess.artist,
      size: file.size,
      addedAt: Date.now(),
      index: state.tracks.length + 1,
      status: 'queued',
      progress: 0,
      file,
      handle: handles[i] || null,
      relPath: filePaths.get(file) || null,
      result: null,
    };
    state.tracks.push(t);
    queue.push(t);
  });
  if (cached) toast(`${cached} pista(s) ya estaban analizadas: se han vuelto a vincular`);
  if (!state.selectedId && state.tracks.length) state.selectedId = state.tracks[0].id;
  pump();
  scheduleRender();
}

async function openFolder() {
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    const files = [];
    const handles = [];
    async function walk(d, depth, prefix) {
      for await (const entry of d.values()) {
        if (entry.kind === 'file' && AUDIO_EXT.test(entry.name)) {
          const file = await entry.getFile();
          filePaths.set(file, prefix + entry.name);
          handles.push(entry);
          files.push(file);
        } else if (entry.kind === 'directory' && depth < 4) await walk(entry, depth + 1, `${prefix}${entry.name}/`);
      }
    }
    await walk(dir, 0, '');
    addFiles(files, handles);
  } catch (err) {
    if (err.name !== 'AbortError') toast(`No se pudo abrir la carpeta: ${err.message}`, 'error');
  }
}

// --------------------------------------------------------- Consultas ----

const done = () => state.tracks.filter((t) => t.status === 'done' && t.result);
const byId = (id) => state.tracks.find((t) => t.id === id);
const camelotOf = (t) => t.result?.key?.camelot || null;
const keyText = (t, notation = state.settings.notation) =>
  t.result?.key ? formatKey(t.result.key.tonic, t.result.key.mode, notation) : '—';
const keyBg = (code, alpha = 1) => {
  const p = /^(\d+)([AB])$/.exec(code || '');
  return p ? keyColor(Number(p[1]), p[2], alpha) : 'var(--bg-3)';
};
const asSetItem = (t) => ({ id: t.id, camelot: camelotOf(t), bpm: t.result.bpm, energy: t.result.energy });

function relation(base, t) {
  if (!base || base.id === t.id || !camelotOf(base) || !camelotOf(t)) return null;
  const k = compatibility(camelotOf(base), camelotOf(t));
  if (k.type === 'clash') return null;
  if (bpmDistance(base.result.bpm, t.result.bpm) > 6) return null;
  return k;
}

function visibleTracks() {
  const q = state.search.trim().toLowerCase();
  const sel = byId(state.selectedId);
  let list = state.tracks.filter((t) => {
    if (q) {
      const hay = `${t.title} ${t.artist} ${t.name} ${t.result ? `${keyText(t, 'camelot')} ${keyText(t, 'openkey')} ${keyText(t, 'musical')} ${fmtBpm(t.result.bpm)}` : ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.keyFilter && camelotOf(t) !== state.keyFilter) return false;
    if (state.compatOnly && sel?.result && t.id !== sel.id && !(t.result && relation(sel, t))) return false;
    return true;
  });
  const { key, dir } = state.sort;
  const val = (t) => {
    switch (key) {
      case 'title': return `${t.title} ${t.artist}`.toLowerCase();
      case 'key': {
        const c = /^(\d+)([AB])$/.exec(camelotOf(t) || '');
        return c ? Number(c[1]) * 2 + (c[2] === 'B' ? 1 : 0) : 999;
      }
      case 'bpm': return t.result?.bpm ?? 9999;
      case 'energy': return t.result?.energy ?? 99;
      case 'duration': return t.result?.duration ?? 1e9;
      default: return t.index;
    }
  };
  list = [...list].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
  return list;
}

// ------------------------------------------------------------ Render ----

let renderPending = false;
let lightRender = false;
function scheduleRender(light = false) {
  lightRender = renderPending ? lightRender && light : light;
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (lightRender) renderProgressOnly();
    else render();
  });
}

function render() {
  renderTable();
  renderWheel();
  renderDetails();
  renderPlayerInfo();
  renderQueueStatus();
  if (state.view === 'set') renderSet();
  drawWaveform();
}

function energyBar(level) {
  const color = `hsl(${140 - (level - 1) * 15}, 75%, 55%)`;
  const bar = el('span', { class: 'energy-bar', style: `--e-color:${color}`, title: `Energía ${level}/10` });
  for (let i = 1; i <= 10; i++) bar.append(el('i', { class: i <= level ? 'on' : '' }));
  bar.append(el('b', {}, level));
  return bar;
}

function keyChip(t, cls = '') {
  const code = camelotOf(t);
  return el('span', { class: `key-chip ${cls}`, style: `background:${keyBg(code)}` }, keyText(t));
}

function statusCell(t) {
  if (t.status === 'done') return el('span', { class: 'status' }, t.file ? '✓ Analizada' : '✓ En caché');
  if (t.status === 'error') return el('span', { class: 'status error', title: t.error }, `✕ ${t.error}`);
  const label = t.status === 'queued' ? 'En cola' : t.stage || 'Analizando';
  return el('div', {}, el('span', { class: 'status' }, label),
    el('div', { class: 'progress' }, el('div', { style: `width:${Math.round((t.progress || 0) * 100)}%`, 'data-progress': t.id })));
}

function renderTable() {
  const body = $('#track-body');
  const list = visibleTracks();
  const sel = byId(state.selectedId);
  body.replaceChildren(
    ...list.map((t) => {
      const rel = sel?.result && t.result ? relation(sel, t) : null;
      const tr = el('tr', {
        'data-id': t.id,
        class: [t.id === state.selectedId && 'selected', t.id === state.playingId && 'playing'].filter(Boolean).join(' '),
      },
      el('td', { class: 'c-check' }, el('input', { type: 'checkbox', 'data-check': t.id, checked: state.checked.has(t.id) })),
      el('td', { class: 'c-num' }, t.index),
      el('td', {},
        el('div', { class: 't-title', title: t.name }, rel ? el('span', { class: `compat-dot compat-${rel.type}`, title: rel.label }) : null, t.title),
        el('div', { class: 't-artist' }, t.artist || t.name)),
      el('td', { class: 'c-key' }, t.result?.key ? keyChip(t) : '—'),
      el('td', { class: 'c-bpm' }, t.result ? fmtBpm(t.result.bpm) : '—'),
      el('td', { class: 'c-energy' }, t.result ? energyBar(t.result.energy) : '—'),
      el('td', { class: 'c-dur' }, t.result ? fmtTime(t.result.duration) : '—'),
      el('td', { class: 'c-status' }, statusCell(t)));
      return tr;
    }),
  );
  $('#empty-state').hidden = state.tracks.length > 0;
  $('#track-count').textContent = state.tracks.length
    ? `${list.length} de ${state.tracks.length} pistas${state.checked.size ? ` · ${state.checked.size} marcadas` : ''}`
    : '';
  document.querySelectorAll('.tracks th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.classList.toggle('desc', th.dataset.sort === state.sort.key && state.sort.dir < 0);
  });
  const chip = $('#key-filter-chip');
  chip.hidden = !state.keyFilter;
  if (state.keyFilter) {
    const k = fromCamelot(state.keyFilter);
    chip.textContent = `Tono: ${formatKey(k.tonic, k.mode, state.settings.notation)} ✕`;
  }
  $('#check-all').checked = list.length > 0 && list.every((t) => state.checked.has(t.id));
}

function renderProgressOnly() {
  for (const t of state.tracks) {
    if (t.status !== 'analyzing') continue;
    const bar = document.querySelector(`[data-progress="${t.id}"]`);
    if (!bar) return render();
    bar.style.width = `${Math.round((t.progress || 0) * 100)}%`;
    const label = bar.parentElement?.previousElementSibling;
    if (label) label.textContent = t.stage || 'Analizando';
  }
  renderQueueStatus();
}

function renderQueueStatus() {
  const pending = state.tracks.filter((t) => t.status === 'queued' || t.status === 'decoding' || t.status === 'analyzing').length;
  $('#queue-status').textContent = pending ? `Analizando… ${pending} pendiente(s)` : '';
}

// --------------------------------------------------- Rueda Camelot ----

function sector(r0, r1, a0, a1) {
  const p = (r, a) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
  return `M${p(r1, a0)} A${r1} ${r1} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
}

function renderWheel() {
  const svg = $('#wheel');
  const sel = byId(state.selectedId);
  const selCode = camelotOf(sel || {});
  const counts = {};
  for (const t of done()) counts[camelotOf(t)] = (counts[camelotOf(t)] || 0) + 1;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const nodes = [];
  for (let n = 1; n <= 12; n++) {
    const a0 = ((n % 12) - 0.5) * (Math.PI / 6);
    const a1 = a0 + Math.PI / 6;
    const am = (a0 + a1) / 2;
    for (const [l, r0, r1] of [['B', 70, 104], ['A', 38, 70]]) {
      const code = `${n}${l}`;
      let opacity = 0.35;
      if (selCode) {
        const rel = compatibility(selCode, code);
        opacity = code === selCode ? 1 : rel.type === 'perfect' ? 0.85 : rel.type !== 'clash' ? 0.6 : 0.15;
      } else if (counts[code]) opacity = 0.9;
      if (state.keyFilter === code) opacity = 1;
      const path = mk('path', {
        d: sector(r0, r1, a0 + 0.008, a1 - 0.008),
        fill: keyColor(n, l),
        class: 'seg',
        'data-code': code,
        style: `opacity:${opacity}`,
        stroke: code === selCode || code === state.keyFilter ? 'var(--text)' : 'none',
        'stroke-width': 2,
      });
      const k = fromCamelot(code);
      path.append(mk('title', {}, `${code} · ${formatKey(k.tonic, k.mode, 'musical')} · ${formatKey(k.tonic, k.mode, 'openkey')} — ${counts[code] || 0} pista(s)`));
      nodes.push(path);
      const rm = (r0 + r1) / 2;
      const label = formatKey(k.tonic, k.mode, state.settings.notation);
      nodes.push(mk('text', { x: rm * Math.sin(am), y: -rm * Math.cos(am) - (counts[code] ? 3 : 0) }, label));
      if (counts[code]) nodes.push(mk('text', { class: 'count', x: rm * Math.sin(am), y: -rm * Math.cos(am) + 6 }, counts[code]));
    }
  }
  nodes.push(mk('circle', { r: 36, fill: 'var(--bg-2)' }));
  if (sel?.result?.key) {
    nodes.push(mk('text', { class: 'center-label', y: -4 }, keyText(sel)));
    nodes.push(mk('text', { class: 'center-sub', y: 10 }, `${fmtBpm(sel.result.bpm)} BPM`));
  } else {
    nodes.push(mk('text', { class: 'center-sub', y: 0 }, 'Camelot'));
  }
  svg.replaceChildren(...nodes);
}

// ----------------------------------------------------------- Detalle ----

function suggestions(base, limit = 8) {
  if (!base?.result?.key) return [];
  const a = asSetItem(base);
  return done()
    .filter((t) => t.id !== base.id && relation(base, t))
    .map((t) => ({ t, cost: transitionCost(a, asSetItem(t)), rel: relation(base, t) }))
    .sort((x, y) => x.cost - y.cost)
    .slice(0, limit);
}

function renderDetails() {
  const box = $('#details');
  const t = byId(state.selectedId);
  if (!t) {
    box.replaceChildren(el('p', { class: 'muted' }, 'Selecciona una pista para ver su análisis.'));
    return;
  }
  const head = [el('h3', {}, t.title), el('div', { class: 'artist' }, t.artist || t.name)];
  if (!t.result) {
    box.replaceChildren(...head, statusCell(t));
    return;
  }
  const r = t.result;
  const k = r.key;
  const s = state.settings;
  const tonicPc = k ? k.tonic : -1;

  const cueList = el('ul', { class: 'cue-list' },
    r.cues.map((c, i) =>
      el('li', { onclick: () => jumpToCue(t, i) },
        el('span', { class: 'cue-num', style: `background:${CUE_COLORS[i]}` }, i + 1),
        el('span', {}, c.label),
        el('span', { class: 'cue-time' }, `${fmtTime(c.time)}${c.bar != null ? ` · compás ${c.bar + 1}` : ''}`))));

  const sugg = suggestions(t);
  const suggList = sugg.length
    ? el('ul', { class: 'suggest-list' },
      sugg.map(({ t: o, rel }) =>
        el('li', { onclick: () => select(o.id, true), title: rel.label },
          el('span', { class: `compat-dot compat-${rel.type}` }),
          keyChip(o),
          el('span', { class: 's-title' }, o.title),
          el('span', { class: 's-meta' }, `${fmtBpm(o.result.bpm)} · E${o.result.energy}`))))
    : el('p', { class: 'muted' }, 'No hay pistas compatibles en la biblioteca todavía.');

  const taggable = isTaggable(t.name);
  const canSaveInPlace = !!t.handle && !s.renamePrefix;
  const opt = (key, label) =>
    el('label', {}, el('input', {
      type: 'checkbox', checked: s[key],
      onchange: (e) => { s[key] = e.target.checked; saveSettings(); },
    }), label);

  const tagBox = el('div', { class: 'tag-box' },
    opt('tagComment', `Comentario («${tagKeyString(t)} - Energy ${r.energy}»)`),
    opt('tagKeyField', 'Campo de tonalidad (TKEY)'),
    opt('tagBpm', 'Campo BPM (TBPM)'),
    opt('renamePrefix', 'Añadir tonalidad y BPM al nombre (descarga)'),
    el('label', {}, 'Notación en etiquetas',
      el('select', { onchange: (e) => { s.tagNotation = e.target.value; saveSettings(); renderDetails(); } },
        ['camelot', 'openkey', 'musical'].map((n) => el('option', { value: n, selected: s.tagNotation === n }, { camelot: 'Camelot', openkey: 'Open Key', musical: 'Musical' }[n])))),
    el('button', {
      class: 'btn primary', disabled: !taggable || !t.file,
      title: !taggable ? 'Las etiquetas se pueden escribir en MP3, AIFF y WAV' : !t.file ? 'Vuelve a añadir el archivo para poder etiquetarlo' : '',
      onclick: () => tagTrack(t),
    }, canSaveInPlace ? 'Guardar etiquetas en el archivo original' : 'Descargar copia etiquetada'),
    'showDirectoryPicker' in window && taggable && t.file
      ? el('button', { class: 'btn', onclick: () => copyTaggedToFolder(t) }, 'Guardar copia etiquetada en otra carpeta…')
      : null,
    el('p', { class: 'hint' }, !taggable
      ? 'Este formato no admite etiquetas desde la app (solo MP3, AIFF y WAV).'
      : canSaveInPlace
        ? 'Se escribe un bloque ID3 dentro del archivo. El audio no se modifica.'
        : 'Se descargará una copia con el mismo formato y el audio intacto. Para guardar en tus archivos originales, ábrelos con «Abrir carpeta» (Chrome o Edge).'));

  box.replaceChildren(
    ...head,
    el('div', { class: 'key-row' },
      k ? keyChip(t, 'lg') : el('span', { class: 'key-chip lg' }, '?'),
      k ? el('div', { class: 'key-alt' },
        el('div', {}, 'Camelot ', el('b', {}, k.camelot), ' · Open Key ', el('b', {}, k.openKey)),
        el('div', {}, 'Tonalidad ', el('b', {}, `${k.musical} ${k.mode === 'major' ? '(mayor)' : '(menor)'}`)),
        el('div', {}, `Confianza ${Math.round(k.confidence * 100)}%`, k.alternatives?.length ? ` · alt. ${k.alternatives.join(', ')}` : ''),
        k.tuningCents ? el('div', {}, `Afinación ${k.tuningCents > 0 ? '+' : ''}${k.tuningCents} cents`) : null) : null),
    k ? el('div', { class: 'section-title' }, 'Comprobar a oído') : null,
    k ? droneBox(t) : null,
    el('div', { class: 'stats' },
      el('div', { class: 'stat' }, el('div', { class: 'v' }, fmtBpm(r.bpm)), el('div', { class: 'l' }, 'BPM')),
      el('div', { class: 'stat' }, el('div', { class: 'v' }, r.energy), el('div', { class: 'l' }, 'Energía')),
      el('div', { class: 'stat' }, el('div', { class: 'v' }, fmtTime(r.duration)), el('div', { class: 'l' }, 'Duración'))),
    energyBar(r.energy),
    el('div', { class: 'section-title' }, 'Perfil tonal (cromagrama)'),
    el('div', { class: 'chroma' }, (k?.chroma || []).map((v, i) =>
      el('div', { class: i === tonicPc ? 'tonic' : '', style: `height:${Math.max(3, v * 100)}%`, title: `${PITCHES[i]}: ${Math.round(v * 100)}%` }))),
    el('div', { class: 'chroma-labels' }, PITCHES.map((p) => el('span', {}, p))),
    el('div', { class: 'section-title' }, 'Cue points'),
    cueList,
    el('div', { class: 'section-title' }, 'Mezclan bien a continuación'),
    suggList,
    el('div', { class: 'section-title' }, 'Escribir etiquetas (MP3, AIFF, WAV)'),
    tagBox,
    el('div', { class: 'section-title' }, 'Cómo se calculó la energía'),
    energyBreakdown(r),
  );
}

function energyBreakdown(r) {
  const e = r.energyDetail || {};
  if (!e.parts) {
    return el('p', { class: 'hint' }, `Volumen activo ${e.loudnessDb ?? '?'} dBFS · ${e.onsetsPerSec ?? '?'} ataques/s. Vuelve a analizar la pista (Vaciar biblioteca y añadirla de nuevo) para ver el desglose completo.`);
  }
  const w = e.weights || { L: 40, D: 15, C: 15, B: 15, F: 15 };
  const rows = [
    ['Volumen', `${e.loudnessDb} dBFS`, e.parts.L, w.L],
    ['Golpes', `${e.onsetsPerSec} /s`, e.parts.D, w.D],
    ['Brillo', `${e.centroidHz} Hz`, e.parts.C, w.C],
    ['Tempo', `${fmtBpm(r.bpm)} BPM`, e.parts.B, w.B],
    ['Plenitud', `${Math.round(e.fullness * 100)} %`, e.parts.F, w.F],
  ];
  return el('div', { class: 'energy-breakdown' },
    rows.map(([name, raw, part, w]) => el('div', { class: 'eb-row', title: `Aporta ${(part * w / 100).toFixed(3)} a la puntuación (peso ${w} %)` },
      el('span', { class: 'eb-name' }, `${name} ${w} %`),
      el('span', { class: 'eb-raw' }, raw),
      el('span', { class: 'eb-bar' }, el('i', { style: `width:${Math.round(part * 100)}%` })),
      el('span', { class: 'eb-val' }, part.toFixed(2)))),
    el('div', { class: 'eb-total' }, `Puntuación ${e.score.toFixed(2)} → energía ${r.energy}`));
}

// ------------------------------------------------- Tono de referencia ----
// Un acorde o nota suave que suena encima de la canción para comprobar la tonalidad a oído.

const drone = { ctx: null, master: null, voices: [], code: null };

function startDrone(code) {
  stopDrone();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return toast('Este navegador no permite generar sonido', 'error');
  if (!drone.ctx) drone.ctx = new Ctx();
  const ctx = drone.ctx;
  ctx.resume?.();
  const master = ctx.createGain();
  master.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  master.connect(lp);
  lp.connect(ctx.destination);
  const voices = referenceMidi(code, state.settings.droneMode).map((m, i) => {
    const o = ctx.createOscillator();
    o.type = i === 0 ? 'sine' : 'triangle';
    o.frequency.value = 440 * 2 ** ((m - 69) / 12);
    const g = ctx.createGain();
    g.gain.value = i === 0 ? 0.55 : 0.3;
    o.connect(g);
    g.connect(master);
    o.start();
    return o;
  });
  master.gain.setTargetAtTime(state.settings.droneVolume, ctx.currentTime, 0.08); // entrada suave, sin clics
  Object.assign(drone, { master, voices, code });
}

function stopDrone() {
  const { ctx, master, voices } = drone;
  if (ctx && master) {
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    for (const o of voices) o.stop(ctx.currentTime + 0.3);
  }
  Object.assign(drone, { master: null, voices: [], code: null });
}

function toggleDrone(code) {
  if (drone.code === code) stopDrone();
  else startDrone(code);
  renderDroneButtons();
}

function renderDroneButtons() {
  document.querySelectorAll('[data-drone]').forEach((b) => {
    const on = b.dataset.drone === drone.code;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
}

/** Tonalidades a comparar: la detectada, sus alternativas y su relativa. */
function droneCandidates(k) {
  return [...new Set([k.camelot, ...(k.alternatives || []), relativeCode(k.camelot)])].filter(Boolean);
}

function droneBox(t) {
  const k = t.result.key;
  const s = state.settings;
  const name = (code) => {
    const c = fromCamelot(code);
    return formatKey(c.tonic, c.mode, s.notation);
  };
  const label = (code, i) => (i === 0 ? 'detectada' : code === relativeCode(k.camelot) ? 'relativa' : 'alternativa');
  return el('div', { class: 'drone-box' },
    el('div', { class: 'drone-keys' }, droneCandidates(k).map((code, i) => {
      const c = fromCamelot(code);
      return el('button', {
        class: `drone-btn ${drone.code === code ? 'on' : ''}`,
        'data-drone': code,
        'aria-pressed': drone.code === code,
        style: `--k:${keyBg(code)}`,
        title: `${formatKey(c.tonic, c.mode, 'musical')} ${c.mode === 'major' ? 'mayor' : 'menor'} · pulsa para escucharla encima de la canción`,
        onclick: () => toggleDrone(code),
      }, el('b', {}, name(code)), el('small', {}, label(code, i)));
    })),
    el('div', { class: 'drone-controls' },
      el('label', {}, 'Sonido ',
        el('select', {
          id: 'drone-mode',
          onchange: (e) => {
            s.droneMode = e.target.value;
            saveSettings();
            if (drone.code) startDrone(drone.code);
          },
        }, el('option', { value: 'chord', selected: s.droneMode === 'chord' }, 'Acorde'),
        el('option', { value: 'note', selected: s.droneMode === 'note' }, 'Solo la tónica'))),
      el('label', {}, 'Volumen ',
        el('input', {
          id: 'drone-volume', type: 'range', min: 0.02, max: 0.6, step: 0.01, value: s.droneVolume,
          oninput: (e) => {
            s.droneVolume = Number(e.target.value);
            saveSettings();
            if (drone.master) drone.master.gain.setTargetAtTime(s.droneVolume, drone.ctx.currentTime, 0.05);
          },
        }))),
    el('details', { class: 'drone-help' },
      el('summary', {}, 'Cómo usarlo'),
      el('ol', {},
        el('li', {}, 'Reproduce la canción en una parte con armonía: salta a un cue de Drop o Break (teclas 1–8). Evita las intros de solo percusión.'),
        el('li', {}, 'Pulsa la tonalidad «detectada». Suena un acorde suave encima de la música (tecla T).'),
        el('li', {}, 'Si es la correcta, el acorde se funde con la canción y suena estable, «en casa». Si no lo es, notarás roces, tensión o un batido que ondula.'),
        el('li', {}, 'Pulsa las otras opciones para comparar y quédate con la que mejor encaje. Vuelve a pulsar para apagar.')),
      el('p', {}, 'Consejo: «Solo la tónica» ayuda a encontrar la nota central; «Acorde» ayuda a distinguir mayor de menor, por ejemplo 8A frente a 8B, que comparten las mismas notas.')));
}

// -------------------------------------------------------- Etiquetas ----

function tagKeyString(t) {
  const k = t.result.key;
  return k ? formatKey(k.tonic, k.mode, state.settings.tagNotation) : '';
}

function downloadBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Diálogos propios: algunos entornos (iframes aislados) bloquean confirm() y las descargas.
function openDialog(title, body, buttons) {
  return new Promise((resolve) => {
    const close = (v) => { overlay.remove(); resolve(v); };
    const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(false); } },
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('h3', {}, title), body,
        el('div', { class: 'modal-actions' }, buttons.map((b) =>
          el('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: () => (b.action ? b.action(close) : close(b.value)) }, b.label)))));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
    document.body.append(overlay);
    overlay.querySelector('.modal-actions .btn:last-child')?.focus();
  });
}

function confirmDialog(title, message, okLabel = 'Aceptar', danger = false) {
  return openDialog(title, el('p', {}, message), [
    { label: 'Cancelar', value: false },
    { label: okLabel, value: true, primary: !danger, danger },
  ]);
}

/** Muestra un texto exportable con opciones de copiar y descargar. */
function exportText(text, filename, type) {
  const area = el('textarea', { class: 'export-text', readonly: true, id: 'export-text', 'aria-label': filename });
  area.value = text;
  return openDialog(filename, el('div', {}, area), [
    { label: 'Cerrar', value: false },
    { label: 'Descargar', action: () => downloadBlob(new Blob([type.startsWith('text/csv') ? '\ufeff' + text : text], { type }), filename) },
    {
      label: 'Copiar', primary: true, action: (close) => {
        navigator.clipboard.writeText(text).then(() => { toast('Copiado al portapapeles'); close(true); }, () => {
          area.focus();
          area.select();
          toast('Selecciona el texto y cópialo con Ctrl+C');
        });
      },
    },
  ]);
}

function tagValues(t) {
  const s = state.settings;
  const keyStr = tagKeyString(t);
  const values = {};
  if (s.tagKeyField && keyStr) values.key = keyStr;
  if (s.tagBpm && t.result.bpm) values.bpm = Math.round(t.result.bpm);
  if (s.tagComment) values.comment = `${keyStr} - Energy ${t.result.energy}`;
  return values;
}

/** Nombre del archivo etiquetado (con prefijo «8A - 124 - » si está activada la opción). */
function taggedName(t) {
  if (!state.settings.renamePrefix) return t.name;
  return `${tagKeyString(t)} - ${fmtBpm(Math.round(t.result.bpm))} - ${t.name}`.replace(/[\\/:*?"<>|]/g, '_');
}

/** Lee el archivo original (sin modificarlo) y devuelve un Blob con la copia etiquetada. */
async function buildTaggedBlob(t, values) {
  // MP3: etiqueta al principio. AIFF/WAV: bloque ID3 dentro del archivo; el audio se copia tal cual.
  const ab = await t.file.arrayBuffer();
  return /\.mp3$/i.test(t.name) ? writeTags(ab, values) : writeContainerTags(ab, values);
}

async function tagTrack(t, { quiet = false, forceDownload = false } = {}) {
  const s = state.settings;
  const values = tagValues(t);
  if (!Object.keys(values).length && !s.renamePrefix) {
    toast('Activa al menos una opción de etiquetado', 'error');
    return false;
  }
  try {
    const blob = await buildTaggedBlob(t, values);
    if (t.handle && !s.renamePrefix && !forceDownload) {
      if ((await t.handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
        const p = await t.handle.requestPermission?.({ mode: 'readwrite' });
        if (p && p !== 'granted') throw new Error('Permiso de escritura denegado');
      }
      const w = await t.handle.createWritable();
      await w.write(blob);
      await w.close();
      t.file = await t.handle.getFile();
      t.fileKey = fileKey(t.file);
      save();
      if (!quiet) toast(`Etiquetas guardadas en «${t.name}»`);
    } else {
      const name = taggedName(t);
      downloadBlob(blob, name);
      if (!quiet) toast(`Descargado «${name}»`);
    }
    return true;
  } catch (err) {
    toast(`No se pudo etiquetar «${t.name}»: ${err.message}`, 'error', 6000);
    return false;
  }
}

async function tagAll() {
  const list = done().filter((t) => isTaggable(t.name) && t.file);
  if (!list.length) {
    toast('No hay archivos MP3, AIFF o WAV vinculados para etiquetar (vuelve a añadirlos)', 'error');
    return;
  }
  const inPlace = list.every((t) => t.handle) && !state.settings.renamePrefix;
  const msg = inPlace
    ? `Se escribirán las etiquetas dentro de ${list.length} archivo(s) originales. El audio no se modifica.`
    : `Se descargarán ${list.length} copias etiquetadas. Para escribir en los originales usa «Abrir carpeta» (Chrome/Edge).`;
  if (!(await confirmDialog('Etiquetar todos', msg, inPlace ? 'Escribir etiquetas' : 'Descargar'))) return;
  let ok = 0;
  for (const t of list) {
    if (await tagTrack(t, { quiet: true })) ok++;
    toast(`Etiquetando… ${ok} de ${list.length}`, 'info', 1200);
  }
  toast(`${ok} de ${list.length} archivos etiquetados`);
}

/** Primer nombre libre en la carpeta: «x.aiff», «x (2).aiff», «x (3).aiff»… Nunca sobrescribe. */
async function freeName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${base} (${i})${ext}`;
    try {
      await dir.getFileHandle(candidate); // existe: probar el siguiente
    } catch (err) {
      if (err.name === 'NotFoundError') return candidate;
      throw err;
    }
  }
  throw new Error('Demasiados archivos con el mismo nombre');
}

/**
 * Escribe copias etiquetadas en otra carpeta. Los originales solo se leen.
 * Usa las pistas marcadas; si no hay ninguna marcada, la pista indicada o todas.
 */
async function copyTaggedToFolder(only = null) {
  const marked = done().filter((t) => state.checked.has(t.id));
  const pool = only ? [only] : marked.length ? marked : done();
  const list = pool.filter((t) => isTaggable(t.name) && t.file);
  const skipped = pool.length - list.length;
  if (!list.length) {
    toast('No hay pistas MP3, AIFF o WAV con archivo vinculado (vuelve a añadirlas)', 'error');
    return;
  }
  if (!Object.keys(tagValues(list[0])).length && !state.settings.renamePrefix) {
    toast('Activa al menos una opción de etiquetado en el panel de la pista', 'error');
    return;
  }
  if (!('showDirectoryPicker' in window)) {
    const ok = await confirmDialog('Copiar etiquetadas',
      `Este navegador no permite elegir una carpeta de destino. Se descargarán ${list.length} copia(s) etiquetada(s) en tu carpeta de descargas. Para elegir carpeta usa Chrome o Edge.`, 'Descargar');
    if (!ok) return;
    for (const t of list) downloadBlob(await buildTaggedBlob(t, tagValues(t)), taggedName(t));
    return;
  }
  const scope = only ? `«${only.title}»` : marked.length ? `las ${list.length} pistas marcadas` : `las ${list.length} pistas de la biblioteca`;
  const go = await confirmDialog('Copiar etiquetadas a otra carpeta',
    `Se guardará una copia etiquetada de ${scope} en la carpeta que elijas, con el mismo formato y el audio intacto. Tus archivos originales no se modifican y no se sobrescribe nada en el destino.${skipped ? ` Se omitirán ${skipped} pista(s) sin archivo vinculado o en un formato sin etiquetas.` : ''}`,
    'Elegir carpeta');
  if (!go) return;
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'keymix-destino', mode: 'readwrite', startIn: 'music' });
  } catch (err) {
    if (err.name !== 'AbortError') toast(`No se pudo abrir la carpeta: ${err.message}`, 'error');
    return;
  }
  let ok = 0;
  const renamed = [];
  const failed = [];
  for (const t of list) {
    try {
      const blob = await buildTaggedBlob(t, tagValues(t));
      const wanted = taggedName(t);
      const name = await freeName(dir, wanted);
      if (name !== wanted) renamed.push(name);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      ok++;
      if (list.length > 1) toast(`Copiando… ${ok} de ${list.length}`, 'info', 1200);
    } catch (err) {
      failed.push(`${t.name}: ${err.message}`);
    }
  }
  toast(`${ok} copia(s) etiquetada(s) guardada(s) en «${dir.name}»${renamed.length ? ` · ${renamed.length} renombrada(s) para no sobrescribir` : ''}`, 'info', 6000);
  if (failed.length) toast(`No se pudieron copiar ${failed.length}: ${failed.slice(0, 3).join(' · ')}`, 'error', 9000);
}

// --------------------------------------------------- Rekordbox XML ----

async function exportRekordbox() {
  const marked = done().filter((t) => state.checked.has(t.id));
  const list = marked.length ? marked : done();
  if (!list.length) return toast('La biblioteca está vacía', 'error');
  const s = state.settings;
  const hasSub = list.some((t) => t.relPath?.includes('/'));
  const path = el('input', {
    id: 'rb-path', type: 'text', value: s.rbBasePath || '', placeholder: 'F:\\06_Musica\\Etiquetadas',
    style: 'width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text)',
  });
  const chk = (id, label, checked, note) => el('label', { style: 'display:flex;gap:8px;align-items:flex-start;font-size:13px' },
    el('input', { type: 'checkbox', id, checked }), el('span', {}, label, note ? el('br') : null, note ? el('small', { class: 'muted' }, note) : null));
  const body = el('div', { style: 'display:grid;gap:10px' },
    el('p', {}, `Se exportarán ${list.length} ${marked.length ? 'pistas marcadas' : 'pistas'} con sus cue points, tonalidad, BPM y comentario.`),
    el('label', { style: 'display:grid;gap:4px;font-size:13px' },
      'Carpeta donde están los archivos que vas a cargar en Rekordbox (cópiala de la barra de direcciones del Explorador):', path),
    hasSub ? chk('rb-sub', 'Respetar subcarpetas', true, 'Desmárcalo si los archivos están todos juntos, por ejemplo en la carpeta de copias etiquetadas.') : null,
    chk('rb-prefix', 'Los nombres llevan el prefijo «8A - 124 - »', s.renamePrefix, 'Márcalo si copiaste las pistas con la opción «Añadir tonalidad y BPM al nombre».'),
    chk('rb-grid', 'Incluir la rejilla de beats (BPM y primer tiempo)', s.rbBeatgrid !== false, 'Desmárcalo si prefieres que Rekordbox calcule su propia rejilla.'));
  const ok = await openDialog('Exportar para Rekordbox (XML)', body, [
    { label: 'Cancelar', value: false },
    {
      label: 'Crear XML', primary: true, action: (close) => {
        if (!path.value.trim()) {
          path.focus();
          return toast('Escribe la carpeta donde están los archivos', 'error');
        }
        close(true);
      },
    },
  ]);
  if (!ok) return;
  s.rbBasePath = path.value.trim().replace(/[\\/]+$/, '');
  s.rbBeatgrid = body.querySelector('#rb-grid').checked;
  saveSettings();
  const usePrefix = body.querySelector('#rb-prefix').checked;
  const useSub = hasSub ? body.querySelector('#rb-sub').checked : false;
  const items = list.map((t) => {
    const name = usePrefix ? `${tagKeyString(t)} - ${fmtBpm(Math.round(t.result.bpm))} - ${t.name}`.replace(/[\\/:*?"<>|]/g, '_') : t.name;
    const rel = t.relPath ? t.relPath.replace(/[^/]+$/, name) : name;
    return {
      title: t.title, artist: t.artist, name, relPath: rel, size: t.size,
      keyText: tagKeyString(t), comment: `${tagKeyString(t)} - Energy ${t.result.energy}`, result: t.result,
    };
  });
  const pos = new Map(list.map((t, i) => [t.id, i]));
  const playlists = [{ name: 'KeyMix Pro', ids: list.map((_, i) => i) }];
  const setIdx = state.set.map((id) => pos.get(id)).filter((i) => i != null);
  if (setIdx.length) playlists.push({ name: 'KeyMix Pro · Set armónico', ids: setIdx });
  const xml = buildRekordboxXml(items, { basePath: s.rbBasePath, useSubfolders: useSub, cueColors: CUE_COLORS, playlists, beatgrid: s.rbBeatgrid });
  exportText(xml, 'keymix-rekordbox.xml', 'application/xml');
}

// ------------------------------------------------------- Exportación ----

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(tracks, filename) {
  const rows = [['#', 'Título', 'Artista', 'Archivo', 'Camelot', 'Open Key', 'Tonalidad', 'BPM', 'Energía', 'Duración', 'Cue points']];
  tracks.forEach((t, i) => {
    const r = t.result;
    rows.push([i + 1, t.title, t.artist, t.name, r.key?.camelot, r.key?.openKey, r.key?.musical, r.bpm, r.energy, fmtTime(r.duration),
      r.cues.map((c, j) => `${j + 1}:${c.label}@${fmtTime(c.time)}`).join(' | ')]);
  });
  exportText(rows.map((r) => r.map(csvEscape).join(',')).join('\r\n'), filename, 'text/csv;charset=utf-8');
}

function exportJson() {
  const data = done().map((t) => {
    const { waveform, ...rest } = t.result;
    return { title: t.title, artist: t.artist, file: t.name, ...rest };
  });
  exportText(JSON.stringify(data, null, 2), 'keymix-biblioteca.json', 'application/json');
}

function exportM3u(tracks) {
  const lines = ['#EXTM3U', ...tracks.flatMap((t) => [
    `#EXTINF:${Math.round(t.result.duration)},${t.artist ? `${t.artist} - ` : ''}${t.title} [${t.result.key?.camelot} ${fmtBpm(t.result.bpm)}]`,
    t.name,
  ])];
  exportText(lines.join('\n') + '\n', 'keymix-set.m3u', 'audio/x-mpegurl');
}

// ------------------------------------------------- Constructor de sets ----

function setTracks() {
  return state.set.map(byId).filter((t) => t?.result);
}

function buildSetNow() {
  const src = $('#set-source').value === 'all' ? done() : done().filter((t) => state.checked.has(t.id));
  if (src.length < 2) {
    toast($('#set-source').value === 'all' ? 'Necesitas al menos 2 pistas analizadas' : 'Marca al menos 2 pistas en la biblioteca (o elige «Toda la biblioteca»)', 'error');
    return;
  }
  const order = buildSet(src.filter((t) => t.result.key).map(asSetItem), $('#set-start').value || null);
  state.set = order.map((o) => o.id);
  save();
  renderSet();
}

function renderSetStart() {
  const sel = $('#set-start');
  const cur = sel.value;
  sel.replaceChildren(el('option', { value: '' }, 'La de menor energía'),
    ...done().map((t) => el('option', { value: t.id, selected: t.id === cur }, `${keyText(t)} · ${t.title}`)));
}

function renderSet() {
  renderSetStart();
  const list = $('#set-list');
  const tracks = setTracks();
  const items = [];
  tracks.forEach((t, i) => {
    if (i > 0) {
      const tr = describeTransition(asSetItem(tracks[i - 1]), asSetItem(t));
      items.push(el('li', { class: 'transition' },
        el('span', { class: `badge ${tr.type}` }, tr.label),
        `Δ ${tr.bpmDelta}% BPM · energía ${tr.energyDelta > 0 ? '+' : ''}${tr.energyDelta}`));
    }
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= state.set.length) return;
      [state.set[i], state.set[j]] = [state.set[j], state.set[i]];
      save();
      renderSet();
    };
    items.push(el('li', { class: 'set-item' },
      el('span', { class: 'idx' }, i + 1),
      keyChip(t),
      el('div', { style: 'min-width:0', onclick: () => select(t.id, true) },
        el('div', { class: 't-title' }, t.title), el('div', { class: 't-artist' }, t.artist || t.name)),
      el('span', { class: 's-bpm' }, `${fmtBpm(t.result.bpm)} BPM`),
      el('span', { class: 's-energy' }, energyBar(t.result.energy)),
      el('span', { class: 'set-actions' },
        el('button', { title: 'Subir', onclick: () => move(-1) }, '↑'),
        el('button', { title: 'Bajar', onclick: () => move(1) }, '↓'),
        el('button', { title: 'Quitar del set', onclick: () => { state.set.splice(i, 1); save(); renderSet(); } }, '✕'))));
  });
  list.replaceChildren(...items);
  if (!tracks.length) list.append(el('li', { class: 'muted', style: 'padding:24px 0' }, 'Marca pistas en la biblioteca y pulsa «Generar set armónico». El orden minimiza choques de tonalidad, saltos de tempo y caídas de energía.'));

  const items2 = tracks.map(asSetItem);
  const clashes = items2.slice(1).filter((x, i) => compatibility(items2[i].camelot, x.camelot).type === 'clash').length;
  const total = tracks.reduce((a, t) => a + t.result.duration, 0);
  $('#set-summary').textContent = tracks.length
    ? `${tracks.length} pistas · ${fmtTime(total)} · ${clashes ? `${clashes} choque(s) armónico(s)` : 'sin choques armónicos'} · puntuación ${pathCost(items2).toFixed(1)} (menor es mejor)`
    : '';

  const svg = $('#energy-curve');
  if (tracks.length > 1) {
    const w = 1000;
    const h = 70;
    const pts = tracks.map((t, i) => `${(i / (tracks.length - 1)) * w},${h - 6 - ((t.result.energy - 1) / 9) * (h - 12)}`);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`
      + pts.map((p, i) => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="4" fill="${keyBg(camelotOf(tracks[i]))}" vector-effect="non-scaling-stroke"><title>${tracks[i].title.replace(/[<&]/g, '')} · E${tracks[i].result.energy}</title></circle>`).join('');
    svg.style.display = '';
  } else svg.style.display = 'none';
}

// -------------------------------------------------------- Reproductor ----

const audio = $('#audio');
let currentUrl = null;

function loadIntoPlayer(t, autoplay = false) {
  if (!t?.file) {
    if (t) toast('Esta pista está en caché pero sin archivo: vuelve a añadirla para reproducirla', 'error');
    return false;
  }
  if (isAiffName(t.name) && !t.playFile) {
    toast('Preparando el AIFF para reproducirlo, vuelve a intentarlo en un momento');
    preparePlayback(t);
    return false;
  }
  if (state.playingId !== t.id) {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(t.playFile || t.file);
    audio.src = currentUrl;
    state.playingId = t.id;
  }
  if (autoplay) audio.play().catch(() => {});
  renderPlayerInfo();
  return true;
}

function playerTrack() {
  return byId(state.playingId) || byId(state.selectedId);
}

function togglePlay() {
  const sel = byId(state.selectedId);
  if (sel && sel.id !== state.playingId) {
    loadIntoPlayer(sel, true);
    scheduleRender();
    return;
  }
  if (!state.playingId) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function jumpToCue(t, i) {
  const cue = t.result?.cues[i];
  if (!cue) return;
  if (!loadIntoPlayer(t)) return;
  const go = () => {
    audio.currentTime = cue.time;
    audio.play().catch(() => {});
  };
  if (audio.readyState >= 1) go();
  else audio.addEventListener('loadedmetadata', go, { once: true });
  scheduleRender();
}

function renderPlayerInfo() {
  const t = playerTrack();
  const keyBox = $('#np-key');
  if (!t) {
    keyBox.textContent = '—';
    keyBox.style.background = '';
    return;
  }
  $('#np-title').textContent = t.title;
  $('#np-meta').textContent = t.result
    ? `${t.artist ? `${t.artist} · ` : ''}${fmtBpm(t.result.bpm)} BPM · Energía ${t.result.energy}${t.file ? '' : ' · sin archivo'}`
    : t.artist || t.name;
  keyBox.textContent = t.result?.key ? keyText(t) : '—';
  keyBox.style.background = t.result?.key ? keyBg(camelotOf(t)) : '';
  const cues = t.result?.cues || [];
  $('#cue-buttons').replaceChildren(...Array.from({ length: 8 }, (_, i) =>
    el('button', {
      style: `background:${CUE_COLORS[i]}`,
      disabled: !cues[i],
      title: cues[i] ? `${cues[i].label} · ${fmtTime(cues[i].time)} (tecla ${i + 1})` : 'Sin cue',
      onclick: () => jumpToCue(t, i),
    }, i + 1)));
  $('#btn-play').textContent = audio.paused || state.playingId !== t.id ? '▶' : '⏸';
  updateTime();
}

function updateTime() {
  const t = playerTrack();
  const dur = t?.result?.duration || audio.duration || 0;
  const cur = state.playingId === t?.id ? audio.currentTime : 0;
  $('#time').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
}

function drawWaveform() {
  const canvas = $('#waveform');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const t = playerTrack();
  if (!t?.result) return;
  const { peaks, low, mid, high } = t.result.waveform;
  const dur = t.result.duration;
  const pos = state.playingId === t.id ? audio.currentTime / dur : 0;
  const cols = peaks.length;
  const mid0 = h / 2;
  const barW = Math.max(1, w / cols);

  // Rejilla de frases (cada 8 compases).
  const g = t.result.beatGrid;
  if (g?.bpm) {
    const phrase = (60 / g.bpm) * 32;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let x = g.firstBeat + g.downbeat * (60 / g.bpm); x < dur; x += phrase) {
      ctx.fillRect(Math.round((x / dur) * w), 0, 1, h);
    }
  }
  for (let x = 0; x < w; x += barW) {
    const c = Math.min(cols - 1, Math.floor((x / w) * cols));
    const amp = (peaks[c] / 255) * (mid0 - 2);
    const lo = low[c] / 255;
    const md = mid[c] / 255;
    const hi = high[c] / 255;
    const r = Math.round(250 * lo + 70 * md + 110 * hi);
    const gg = Math.round(70 * lo + 210 * md + 190 * hi);
    const b = Math.round(90 * lo + 120 * md + 255 * hi);
    const played = x / w <= pos;
    ctx.fillStyle = `rgba(${r},${gg},${b},${played ? 1 : 0.55})`;
    ctx.fillRect(x, mid0 - amp, Math.ceil(barW), amp * 2 || 1);
  }
  // Cue points.
  ctx.font = `${10 * dpr}px system-ui, sans-serif`;
  t.result.cues.forEach((cue, i) => {
    const x = Math.round((cue.time / dur) * w);
    ctx.fillStyle = CUE_COLORS[i];
    ctx.fillRect(x, 0, Math.max(1, dpr), h);
    ctx.fillRect(x, 0, 14 * dpr, 13 * dpr);
    ctx.fillStyle = '#111';
    ctx.fillText(String(i + 1), x + 4 * dpr, 10 * dpr);
  });
  // Cabezal.
  if (state.playingId === t.id) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.round(pos * w) - dpr, 0, 2 * dpr, h);
  }
}

// ------------------------------------------------------------ Acciones ----

function select(id, scroll = false) {
  if (id !== state.selectedId) stopDrone();
  state.selectedId = id;
  if (state.view !== 'library' && scroll) switchView('library');
  // Sin reconstruir la tabla: así las filas bajo el cursor siguen siendo las mismas entre clics.
  if (state.compatOnly) renderTable();
  else updateRowStates();
  renderWheel();
  renderDetails();
  renderPlayerInfo();
  if (state.view === 'set') renderSet();
  drawWaveform();
  if (scroll) document.querySelector(`tr[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** Actualiza selección, pista en reproducción y puntos de compatibilidad sin redibujar filas. */
function updateRowStates() {
  const sel = byId(state.selectedId);
  document.querySelectorAll('#track-body tr[data-id]').forEach((tr) => {
    const t = byId(tr.dataset.id);
    tr.classList.toggle('selected', tr.dataset.id === state.selectedId);
    tr.classList.toggle('playing', tr.dataset.id === state.playingId);
    const title = tr.querySelector('.t-title');
    title?.querySelector('.compat-dot')?.remove();
    const rel = sel?.result && t?.result ? relation(sel, t) : null;
    if (title && rel) title.prepend(el('span', { class: `compat-dot compat-${rel.type}`, title: rel.label }));
  });
}

/** Carga la pista en el reproductor y la reproduce desde el principio. */
function playFromStart(t) {
  if (!t) return;
  if (t.status !== 'done') {
    toast('Espera a que termine el análisis de esta pista para reproducirla');
    return;
  }
  if (!loadIntoPlayer(t)) return;
  const go = () => {
    audio.currentTime = 0;
    audio.play().catch((err) => toast(`No se pudo reproducir: ${err.message}`, 'error'));
  };
  if (audio.readyState >= 1) go();
  else audio.addEventListener('loadedmetadata', go, { once: true });
  updateRowStates();
  renderPlayerInfo();
  drawWaveform();
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-selected', b.dataset.view === view);
  });
  $('#view-library').hidden = view !== 'library';
  $('#view-set').hidden = view !== 'set';
  render();
}

function moveSelection(d) {
  const list = visibleTracks();
  if (!list.length) return;
  const i = list.findIndex((t) => t.id === state.selectedId);
  const n = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))];
  select(n.id, true);
}

let lastRowClick = { id: null, time: 0 };

function bindEvents() {
  $('#file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  if ('showDirectoryPicker' in window) {
    $('#btn-folder').hidden = false;
    $('#btn-folder').addEventListener('click', openFolder);
  }

  const notation = $('#notation');
  notation.value = state.settings.notation;
  notation.addEventListener('change', () => {
    state.settings.notation = notation.value;
    saveSettings();
    render();
  });

  const menu = $('#export-menu');
  $('#btn-export').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    $('#btn-export').setAttribute('aria-expanded', !menu.hidden);
  });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const action = e.target.dataset.export;
    if (!action) return;
    menu.hidden = true;
    if ((action === 'csv' || action === 'json') && !done().length) return toast('La biblioteca está vacía', 'error');
    if (action === 'csv') exportCsv(done(), 'keymix-biblioteca.csv');
    if (action === 'json') exportJson();
    if (action === 'rekordbox') exportRekordbox();
    if (action === 'tag-all') tagAll();
    if (action === 'copy-tagged') copyTaggedToFolder();
    if (action === 'clear') confirmDialog('Vaciar biblioteca', 'Se borrarán los análisis guardados. Tus archivos no se tocan.', 'Vaciar', true).then((ok) => {
      if (!ok) return;
      queue.length = 0;
      state.tracks = state.tracks.filter((t) => t.status === 'decoding' || t.status === 'analyzing');
      state.set = [];
      state.checked.clear();
      state.selectedId = null;
      audio.pause();
      state.playingId = null;
      save();
      render();
    });
  });

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTable();
  });
  $('#compat-only').addEventListener('change', (e) => {
    state.compatOnly = e.target.checked;
    renderTable();
  });
  $('#key-filter-chip').addEventListener('click', () => {
    state.keyFilter = null;
    render();
  });
  $('#check-all').addEventListener('change', (e) => {
    for (const t of visibleTracks()) {
      if (e.target.checked && t.status === 'done') state.checked.add(t.id);
      else state.checked.delete(t.id);
    }
    renderTable();
  });

  document.querySelectorAll('.tracks th[data-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
      renderTable();
    }));

  $('#track-body').addEventListener('click', (e) => {
    const check = e.target.closest('[data-check]');
    if (check) {
      if (check.checked) state.checked.add(check.dataset.check);
      else state.checked.delete(check.dataset.check);
      renderTable();
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    // Doble clic detectado por tiempo y pista: funciona aunque la fila se haya redibujado entre clics.
    const now = performance.now();
    const isDouble = lastRowClick.id === id && now - lastRowClick.time < 450;
    lastRowClick = isDouble ? { id: null, time: 0 } : { id, time: now };
    if (state.selectedId !== id) select(id);
    if (isDouble) playFromStart(byId(id));
  });
  // Evita que el doble clic seleccione el texto de la fila.
  $('#track-body').addEventListener('mousedown', (e) => {
    if (e.detail > 1 && e.target.closest('tr[data-id]')) e.preventDefault();
  });

  $('#wheel').addEventListener('click', (e) => {
    const seg = e.target.closest('[data-code]');
    if (!seg) return;
    state.keyFilter = state.keyFilter === seg.dataset.code ? null : seg.dataset.code;
    if (state.view !== 'library') switchView('library');
    else render();
  });

  $('#btn-build-set').addEventListener('click', buildSetNow);
  $('#btn-set-m3u').addEventListener('click', () => (setTracks().length ? exportM3u(setTracks()) : toast('El set está vacío', 'error')));
  $('#btn-set-csv').addEventListener('click', () => (setTracks().length ? exportCsv(setTracks(), 'keymix-set.csv') : toast('El set está vacío', 'error')));

  // Reproductor
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-start').addEventListener('click', () => { audio.currentTime = 0; });
  const vol = $('#volume');
  vol.value = state.settings.volume;
  audio.volume = state.settings.volume;
  vol.addEventListener('input', () => {
    audio.volume = Number(vol.value);
    state.settings.volume = audio.volume;
    saveSettings();
  });
  audio.addEventListener('play', () => { renderPlayerInfo(); updateRowStates(); });
  audio.addEventListener('pause', renderPlayerInfo);
  audio.addEventListener('ended', renderPlayerInfo);
  let raf = 0;
  const tick = () => {
    updateTime();
    drawWaveform();
    raf = audio.paused ? 0 : requestAnimationFrame(tick);
  };
  audio.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); });
  audio.addEventListener('seeked', () => { updateTime(); drawWaveform(); });
  $('#waveform').addEventListener('click', (e) => {
    const t = playerTrack();
    if (!t?.result || !loadIntoPlayer(t)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const target = ((e.clientX - rect.left) / rect.width) * t.result.duration;
    const go = () => { audio.currentTime = target; drawWaveform(); updateTime(); };
    if (audio.readyState >= 1) go();
    else audio.addEventListener('loadedmetadata', go, { once: true });
    scheduleRender();
  });
  window.addEventListener('resize', () => drawWaveform());
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

  // Arrastrar y soltar
  let dragDepth = 0;
  const overlay = $('#drop-overlay');
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const items = [...(e.dataTransfer?.items || [])];
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.some((en) => en.isDirectory)) {
      const files = [];
      const walk = (entry) => new Promise((res) => {
        if (entry.isFile) {
          entry.file((f) => {
            // fullPath = «/CarpetaArrastrada/sub/tema.aiff» → «sub/tema.aiff»
            filePaths.set(f, entry.fullPath.split('/').filter(Boolean).slice(1).join('/') || f.name);
            files.push(f);
            res();
          }, () => res());
        }
        else if (entry.isDirectory) {
          const reader = entry.createReader();
          const all = [];
          const readBatch = () => reader.readEntries(async (batch) => {
            if (!batch.length) { await Promise.all(all.map(walk)); res(); } else { all.push(...batch); readBatch(); }
          }, () => res());
          readBatch();
        } else res();
      });
      await Promise.all(entries.map(walk));
      addFiles(files);
    } else addFiles(e.dataTransfer.files);
  });

  // Atajos de teclado
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'range';
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Enter') playFromStart(byId(state.selectedId)); else if (/^[1-8]$/.test(e.key)) {
      const t = playerTrack();
      if (t) jumpToCue(t, Number(e.key) - 1);
    } else if (e.key === 'Home') audio.currentTime = 0;
    else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    else if (e.key.toLowerCase() === 'a') $('#file-input').click();
    else if (e.key.toLowerCase() === 't') {
      const t = byId(state.selectedId);
      if (t?.result?.key) toggleDrone(drone.code || t.result.key.camelot);
    } else if (e.key.toLowerCase() === 'c') { const c = $('#compat-only'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
  });
}

function loadDemo() {
  toast('Generando pistas de demostración…');
  setTimeout(() => addFiles(makeDemoFiles()), 30);
}

// ---------------------------------------------------------------- Init ----

load();
$('#btn-demo').addEventListener('click', loadDemo);
let firstVisit = true;
try {
  firstVisit = !localStorage.getItem('keymix.visited');
  localStorage.setItem('keymix.visited', '1');
} catch {
  // sin almacenamiento: se trata como primera visita
}
if (!state.tracks.length && firstVisit) loadDemo();
if (state.tracks.length) state.selectedId = state.tracks[0].id;
bindEvents();
render();
