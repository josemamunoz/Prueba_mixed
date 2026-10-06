// Lector WAV mínimo (PCM 8/16/24/32 bits y float 32) con remuestreo lineal a mono.

export function decodeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('No es un archivo WAV');
  let fmt = null;
  let off = 12;
  while (off + 8 <= dv.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe) fmt.format = dv.getUint16(body + 24, true);
    } else if (id === 'data' && fmt) {
      const bytes = fmt.bits / 8;
      const end = Math.min(dv.byteLength, body + size);
      const frames = Math.floor((end - body) / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + (i * fmt.channels + c) * bytes;
          let v;
          if (fmt.format === 3) v = bytes === 8 ? dv.getFloat64(p, true) : dv.getFloat32(p, true);
          else if (bytes === 1) v = (dv.getUint8(p) - 128) / 128;
          else if (bytes === 2) v = dv.getInt16(p, true) / 32768;
          else if (bytes === 3) v = ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16))) / 8388608;
          else v = dv.getInt32(p, true) / 2147483648;
          s += v;
        }
        out[i] = s / fmt.channels;
      }
      return { samples: out, sampleRate: fmt.sampleRate };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV sin bloque de datos');
}

export function resample(x, from, to) {
  if (from === to) return x;
  const ratio = from / to;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = x[j] * (1 - f) + (x[j + 1] ?? x[j]) * f;
  }
  return out;
}
