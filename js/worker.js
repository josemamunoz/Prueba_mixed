// Web Worker: ejecuta el análisis fuera del hilo principal.
import { analyzeTrack } from './dsp.js';

self.onmessage = (e) => {
  const { id, samples, sampleRate } = e.data;
  let lastSent = -1;
  try {
    const result = analyzeTrack(samples, sampleRate, (progress, stage) => {
      if (progress - lastSent >= 0.02 || progress === 1) {
        lastSent = progress;
        self.postMessage({ id, type: 'progress', progress, stage });
      }
    });
    const w = result.waveform;
    self.postMessage({ id, type: 'done', result }, [w.peaks.buffer, w.low.buffer, w.mid.buffer, w.high.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', error: err?.message || String(err) });
  }
};
