import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ENTITIES, resolveEntities, bucketize, derive, sumDeltas, fmt, ratio } from "../src/model.js";
import { month, MONTHS } from "./fixture.mjs";

const close = (a, b, tol = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

test("derive: identities hold in every month", () => {
  for (let i = 0; i < MONTHS; i++) {
    const d = month(i), r = derive(d), e = r.electric;
    close(e.total, d.eCompressor + d.eAux, 1e-9, `E_total ${i}`);
    close(e.heating + e.dhw, e.total, 1e-9, `E split ${i}`);
    close(e.heatPump + e.aux, e.total, 1e-9, `E sources ${i}`);
    close(r.heat.environment + e.total, r.heat.total, 1e-9, `environment ${i}`);
    close(r.checks.heatSum, 0, 1e-9, `heat sum ${i}`);
    close(r.checks.meterTotal, 0, 1e-9, `meter total ${i}`);
    close(r.checks.dhwMeter, 0, 1e-9, `dhw meter ${i}`);
  }
});

test("derive: backup heater split and performance factors", () => {
  const r = derive({ eCompressor: 100, eCompHeating: 70, eAux: 20, eAuxDhw: 5, qTotal: 360, qHeating: 280, qDhw: 80 });
  assert.equal(r.electric.heatPumpDhw, 30);
  assert.equal(r.electric.auxHeating, 15);
  assert.equal(r.electric.heating, 85);
  assert.equal(r.electric.dhw, 35);
  close(r.electric.auxShare, 20 / 120);
  close(r.efficiency.total, 3);
  close(r.efficiency.heating, 280 / 85);
  close(r.efficiency.dhw, 80 / 35);
  assert.equal(r.heat.environment, 240);
});

test("derive: backup DHW counter is clamped to the backup total", () => {
  const r = derive({ eCompressor: 10, eCompHeating: 8, eAux: 0.4, eAuxDhw: 1, qTotal: 30 });
  assert.equal(r.electric.auxDhw, 0.4);
  assert.equal(r.electric.auxHeating, 0);
});

test("derive: incomplete input gives complete=false instead of made-up values", () => {
  assert.equal(derive({}).complete, false);
  assert.equal(derive({ eCompressor: 5, eAux: 0 }).complete, false);
  const r = derive({ eCompressor: 5, eAux: 0, qTotal: 15 });
  assert.equal(r.complete, true);
  assert.equal(r.efficiency.heating, null);
  assert.equal(r.electric.dhw, null);
});

test("ratio returns null for tiny denominators", () => {
  assert.equal(ratio(3, 0.1), null);
  assert.equal(ratio(null, 5), null);
  assert.equal(ratio(6, 2), 3);
});

test("resolveEntities: defaults, overrides and disabling", () => {
  const def = resolveEntities();
  assert.equal(def.ids.qTotal, DEFAULT_ENTITIES.qTotal);
  assert.equal(def.energyIds.length, 9);
  assert.equal(def.periodIds.length, 7); // without the two check-only counters
  assert.equal(def.tempIds.length, 3);
  const o = resolveEntities({ qTotal: "sensor.my_heat", eTotal: null, tDhw: "" });
  assert.equal(o.ids.qTotal, "sensor.my_heat");
  assert.ok(!("eTotal" in o.ids));
  assert.ok(!o.tempIds.includes(DEFAULT_ENTITIES.tDhw));
  assert.equal(o.energyIds.length, 8);
});

test("bucketize maps statistic IDs to keys, also with overrides", () => {
  const { ids } = resolveEntities({ qTotal: "sensor.my_heat" });
  const res = {
    "sensor.my_heat": [{ start: 1000, change: 12 }],
    [DEFAULT_ENTITIES.tOutside]: [{ start: "1970-01-01T00:00:01Z", mean: 4.5 }],
    "sensor.unrelated": [{ start: 1000, change: 99 }],
  };
  const b = bucketize(res, ids);
  assert.deepEqual(b.get(1000), { qTotal: 12, tOutside: 4.5 });
});

test("sumDeltas sums energy but not temperatures; yearly figures stay consistent", () => {
  const year = sumDeltas(Array.from({ length: 12 }, (_, i) => month(4 + i))); // Jan … Dec 2025
  assert.ok(!("tOutside" in year));
  const r = derive(year);
  close(r.electric.heating + r.electric.dhw, r.electric.total, 1e-6);
  assert.ok(r.efficiency.total > 2 && r.efficiency.total < 4);
});

test("fmt follows the locale", () => {
  assert.equal(fmt(13210.92, 1, "de-DE"), "13.210,9");
  assert.equal(fmt(13210.92, 1, "en-US"), "13,210.9");
  assert.equal(fmt(null), "–");
});
