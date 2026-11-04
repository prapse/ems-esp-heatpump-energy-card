// Smoke test of the bundled card with a minimal DOM shim and a mock `hass`:
// loading, monthly aggregation, start-month detection and the user_data month cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { derive, sumDeltas, DEFAULT_ENTITIES } from "../src/model.js";
import { month, monthStartMs, MONTHS } from "./fixture.mjs";

// --- minimal DOM shim (only what the card touches) ---
globalThis.HTMLElement = class { attachShadow() { this.shadowRoot = { innerHTML: "", querySelectorAll: () => [] }; return this.shadowRoot; } };
const registry = new Map();
globalThis.customElements = { get: (n) => registry.get(n), define: (n, c) => registry.set(n, c) };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
console.info = () => {};

await import(pathToFileURL(new URL("../dist/ems-esp-heatpump-energy-card.js", import.meta.url).pathname).href);
const Card = registry.get("ems-esp-heatpump-energy-card");

// Pretend "now" is 15 Nov 2026 12:00 Berlin: Sep 2024 … Oct 2026 are closed months.
const NOW = Date.UTC(2026, 10, 15, 11);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

const keyOf = Object.fromEntries(Object.entries(DEFAULT_ENTITIES).map(([k, v]) => [v, k]));
function mockHass() {
  const userData = {};
  const calls = { stats: 0 };
  return {
    calls, userData,
    config: { time_zone: "Europe/Berlin" },
    locale: { language: "de" },
    states: { "sensor.boiler_az": { state: "3.5" } },
    async callWS(m) {
      if (m.type === "frontend/get_user_data") return { value: userData[m.key] };
      if (m.type === "frontend/set_user_data") { userData[m.key] = structuredClone(m.value); return null; }
      calls.stats++;
      const s = Date.parse(m.start_time), e = Date.parse(m.end_time), out = {};
      for (const id of m.statistic_ids) {
        const k = keyOf[id];
        if (m.period !== "month") { out[id] = [{ start: s, change: 0.5 }]; continue; }
        const rows = [];
        for (let i = 0; i < MONTHS + 1; i++) {
          const st = monthStartMs(i);
          if (st < s || st >= e) continue;
          const v = i < MONTHS ? month(i)[k] : month(i)[k] / 2; // Nov 2026: half a month so far
          rows.push(k.startsWith("t") ? { start: st, mean: v } : { start: st, change: v });
        }
        if (rows.length) out[id] = rows;
      }
      return out;
    },
  };
}

async function loaded(card) {
  for (let i = 0; i < 200 && (card._loading || !card._data || card._data.historyLoading); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(card._error, null);
}

test("first load detects the start month, aggregates years and fills the cache", async () => {
  const hass = mockHass();
  const card = new Card();
  card.setConfig({});
  card.hass = hass;
  await loaded(card);
  assert.equal(card._data.firstMonth, "2024-09");
  assert.equal(card._data.months.size, MONTHS + 1);
  const y2025 = derive(card._yearDeltas(2025));
  const ref = derive(sumDeltas(Array.from({ length: 12 }, (_, i) => month(4 + i))));
  assert.ok(Math.abs(y2025.electric.total - ref.electric.total) < 1e-6);
  assert.ok(Math.abs(y2025.efficiency.total - ref.efficiency.total) < 1e-9);
  const cache = hass.userData.ems_esp_hp_energy_card;
  assert.equal(cache.first, "2024-09");
  assert.equal(Object.keys(cache.months).length, MONTHS); // closed months only, not Nov 2026
  assert.ok(!("2026-11" in cache.months));
  assert.ok(card.shadowRoot.innerHTML.includes("Verbrauchte Energie")); // German UI from hass.locale
});

test("second load takes closed months from the cache and queries only the open month", async () => {
  const hass = mockHass();
  const a = new Card(); a.setConfig({}); a.hass = hass; await loaded(a);
  const before = hass.calls.stats;
  const b = new Card(); b.setConfig({ debug: true }); b.hass = hass; await loaded(b);
  assert.equal(b._data.loadInfo.cached, MONTHS);
  assert.equal(b._data.months.size, MONTHS + 1);
  // the month query for the open month must not reach back into cached months
  assert.ok(hass.calls.stats - before <= 7 + 7 + 9 + 3);
  const y = derive(b._yearDeltas(2025)), ya = derive(a._yearDeltas(2025));
  assert.equal(y.electric.total, ya.electric.total);
});

test("English UI and number format for an English locale", async () => {
  const hass = { ...mockHass(), locale: { language: "en" } };
  const card = new Card(); card.setConfig({ default_view: "efficiency" }); card.hass = hass; await loaded(card);
  const html = card.shadowRoot.innerHTML;
  assert.ok(html.includes("SPF"));
  assert.ok(html.includes("Efficiency"));
});

test("changing an entity invalidates the cache", async () => {
  const hass = mockHass();
  const a = new Card(); a.setConfig({}); a.hass = hass; await loaded(a);
  const b = new Card(); b.setConfig({ entities: { eTotal: null }, debug: true }); b.hass = hass; await loaded(b);
  assert.equal(b._data.loadInfo.cached, 0);
});
