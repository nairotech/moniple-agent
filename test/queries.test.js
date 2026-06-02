const { test } = require("node:test");
const assert = require("node:assert");
const QUERIES = require("../lib/queries");

// Every query consumed by the collectors (lib/collectors.js) must be present and
// non-empty. This is a canary against accidentally dropping a query during edits.
const REQUIRED_KEYS = [
  "NS",
  "PVC_USAGE",
  "PVC_TOTAL",
  "PVC_INFO",
  "PVC_CAPACITY",
  "POD_STATUS",
  "POD_CPU_USAGE",
  "POD_MEMORY_USAGE",
  "POD_OWNER",
  "RS_OWNER",
  "NODE_INFO",
  "NODE_INFO_EXPORTER",
  "NODE_INFO_KSM",
  "NODE_MEMORY_USAGE",
  "NODE_MEMORY_TOTAL",
  "NODE_DISK_USAGE",
  "NODE_DISK_USAGE_CADVISOR",
  "NODE_DISK_TOTAL",
  "NODE_DISK_TOTAL_CADVISOR",
  "NODE_CPU_USAGE",
  "NODE_CPU_TOTAL",
  "NODE_POD_USAGE",
  "NODE_POD_TOTAL",
];

test("all required PromQL queries are present and non-empty", () => {
  for (const k of REQUIRED_KEYS) {
    assert.ok(
      typeof QUERIES[k] === "string" && QUERIES[k].length > 0,
      `missing/empty query: ${k}`,
    );
  }
});
