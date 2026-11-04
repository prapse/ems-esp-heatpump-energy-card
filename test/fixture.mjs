// Synthetic but realistic monthly data (no real installation data). The counters obey the
// same identities as EMS-ESP's: compressor = heating + DHW, heat total = heating + DHW,
// backup heater = heating + DHW part; meter_total = compressor + backup heater.

export const START = { y: 2024, m: 8 }; // September 2024 (month index 8)
export const MONTHS = 26; // Sep 2024 … Oct 2026

/** Deterministic per-month values, index i = months since START. */
export function month(i) {
  const m = (START.m + i) % 12;
  const winter = Math.cos(((m - 0.5) / 12) * 2 * Math.PI); // 1 in Jan, -1 in Jul
  const tOut = Math.round((10 - 9 * winter) * 10) / 10;
  const qHeating = Math.max(5, Math.round((1100 + 1000 * winter) * 100) / 100);
  const qDhw = 240 + (i % 3) * 7.5;
  const eCompHeating = Math.round((qHeating / (3.3 - 0.8 * winter)) * 100) / 100;
  const eCompDhw = Math.round((qDhw / 2.4) * 100) / 100;
  const eAuxDhw = i % 4 === 0 ? 12 : 0; // integer, like the EMS-ESP counter
  const eAuxHeat = winter > 0.8 ? 150 : 0;
  const eAux = eAuxDhw + eAuxHeat;
  // backup heater heat is part of the heat counters (factor 1)
  return {
    eCompressor: eCompHeating + eCompDhw,
    eCompHeating,
    eCompDhw,
    eAux,
    eAuxDhw,
    eTotal: eCompHeating + eCompDhw + eAux,
    qHeating: qHeating + eAuxHeat,
    qDhw: qDhw + eAuxDhw,
    qTotal: qHeating + eAuxHeat + qDhw + eAuxDhw,
    tOutside: tOut,
    tFlow: 32 + 4 * winter,
    tDhw: 49,
  };
}

/** Month start in Europe/Berlin as epoch ms (CET/CEST offsets are good enough for 1st-of-month 00:00). */
export function monthStartMs(i) {
  const y = START.y + Math.floor((START.m + i) / 12);
  const m = (START.m + i) % 12;
  const dst = m >= 3 && m <= 9; // April … October start in CEST
  return Date.UTC(y, m, 1) - (dst ? 2 : 1) * 3600e3;
}
