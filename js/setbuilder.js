// Ordenación armónica de sets: minimiza choques de tonalidad, saltos de BPM y caídas de energía.

import { compatibility } from './camelot.js';

/** Diferencia de tempo en % teniendo en cuenta mezclas a doble/mitad de tempo. */
export function bpmDistance(a, b) {
  if (!a || !b) return 100;
  return Math.min(...[b, b * 2, b / 2].map((x) => Math.abs(x - a) / a)) * 100;
}

/** Coste de pasar de la pista a a la b. Ambas: { camelot, bpm, energy }. */
export function transitionCost(a, b) {
  const key = compatibility(a.camelot, b.camelot);
  const bpm = bpmDistance(a.bpm, b.bpm);
  const de = b.energy - a.energy;
  const energy = de < 0 ? -de * 0.8 : de > 2 ? (de - 2) * 0.5 : 0;
  return key.cost + Math.max(0, bpm - 1.5) * 0.6 + energy;
}

export function describeTransition(a, b) {
  const key = compatibility(a.camelot, b.camelot);
  return {
    type: key.type,
    label: key.label,
    bpmDelta: Math.round(bpmDistance(a.bpm, b.bpm) * 10) / 10,
    energyDelta: b.energy - a.energy,
    cost: transitionCost(a, b),
  };
}

const pathCost = (order) => {
  let c = 0;
  for (let i = 1; i < order.length; i++) c += transitionCost(order[i - 1], order[i]);
  return c;
};

/**
 * Devuelve las pistas en orden. Vecino más cercano desde la pista inicial
 * (por defecto la de menor energía) y mejora local 2-opt.
 */
export function buildSet(tracks, startId = null) {
  if (tracks.length < 3) return [...tracks].sort((a, b) => a.energy - b.energy);
  const pool = [...tracks];
  let start = pool.find((t) => t.id === startId);
  if (!start) start = pool.reduce((m, t) => (t.energy < m.energy || (t.energy === m.energy && t.bpm < m.bpm) ? t : m));
  const order = [start];
  pool.splice(pool.indexOf(start), 1);
  while (pool.length) {
    const last = order[order.length - 1];
    let bi = 0;
    let bc = Infinity;
    pool.forEach((t, i) => {
      const c = transitionCost(last, t);
      if (c < bc) { bc = c; bi = i; }
    });
    order.push(pool.splice(bi, 1)[0]);
  }
  if (order.length > 150) return order;
  let best = pathCost(order);
  let improved = true;
  let rounds = 0;
  while (improved && rounds++ < 20) {
    improved = false;
    for (let i = 1; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const c = pathCost(cand);
        if (c < best - 1e-9) {
          order.splice(0, order.length, ...cand);
          best = c;
          improved = true;
        }
      }
    }
  }
  return order;
}

export { pathCost };
