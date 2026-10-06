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
 * Escribe/reemplaza marcos y devuelve un Blob con el MP3 resultante.
 * values: { key?, bpm?, comment? } — solo se tocan los campos presentes.
 */
export function writeTags(arrayBuffer, values) {
  const bytes = new Uint8Array(arrayBuffer);
  const header = parseHeader(bytes);
  if (header && header.flags & 0x80) throw new Error('Etiqueta ID3 con «unsynchronisation»: no soportada.');
  if (header && header.major < 3) throw new Error('ID3v2.2 no soportado.');
  const major = header ? header.major : 3;
  const keep = header ? parseFrames(bytes, header) : [];
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

  const padding = 1024;
  const framesLen = parts.reduce((a, p) => a + p.length, 0);
  const size = framesLen + padding;
  const head = new Uint8Array(10);
  head.set([0x49, 0x44, 0x33, major, 0, 0], 0);
  head.set(encodeSize(size, 4), 6); // el tamaño de cabecera siempre es syncsafe
  const audio = bytes.subarray(header ? header.total : 0);
  return new Blob([head, ...parts, new Uint8Array(padding), audio], { type: 'audio/mpeg' });
}
