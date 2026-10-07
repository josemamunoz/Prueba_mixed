// Lectura y escritura mínima de etiquetas ID3v2.3/2.4 en MP3 (título, artista, tonalidad, BPM, comentario).
// Conserva el resto de marcos existentes (portadas, álbum, etc.).

const latin1 = (bytes) => String.fromCharCode(...bytes);

function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function u32(b, o) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function parseHeader(bytes) {
  if (bytes.length < 10 || latin1(bytes.subarray(0, 3)) !== 'ID3') return null;
  const major = bytes[3];
  const flags = bytes[5];
  const size = syncsafe(bytes, 6);
  const footer = major === 4 && flags & 0x10 ? 10 : 0;
  return { major, flags, size, total: 10 + size + footer };
}

function parseFrames(bytes, header) {
  const frames = [];
  if (header.major < 3) return frames; // ID3v2.2 no soportado
  let off = 10;
  const end = Math.min(bytes.length, 10 + header.size);
  if (header.flags & 0x40) {
    const extSize = header.major === 4 ? syncsafe(bytes, off) : u32(bytes, off) + 4;
    off += extSize;
  }
  while (off + 10 <= end) {
    if (bytes[off] === 0) break; // relleno
    const id = latin1(bytes.subarray(off, off + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = header.major === 4 ? syncsafe(bytes, off + 4) : u32(bytes, off + 4);
    if (size < 0 || off + 10 + size > end) break;
    frames.push({ id, flags: bytes.subarray(off + 8, off + 10), body: bytes.subarray(off + 10, off + 10 + size) });
    off += 10 + size;
  }
  return frames;
}

function decodeText(enc, bytes) {
  // Quita terminadores nulos.
  let end = bytes.length;
  if (enc === 1 || enc === 2) {
    while (end >= 2 && bytes[end - 1] === 0 && bytes[end - 2] === 0) end -= 2;
  } else {
    while (end > 0 && bytes[end - 1] === 0) end--;
  }
  const b = bytes.subarray(0, end);
  if (enc === 0) return latin1(b);
  if (enc === 3) return new TextDecoder('utf-8').decode(b);
  if (enc === 2) return new TextDecoder('utf-16be').decode(b);
  // UTF-16 con BOM
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  return new TextDecoder('utf-16le').decode(b);
}

function textFrame(body) {
  return decodeText(body[0], body.subarray(1)).split('\u0000')[0];
}

function commentFrame(body, skip = 4) {
  const enc = body[0];
  const rest = body.subarray(skip);
  const wide = enc === 1 || enc === 2;
  let i = 0;
  if (wide) {
    while (i + 1 < rest.length && !(rest[i] === 0 && rest[i + 1] === 0)) i += 2;
    return { description: decodeText(enc, rest.subarray(0, i)), text: decodeText(enc, rest.subarray(i + 2)) };
  }
  while (i < rest.length && rest[i] !== 0) i++;
  return { description: decodeText(enc, rest.subarray(0, i)), text: decodeText(enc, rest.subarray(i + 1)) };
}

/** Lee título, artista, tonalidad, BPM y comentario. Devuelve {} si no hay etiqueta. */
export function readTags(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const header = parseHeader(bytes);
  if (!header || header.flags & 0x80) return {};
  const out = {};
  for (const f of parseFrames(bytes, header)) {
    try {
      if (f.id === 'TIT2') out.title = textFrame(f.body);
      else if (f.id === 'TPE1') out.artist = textFrame(f.body);
      else if (f.id === 'TKEY') out.key = textFrame(f.body);
      else if (f.id === 'TBPM') out.bpm = textFrame(f.body);
      else if (f.id === 'COMM' && out.comment === undefined) {
        const c = commentFrame(f.body);
        if (!c.description) out.comment = c.text;
      }
    } catch {
      // marco corrupto: se ignora
    }
  }
  return out;
}

// ------------------------------------------------------------- Escritura ----

function encodeSize(n, major) {
  if (major === 4) return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
  return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function encodeString(str, major) {
  // Latin-1 si es posible; si no, UTF-8 (v2.4) o UTF-16 con BOM (v2.3).
  if (/^[\x00-\xff]*$/.test(str)) return { enc: 0, bytes: Uint8Array.from(str, (c) => c.charCodeAt(0)), nul: [0] };
  if (major === 4) return { enc: 3, bytes: new TextEncoder().encode(str), nul: [0] };
  const out = new Uint8Array(2 + str.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return { enc: 1, bytes: out, nul: [0, 0] };
}

function buildFrame(id, body, major, flags = [0, 0]) {
  const out = new Uint8Array(10 + body.length);
  out.set(Array.from(id, (c) => c.charCodeAt(0)), 0);
  out.set(encodeSize(body.length, major), 4);
  out.set(flags, 8);
  out.set(body, 10);
  return out;
}

function buildTextFrame(id, value, major) {
  const s = encodeString(value, major);
  const body = new Uint8Array(1 + s.bytes.length);
  body[0] = s.enc;
  body.set(s.bytes, 1);
  return buildFrame(id, body, major);
}

function buildCommentFrame(text, major) {
  const s = encodeString(text, major);
  // Descripción vacía: con UTF-16 debe llevar BOM propio antes del terminador.
  const desc = s.enc === 1 ? [0xff, 0xfe, 0, 0] : s.nul;
  const body = new Uint8Array(1 + 3 + desc.length + s.bytes.length);
  body[0] = s.enc;
  body.set([0x65, 0x6e, 0x67], 1); // "eng"
  body.set(desc, 4);
  body.set(s.bytes, 4 + desc.length);
  return buildFrame('COMM', body, major);
}

/**
 * Construye una etiqueta ID3 completa (cabecera + marcos + relleno) a partir de una etiqueta
 * existente (o ninguna), reemplazando solo los campos presentes en values.
 */
function buildTag(tagBytes, values, padding = 1024) {
  const header = tagBytes ? parseHeader(tagBytes) : null;
  if (header && header.flags & 0x80) throw new Error('Etiqueta ID3 con «unsynchronisation»: no soportada.');
  if (header && header.major < 3) throw new Error('ID3v2.2 no soportado.');
  const major = header ? header.major : 3;
  const keep = header ? parseFrames(tagBytes, header) : [];
  const replace = new Set();
  if (values.key != null) replace.add('TKEY');
  if (values.bpm != null) replace.add('TBPM');

  const parts = [];
  for (const f of keep) {
    if (replace.has(f.id)) continue;
    if (f.id === 'COMM' && values.comment != null) {
      try {
        if (!commentFrame(f.body).description) continue;
      } catch {
        continue;
      }
    }
    // Algunos programas (p. ej. ffmpeg) guardan el comentario como TXXX:comment.
    if (f.id === 'TXXX' && values.comment != null) {
      try {
        if (commentFrame(f.body, 1).description.toLowerCase() === 'comment') continue;
      } catch {
        // se conserva
      }
    }
    parts.push(buildFrame(f.id, f.body, major, f.flags));
  }
  if (values.key != null) parts.push(buildTextFrame('TKEY', String(values.key), major));
  if (values.bpm != null) parts.push(buildTextFrame('TBPM', String(values.bpm), major));
  if (values.comment != null) parts.push(buildCommentFrame(String(values.comment), major));

  const framesLen = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(10 + framesLen + padding);
  out.set([0x49, 0x44, 0x33, major, 0, 0], 0);
  out.set(encodeSize(framesLen + padding, 4), 6); // el tamaño de cabecera siempre es syncsafe
  let off = 10;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * MP3: escribe/reemplaza marcos y devuelve un Blob con el archivo resultante.
 * values: { key?, bpm?, comment? } — solo se tocan los campos presentes.
 */
export function writeTags(arrayBuffer, values) {
  const bytes = new Uint8Array(arrayBuffer);
  const header = parseHeader(bytes);
  const tag = buildTag(header ? bytes.subarray(0, header.total) : null, values);
  const audio = bytes.subarray(header ? header.total : 0);
  return new Blob([tag, audio], { type: 'audio/mpeg' });
}

// ------------------------------------------------- AIFF y WAV (sin pérdida) ----
// Ambos formatos guardan la etiqueta ID3 en un bloque propio («ID3 » en AIFF, «id3 » en WAV),
// que es donde la leen Rekordbox, Serato, Traktor o Mixed In Key. El audio se copia byte a byte.

const tag4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function containerInfo(bytes) {
  if (bytes.length < 12) return null;
  const id = tag4(bytes, 0);
  const form = tag4(bytes, 8);
  if (id === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return { kind: 'aiff', le: false, mime: 'audio/aiff' };
  if (id === 'RIFF' && form === 'WAVE') return { kind: 'wav', le: true, mime: 'audio/wav' };
  if (id === 'RF64' || id === 'BW64') throw new Error('WAV de más de 4 GB (RF64): no soportado.');
  return null;
}

function chunks(bytes, info) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(bytes.length, 8 + dv.getUint32(4, info.le));
  const list = [];
  let off = 12;
  while (off + 8 <= end) {
    const size = dv.getUint32(off + 4, info.le);
    const next = Math.min(end, off + 8 + size + (size & 1));
    list.push({ id: tag4(bytes, off), start: off, body: off + 8, size, end: next });
    off = next;
  }
  return list;
}

const isId3Chunk = (id) => id === 'ID3 ' || id === 'id3 ';

/** ¿El archivo es un AIFF o WAV cuyas etiquetas se pueden escribir? */
export function isTaggableContainer(arrayBuffer) {
  try {
    return !!containerInfo(new Uint8Array(arrayBuffer));
  } catch {
    return false;
  }
}

/** Lee título, artista, etc. del bloque ID3 de un AIFF o WAV. */
export function readContainerTags(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let info;
  try {
    info = containerInfo(bytes);
  } catch {
    return {};
  }
  if (!info) return {};
  const c = chunks(bytes, info).find((x) => isId3Chunk(x.id));
  if (!c) return {};
  return readTags(bytes.slice(c.body, Math.min(bytes.length, c.body + c.size)).buffer);
}

/**
 * AIFF/WAV: reemplaza (o añade al final) el bloque ID3 y devuelve un Blob con el archivo.
 * Los bloques de audio y el resto de metadatos se conservan sin cambios.
 */
export function writeContainerTags(arrayBuffer, values) {
  const bytes = new Uint8Array(arrayBuffer);
  const info = containerInfo(bytes);
  if (!info) throw new Error('No es un archivo AIFF ni WAV.');
  const list = chunks(bytes, info);
  const old = list.find((x) => isId3Chunk(x.id));
  let tag = buildTag(old ? bytes.subarray(old.body, old.body + old.size) : null, values);
  if (tag.length & 1) tag = Uint8Array.from([...tag, 0]); // los bloques deben tener tamaño par

  const chunkHead = new Uint8Array(8);
  const id = info.kind === 'aiff' ? 'ID3 ' : 'id3 ';
  for (let i = 0; i < 4; i++) chunkHead[i] = id.charCodeAt(i);
  new DataView(chunkHead.buffer).setUint32(4, tag.length, info.le);

  const parts = [];
  for (const c of list) {
    if (c === old) continue;
    parts.push(bytes.subarray(c.start, c.end));
  }
  // Mismo sitio que el bloque antiguo si existía; si no, al final.
  const idx = old ? list.indexOf(old) : parts.length;
  parts.splice(idx, 0, chunkHead, tag);

  const total = 12 + parts.reduce((a, p) => a + p.length, 0);
  if (total - 8 > 0xffffffff) throw new Error('El archivo resultante superaría los 4 GB.');
  const head = bytes.slice(0, 12);
  new DataView(head.buffer).setUint32(4, total - 8, info.le);
  return new Blob([head, ...parts], { type: info.mime });
}
