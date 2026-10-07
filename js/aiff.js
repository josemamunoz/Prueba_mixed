// Lector de AIFF / AIFF-C (PCM y coma flotante) y codificador WAV de 16 bits.
// Chrome, Edge y Firefox no decodifican AIFF con Web Audio, así que se hace aquí.

const fourcc = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/** Float IEEE 754 extendido de 80 bits (big-endian), usado para la frecuencia de muestreo. */
function readExtended(dv, o) {
  const expon = dv.getUint16(o) & 0x7fff;
  const sign = dv.getUint16(o) & 0x8000 ? -1 : 1;
  const hi = dv.getUint32(o + 2);
  const lo = dv.getUint32(o + 6);
  if (expon === 0 && hi === 0 && lo === 0) return 0;
  return sign * (hi * 2 ** (expon - 16383 - 31) + lo * 2 ** (expon - 16383 - 63));
}

export function isAiff(arrayBuffer) {
  if (arrayBuffer.byteLength < 12) return false;
  const dv = new DataView(arrayBuffer);
  return fourcc(dv, 0) === 'FORM' && /^AIF[FC]$/.test(fourcc(dv, 8));
}

/**
 * Decodifica un AIFF/AIFC. Devuelve { sampleRate, channels: Float32Array[], id3: Uint8Array|null }.
 */
export function parseAiff(arrayBuffer) {
  if (!isAiff(arrayBuffer)) throw new Error('No es un archivo AIFF');
  const dv = new DataView(arrayBuffer);
  const isAifc = fourcc(dv, 8) === 'AIFC';
  let comm = null;
  let ssnd = null;
  let id3 = null;
  let off = 12;
  const end = Math.min(dv.byteLength, 8 + dv.getUint32(4));
  while (off + 8 <= end) {
    const id = fourcc(dv, off);
    const size = dv.getUint32(off + 4);
    const body = off + 8;
    if (id === 'COMM') {
      comm = {
        channels: dv.getUint16(body),
        frames: dv.getUint32(body + 2),
        bits: dv.getUint16(body + 6),
        sampleRate: readExtended(dv, body + 8),
        compression: isAifc && size >= 22 ? fourcc(dv, body + 18) : 'NONE',
      };
    } else if (id === 'SSND') {
      const dataOffset = dv.getUint32(body);
      ssnd = { start: body + 8 + dataOffset, end: Math.min(dv.byteLength, body + size) };
    } else if (id === 'ID3 ' || id === 'id3 ') {
      id3 = new Uint8Array(arrayBuffer, body, Math.min(size, dv.byteLength - body));
    }
    off = body + size + (size & 1);
  }
  if (!comm || !ssnd) throw new Error('AIFF incompleto (faltan los bloques COMM o SSND)');

  const { channels: nch, bits, compression } = comm;
  let read;
  let bytes;
  const comp = compression.toLowerCase();
  if (comp === 'none' || comp === 'twos' || comp === 'sowt') {
    const le = comp === 'sowt';
    bytes = Math.ceil(bits / 8);
    if (bytes === 1) read = (p) => dv.getInt8(p) / 128;
    else if (bytes === 2) read = (p) => dv.getInt16(p, le) / 32768;
    else if (bytes === 3) {
      read = le
        ? (p) => ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16))) / 8388608
        : (p) => (((dv.getInt8(p) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p + 2))) / 8388608;
    } else if (bytes === 4) read = (p) => dv.getInt32(p, le) / 2147483648;
    else throw new Error(`AIFF de ${bits} bits no soportado`);
  } else if (comp === 'fl32') {
    bytes = 4;
    read = (p) => dv.getFloat32(p);
  } else if (comp === 'fl64') {
    bytes = 8;
    read = (p) => dv.getFloat64(p);
  } else {
    throw new Error(`AIFF-C con compresión «${compression}» no soportado`);
  }

  const frameBytes = bytes * nch;
  const frames = Math.min(comm.frames, Math.floor((ssnd.end - ssnd.start) / frameBytes));
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  for (let i = 0, p = ssnd.start; i < frames; i++) {
    for (let c = 0; c < nch; c++, p += bytes) channels[c][i] = read(p);
  }
  return { sampleRate: comm.sampleRate, channels, id3 };
}

/** Codifica canales en un WAV PCM de 16 bits (para reproducir en navegadores sin soporte AIFF). */
export function encodeWav(channels, sampleRate, type = 'audio/wav') {
  const nch = channels.length;
  const n = channels[0]?.length || 0;
  const buf = new ArrayBuffer(44 + n * nch * 2);
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * nch * 2, true); str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, Math.round(sampleRate), true); dv.setUint32(28, Math.round(sampleRate) * nch * 2, true);
  dv.setUint16(32, nch * 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * nch * 2, true);
  let p = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++, p += 2) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(p, s < 0 ? s * 32768 : s * 32767, true);
    }
  }
  return new Blob([buf], { type });
}
