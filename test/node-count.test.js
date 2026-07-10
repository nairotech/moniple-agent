/**
 * Regression test for the doubled overview node count (2026-07-10).
 *
 * QUERIES.NODE_INFO is `node_uname_info or kube_node_info`. PromQL `or` is a
 * UNION keyed on label sets — and the two metrics have disjoint labels
 * (exporter: nodename+instance, KSM: node), so every node yields BOTH series
 * when both exporters run (the default install). getOverviewData counted raw
 * series, showing exactly 2x nodes in the dashboard's overview chip while the
 * per-node list (KSM-authoritative, deduped) stayed correct.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const { countDistinctNodes } = require("../lib/collectors");

const exporterSeries = (nodename, instance) => ({
  metric: { __name__: "node_uname_info", nodename, instance, job: "node-exporter" },
  value: [0, "1"],
});
const ksmSeries = (node) => ({
  metric: { __name__: "kube_node_info", node, instance: "ksm:8080", job: "kube-state-metrics" },
  value: [0, "1"],
});

test("union of exporter + KSM series counts each node once (the 2x bug)", () => {
  const union = [
    exporterSeries("worker-1", "10.0.0.1:9100"),
    exporterSeries("worker-2", "10.0.0.2:9100"),
    exporterSeries("control", "10.0.0.3:9100"),
    ksmSeries("worker-1"),
    ksmSeries("worker-2"),
    ksmSeries("control"),
  ];
  assert.strictEqual(union.length, 6); // what the old code reported
  assert.strictEqual(countDistinctNodes(union), 3);
});

test("single-source lists still count correctly", () => {
  assert.strictEqual(countDistinctNodes([ksmSeries("a"), ksmSeries("b")]), 2);
  assert.strictEqual(
    countDistinctNodes([exporterSeries("a", "10.0.0.1:9100")]),
    1,
  );
});

test("double-scraped exporter (same nodename, two instances) counts once", () => {
  assert.strictEqual(
    countDistinctNodes([
      exporterSeries("worker-1", "10.0.0.1:9100"),
      exporterSeries("worker-1", "worker-1:9100"),
    ]),
    1,
  );
});

test("empty / malformed input is safe", () => {
  assert.strictEqual(countDistinctNodes([]), 0);
  assert.strictEqual(countDistinctNodes(undefined), 0);
  assert.strictEqual(countDistinctNodes([{ metric: {} }, {}]), 0);
});
