// model.js — data model of the heat pump energy card.
//
// Pure functions without DOM or Home Assistant dependencies, so they can be unit
// tested in Node and reused by the card in the browser.
//
// Source: Home Assistant long-term statistics (recorder/statistics_during_period;
// statistic type "change" for energy counters, "mean" for temperatures).
// Definitions and the reasoning behind them: README.md, section "How values are calculated".

/** Default statistic IDs as created by EMS-ESP's Home Assistant MQTT discovery. */
export const DEFAULT_ENTITIES = {
  // electrical energy (kWh, total_increasing)
  eCompressor: "sensor.boiler_meter_compressor", // compressor, heating + hot water
  eCompHeating: "sensor.boiler_meter_heating", // compressor, heating
  eCompDhw: "sensor.boiler_dhw_meter", // compressor, hot water (plausibility check only)
  eAux: "sensor.boiler_meter_e_heater", // electric backup heater, total
  eAuxDhw: "sensor.boiler_dhw_aux_elec_heater_energy_consumption", // backup heater, hot water
  eTotal: "sensor.boiler_meter_total", // total (plausibility check only)
  // heat produced (kWh, total_increasing)
  qTotal: "sensor.boiler_total_energy",
  qHeating: "sensor.boiler_energy_heating",
  qDhw: "sensor.boiler_dhw_energy",
  // temperatures (°C, measurement)
  tOutside: "sensor.boiler_outside_temperature",
  tFlow: "sensor.boiler_current_flow_temperature",
  tDhw: "sensor.boiler_dhw_current_intern_temperature",
};

const ENERGY_KEYS = ["eCompressor", "eCompHeating", "eCompDhw", "eAux", "eAuxDhw", "eTotal", "qTotal", "qHeating", "qDhw"];
const CHECK_ONLY_KEYS = ["eCompDhw", "eTotal"];
const TEMP_KEYS = ["tOutside", "tFlow", "tDhw"];

/**
 * Merges user overrides into the defaults. An override of null or "" disables that entity.
 * Returns the key→id map plus the ID lists used for the different queries.
 */
export function resolveEntities(overrides = {}) {
  const ids = {};
  for (const [k, def] of Object.entries(DEFAULT_ENTITIES)) {
    const v = k in overrides ? overrides[k] : def;
    if (v) ids[k] = v;
  }
  const pick = (keys) => keys.filter((k) => ids[k]).map((k) => ids[k]);
  return {
    ids,
    energyIds: pick(ENERGY_KEYS),
    // today / current month: without the two check-only counters (fewer queries)
    periodIds: pick(ENERGY_KEYS.filter((k) => !CHECK_ONLY_KEYS.includes(k))),
    tempIds: pick(TEMP_KEYS),
  };
}

/** Ratio, or null if the denominator is too small to be meaningful. */
export function ratio(num, den, minDen = 0.5) {
  if (num == null || den == null || !(den >= minDen)) return null;
  return num / den;
}

/**
 * Derives all figures of a period from counter deltas.
 * `d` holds deltas (kWh) per DEFAULT_ENTITIES key; missing values are undefined.
 *
 *   E_hp_heating = Δ eCompHeating
 *   E_hp_dhw     = Δ eCompressor − Δ eCompHeating
 *   E_aux        = Δ eAux
 *   E_aux_dhw    = Δ eAuxDhw (clamped to [0, E_aux])
 *   E_aux_heat   = E_aux − E_aux_dhw
 *   E_total      = Δ eCompressor + Δ eAux        (not eTotal, see README)
 *   Q_*          = Δ heat counters (they include the backup heater's heat)
 *   Environment  = Q_total − E_total
 */
export function derive(d) {
  const has = (k) => typeof d[k] === "number" && Number.isFinite(d[k]);
  if (!has("eCompressor") || !has("eAux") || !has("qTotal")) {
    return { complete: false };
  }
  const eWpHeat = has("eCompHeating") ? d.eCompHeating : null;
  const eWpDhw = eWpHeat != null ? Math.max(0, d.eCompressor - eWpHeat) : null;
  const eAux = Math.max(0, d.eAux);
  const eAuxDhw = has("eAuxDhw") ? Math.min(Math.max(0, d.eAuxDhw), eAux) : null;
  const eAuxHeat = eAuxDhw != null ? eAux - eAuxDhw : null;
  const eWp = d.eCompressor;
  const eTotal = eWp + eAux;
  const qTotal = d.qTotal;
  const qHeat = has("qHeating") ? d.qHeating : null;
  const qDhw = has("qDhw") ? d.qDhw : null;
  const eHeat = eWpHeat != null && eAuxHeat != null ? eWpHeat + eAuxHeat : null;
  const eDhw = eWpDhw != null && eAuxDhw != null ? eWpDhw + eAuxDhw : null;

  return {
    complete: true,
    electric: {
      total: eTotal, heatPump: eWp, aux: eAux,
      heating: eHeat, dhw: eDhw,
      heatPumpHeating: eWpHeat, heatPumpDhw: eWpDhw,
      auxHeating: eAuxHeat, auxDhw: eAuxDhw,
      auxShare: ratio(eAux, eTotal), // 0..1
    },
    heat: {
      total: qTotal, heating: qHeat, dhw: qDhw,
      environment: Math.max(0, qTotal - eTotal),
    },
    efficiency: {
      total: ratio(qTotal, eTotal),
      heating: ratio(qHeat, eHeat),
      dhw: ratio(qDhw, eDhw),
    },
    checks: {
      // deviations for plausibility checks (kWh); null if the source is missing
      heatSum: qHeat != null && qDhw != null ? qTotal - qHeat - qDhw : null,
      meterTotal: has("eTotal") ? d.eTotal - eTotal : null,
      dhwMeter: has("eCompDhw") && eWpDhw != null ? d.eCompDhw - eWpDhw : null,
    },
  };
}

/**
 * Turns a recorder/statistics_during_period response into values per bucket.
 * Returns Map<bucketStartMs, {key: value}> with keys of the given id map.
 */
export function bucketize(statsResponse, ids = DEFAULT_ENTITIES) {
  const keyOf = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  const buckets = new Map();
  for (const [sid, rows] of Object.entries(statsResponse || {})) {
    const key = keyOf[sid];
    if (!key) continue;
    for (const r of rows) {
      const start = typeof r.start === "number" ? r.start : Date.parse(r.start);
      if (!buckets.has(start)) buckets.set(start, {});
      const val = r.change ?? r.mean;
      if (typeof val === "number") buckets.get(start)[key] = val;
    }
  }
  return buckets;
}

/** Sums several delta objects (e.g. months → year). Temperatures are not summed. */
export function sumDeltas(list) {
  const out = {};
  for (const d of list) {
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith("t")) continue;
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

/** Locale-aware number formatting; "–" for missing values. */
export function fmt(value, digits = 0, locale = "en") {
  if (value == null || !Number.isFinite(value)) return "–";
  return value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
