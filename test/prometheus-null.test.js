/**
 * queryPrometheus must distinguish "no data" from "query failed" (2026-08-12).
 *
 * It used to return [] on timeouts and API errors, which the overview collector
 * turned into `0%`. Measured on the live fleet: 21 one-minute readings of
 * `memory: 0%` for one cluster in 3 days (and 8-12 for two others) — a value a
 * running cluster can never legitimately have. Those zeros were pushed to the
 * server and written into the history series.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const prometheus = require("../lib/prometheus");
const { queryPrometheus } = prometheus;

function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return fn().finally(() => {
    global.fetch = original;
  });
}

const jsonResponse = (body) => ({ json: async () => body });

test("a successful query returns its result array", async () => {
  await withFetch(
    async () => jsonResponse({ status: "success", data: { result: [{ metric: {}, value: [1, "5"] }] } }),
    async () => {
      const out = await queryPrometheus("up");
      assert.ok(Array.isArray(out));
      assert.strictEqual(out.length, 1);
    },
  );
});

test("a successful but empty query returns [] — a real, measured emptiness", async () => {
  await withFetch(
    async () => jsonResponse({ status: "success", data: { result: [] } }),
    async () => {
      assert.deepStrictEqual(await queryPrometheus("up"), []);
    },
  );
});

test("an API error returns null, NOT an empty array", async () => {
  await withFetch(
    async () => jsonResponse({ status: "error", error: "bad query" }),
    async () => {
      assert.strictEqual(await queryPrometheus("up"), null);
    },
  );
});

test("a transport failure returns null", async () => {
  await withFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      assert.strictEqual(await queryPrometheus("up"), null);
    },
  );
});

test("a timeout (abort) returns null", async () => {
  await withFetch(
    async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    },
    async () => {
      assert.strictEqual(await queryPrometheus("up"), null);
    },
  );
});

test("the alert-fetching surface is fully removed (2026-08-12 retirement)", () => {
  // fetchAlerts() used to hit `${apiUrl}/alerts` with a legacy []-on-failure
  // contract; no live cluster runs vmalert, so it always returned []. Removed
  // along with the rest of the alert-ingest pipeline (collectors.getAlertsData,
  // the agent's GET /metrics/alerts route, and the pushed `alerts` snapshot).
  assert.strictEqual(prometheus.fetchAlerts, undefined);
  assert.deepStrictEqual(Object.keys(prometheus).sort(), ["queryPrometheus"]);
});
