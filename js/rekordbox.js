// Exportación a rekordbox XML (formato DJ_PLAYLISTS de Pioneer DJ / AlphaTheta).
// Rekordbox no lee cue points de las etiquetas de los archivos: los importa desde este XML.

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // Caracteres de control no válidos en XML 1.0.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const KINDS = { mp3: 'MP3 File', wav: 'WAV File', wave: 'WAV File', aif: 'AIFF File', aiff: 'AIFF File', aifc: 'AIFF File', flac: 'FLAC File', m4a: 'M4A File', mp4: 'M4A File', aac: 'AAC File', ogg: 'OGG File' };

export function kindOf(name) {
  const ext = (/\.([^.]+)$/.exec(name)?.[1] || '').toLowerCase();
  return KINDS[ext] || `${ext.toUpperCase()} File`;
}

/**
 * Ruta del archivo en el formato Location de rekordbox:
 * «F:\Música\Mis temas» + «sub/Tema 1.aiff» → «file://localhost/F:/M%C3%BAsica/Mis%20temas/sub/Tema%201.aiff».
 * En Mac/Linux («/Users/yo/Music») queda «file://localhost/Users/yo/Music/...».
 */
export function locationUrl(basePath, relPath) {
  const parts = `${basePath}/${relPath}`.replace(/\\/g, '/').split('/').filter(Boolean);
  const enc = parts.map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p.toUpperCase() : encodeURIComponent(p)));
  return `file://localhost/${enc.join('/')}`;
}

const hexToRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const f3 = (n) => (Math.round(n * 1000) / 1000).toFixed(3);

/** Primer tiempo fuerte (tiempo 1 del compás) de la rejilla, siempre ≥ 0. */
export function firstDownbeat(grid) {
  if (!grid?.bpm) return null;
  const beat = 60 / grid.bpm;
  let t = grid.firstBeat + (grid.downbeat || 0) * beat;
  if (t < 0 && t > -0.05) return 0; // detectado unos ms antes del inicio del audio
  while (t < 0) t += beat * 4;
  while (t - beat * 4 >= 0) t -= beat * 4;
  return t;
}

/**
 * tracks: [{ title, artist, name, relPath?, size, keyText, comment, result }]
 * opts: { basePath, useSubfolders, cueColors, playlists: [{ name, ids: [índices en tracks] }],
 *         beatgrid: true|false, memoryCues: true|false }
 */
export function buildRekordboxXml(tracks, opts) {
  const { basePath, useSubfolders = true, cueColors = [], playlists = [], beatgrid = true, memoryCues = true } = opts;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="KeyMix Pro" Version="1.0" Company="KeyMix"/>',
    `  <COLLECTION Entries="${tracks.length}">`,
  ];
  tracks.forEach((t, i) => {
    const r = t.result;
    const rel = useSubfolders && t.relPath ? t.relPath : t.name;
    const attrs = {
      TrackID: i + 1,
      Name: t.title,
      Artist: t.artist || '',
      Kind: kindOf(t.name),
      Size: t.size || 0,
      TotalTime: Math.round(r.duration),
      AverageBpm: r.bpm ? r.bpm.toFixed(2) : '0.00',
      Tonality: t.keyText || '',
      Comments: t.comment || '',
      Location: locationUrl(basePath, rel),
    };
    lines.push(`    <TRACK ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}>`);
    const down = beatgrid ? firstDownbeat(r.beatGrid) : null;
    if (down != null) {
      lines.push(`      <TEMPO Inizio="${f3(down)}" Bpm="${r.bpm.toFixed(2)}" Metro="4/4" Battito="1"/>`);
    }
    (r.cues || []).slice(0, 8).forEach((c, n) => {
      const [R, G, B] = hexToRgb(cueColors[n] || '#28e214');
      const start = f3(Math.max(0, c.time));
      // Hot cue (A–H) y, además, un memory cue en el mismo punto.
      lines.push(`      <POSITION_MARK Name="${esc(c.label)}" Type="0" Start="${start}" Num="${n}" Red="${R}" Green="${G}" Blue="${B}"/>`);
      if (memoryCues) lines.push(`      <POSITION_MARK Name="${esc(c.label)}" Type="0" Start="${start}" Num="-1"/>`);
    });
    lines.push('    </TRACK>');
  });
  lines.push('  </COLLECTION>');
  lines.push(`  <PLAYLISTS>`);
  lines.push(`    <NODE Type="0" Name="ROOT" Count="${playlists.length}">`);
  for (const p of playlists) {
    lines.push(`      <NODE Name="${esc(p.name)}" Type="1" KeyType="0" Entries="${p.ids.length}">`);
    for (const idx of p.ids) lines.push(`        <TRACK Key="${idx + 1}"/>`);
    lines.push('      </NODE>');
  }
  lines.push('    </NODE>');
  lines.push('  </PLAYLISTS>');
  lines.push('</DJ_PLAYLISTS>');
  return lines.join('\n') + '\n';
}
