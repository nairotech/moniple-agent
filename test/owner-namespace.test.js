/**
 * Owner resolution across the exported_namespace split (2026-08-12).
 *
 * kube-state-metrics series arrive under `exported_namespace` on some setups
 * (VictoriaMetrics relabels a colliding `namespace` label that way), which is
 * why the pod key already used `exported_namespace || namespace`. The owner
 * lookup map did NOT: it keyed on `metric.namespace` alone, so on those
 * clusters every key became "undefined/<pod>", nothing ever matched, and every
 * pod was published as owner-less. That is invisible in the UI — pods still
 * render — but it silently destroys workload grouping, which the server now
 * relies on to aggregate VictoriaMetrics series per workload.
 *
 * Same require-cache stub pattern as metric-accuracy.test.js: `lib/collectors`
 * destructures prometheus functions at import time, and `node --test` isolates
 * each file in its own process.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const QUERIES = require("../lib/queries");

const promPath = require.resolve("../lib/prometheus");
let RESULTS = new Map();
require.cache[promPath] = {
  id: promPath,
  filename: promPath,
  loaded: true,
  exports: {
    queryPrometheus: async (q) => (RESULTS.has(q) ? RESULTS.get(q) : []),
  },
};

const collectors = require("../lib/collectors");

/** Build the query results for one pod owned by a Deployment via a ReplicaSet. */
function fixture({ nsLabel }) {
  // `nsLabel` is the label name kube-state-metrics lands on: "namespace" or
  // "exported_namespace". cAdvisor series always use plain "namespace".
  const ksm = (extra) => ({ [nsLabel]: "prod", ...extra });

  const results = new Map();
  results.set(QUERIES.POD_STATUS, [
    { metric: ksm({ pod: "api-7f7fb8b8df-bbk72", phase: "Running" }), value: [0, "1"] },
  ]);
  results.set(QUERIES.POD_OWNER, [
    {
      metric: ksm({
        pod: "api-7f7fb8b8df-bbk72",
        owner_kind: "ReplicaSet",
        owner_name: "api-7f7fb8b8df",
      }),
      value: [0, "1"],
    },
  ]);
  results.set(QUERIES.RS_OWNER, [
    {
      metric: ksm({
        replicaset: "api-7f7fb8b8df",
        owner_kind: "Deployment",
        owner_name: "api",
      }),
      value: [0, "1"],
    },
  ]);
  results.set(QUERIES.POD_CPU_USAGE, [
    { metric: { namespace: "prod", pod: "api-7f7fb8b8df-bbk72" }, value: [0, "0.25"] },
  ]);
  results.set(QUERIES.POD_MEMORY_USAGE, [
    { metric: { namespace: "prod", pod: "api-7f7fb8b8df-bbk72" }, value: [0, "104857600"] },
  ]);
  return results;
}

test("resolves the Deployment owner when KSM uses plain namespace", async () => {
  RESULTS = fixture({ nsLabel: "namespace" });
  const data = await collectors.getPodData();
  const pod = data.pods[0];

  assert.strictEqual(pod.namespace, "prod");
  assert.strictEqual(pod.ownerKind, "Deployment");
  assert.strictEqual(pod.ownerName, "api");
});

test("resolves the Deployment owner when KSM uses exported_namespace", async () => {
  // This is the regression: before the fix the owner map keyed on
  // metric.namespace (undefined here), so the lookup missed and the pod was
  // published owner-less.
  RESULTS = fixture({ nsLabel: "exported_namespace" });
  const data = await collectors.getPodData();
  const pod = data.pods[0];

  assert.strictEqual(pod.namespace, "prod");
  assert.strictEqual(
    pod.ownerKind,
    "Deployment",
    "owner must resolve through the ReplicaSet even when KSM labels are exported_*",
  );
  assert.strictEqual(pod.ownerName, "api");
});

test("both namespace label spellings produce identical owner output", async () => {
  RESULTS = fixture({ nsLabel: "namespace" });
  const plain = (await collectors.getPodData()).pods[0];

  RESULTS = fixture({ nsLabel: "exported_namespace" });
  const exported = (await collectors.getPodData()).pods[0];

  assert.deepStrictEqual(
    { ns: exported.namespace, kind: exported.ownerKind, name: exported.ownerName },
    { ns: plain.namespace, kind: plain.ownerKind, name: plain.ownerName },
  );
});
