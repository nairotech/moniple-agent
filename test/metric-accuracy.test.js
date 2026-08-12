/**
 * Metric accuracy rework (2026-08-12).
 *
 * Diagnosed against live clusters:
 *   - the cluster number was the MEAN of the per-node percentages, so a node at
 *     90.7% memory was published as 51.9% (users compare against
 *     `kubectl top nodes`, where they see the hot node);
 *   - node memory came from node_memory_MemAvailable, which counts reclaimable
 *     page cache/slab as free — 13% below the kubelet working set the whole of
 *     Kubernetes (kubectl top, metrics-server, eviction) uses;
 *   - node CPU used `1 - avg(idle)`, which charges CPU time the guest kernel
 *     never accounted for to usage (measured ~2x overstatement on a KVM node);
 *   - disk percentage and disk total described different filesystems;
 *   - a failed query returned [] and was published as a healthy 0%.
 *
 * These tests pin the fixed behaviour. `lib/prometheus` is replaced in the
 * require cache before `lib/collectors` is loaded, because the collector
 * destructures its functions at import time. `node --test` runs every test file
 * in its own process, so the cache surgery cannot leak into other files.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const QUERIES = require("../lib/queries");

// ---------------------------------------------------------------------------
// prometheus stub
// ---------------------------------------------------------------------------
const promPath = require.resolve("../lib/prometheus");
// query string -> result (Array = success, null = query failure)
let RESULTS = new Map();
let ALERTS = [];
require.cache[promPath] = {
  id: promPath,
  filename: promPath,
  loaded: true,
  exports: {
    queryPrometheus: async (q) => (RESULTS.has(q) ? RESULTS.get(q) : []),
    fetchAlerts: async () => ALERTS,
  },
};

const collectors = require("../lib/collectors");

const series = (metric, value) => ({ metric, value: [1786531423, String(value)] });

function setup(map, alerts = []) {
  RESULTS = new Map(Object.entries(map));
  ALERTS = alerts;
}

// A cluster of KSM-listed nodes with kubelet (cAdvisor) CPU/memory, one
// filesystem each and KSM capacities — i.e. the shape of a healthy install.
function clusterFixture(nodes) {
  return {
    [QUERIES.NODE_INFO_KSM]: nodes.map((n) => series({ node: n.name }, 1)),
    [QUERIES.NODE_INFO_EXPORTER]: nodes
      .filter((n) => n.instance)
      .map((n) => series({ nodename: n.name, instance: n.instance }, 1)),
    [QUERIES.NODE_MEMORY_WORKING_SET]: nodes
      .filter((n) => n.workingSet != null)
      .map((n) => series({ instance: n.name }, n.workingSet)),
    [QUERIES.NODE_MEMORY_TOTAL]: nodes
      .filter((n) => n.memAllocatable != null)
      .map((n) => series({ node: n.name }, n.memAllocatable)),
    [QUERIES.NODE_CPU_CORES_USED]: nodes
      .filter((n) => n.cpuCores != null)
      .map((n) => series({ instance: n.name }, n.cpuCores)),
    [QUERIES.NODE_CPU_TOTAL]: nodes
      .filter((n) => n.cpuAllocatable != null)
      .map((n) => series({ node: n.name }, n.cpuAllocatable)),
    [QUERIES.NODE_FS_SIZE]: nodes.flatMap((n) =>
      (n.filesystems || []).map((f) =>
        series(
          { instance: n.instance || n.name, mountpoint: f.mountpoint, device: f.device },
          f.size,
        ),
      ),
    ),
    [QUERIES.NODE_FS_AVAIL]: nodes.flatMap((n) =>
      (n.filesystems || []).map((f) =>
        series(
          { instance: n.instance || n.name, mountpoint: f.mountpoint, device: f.device },
          f.avail,
        ),
      ),
    ),
    [QUERIES.NODE_POD_USAGE]: nodes
      .filter((n) => n.podUsage != null)
      .map((n) => series({ node: n.name }, n.podUsage)),
    [QUERIES.NODE_POD_TOTAL]: nodes.map((n) => series({ node: n.name }, n.podTotal ?? 110)),
    [QUERIES.POD_STATUS]: [],
  };
}

// ---------------------------------------------------------------------------
// 1. Cluster number = worst node (the headline semantics change)
// ---------------------------------------------------------------------------
test("cluster summary reports the WORST node, keeps the mean as `avg`", async () => {
  setup(
    clusterFixture([
      { name: "a", memAllocatable: 100, workingSet: 20, cpuAllocatable: 10, cpuCores: 1 },
      { name: "b", memAllocatable: 100, workingSet: 90, cpuAllocatable: 10, cpuCores: 5 },
      { name: "c", memAllocatable: 100, workingSet: 40, cpuAllocatable: 10, cpuCores: 3 },
    ]),
  );

  const { summary } = await collectors.getNodeData();

  // The old flat mean was 50 — a node at 90% was published as 50%.
  assert.strictEqual(summary.memory.usage, 90);
  assert.strictEqual(summary.memory.avg, 50);
  assert.strictEqual(summary.memory.worstNode, "b");

  assert.strictEqual(summary.cpu.usage, 50); // 5 cores of 10 allocatable
  assert.strictEqual(summary.cpu.avg, 30);
  assert.strictEqual(summary.cpu.worstNode, "b");
});

test("overview publishes the same worst-node value as the node summary", async () => {
  setup(
    clusterFixture([
      { name: "a", memAllocatable: 100, workingSet: 10, cpuAllocatable: 10, cpuCores: 1 },
      { name: "hot", memAllocatable: 100, workingSet: 88, cpuAllocatable: 10, cpuCores: 2 },
    ]),
  );

  const nodeData = await collectors.getNodeData();
  const overview = await collectors.getOverviewData();

  assert.strictEqual(overview.usage.memory.value, nodeData.summary.memory.usage);
  assert.strictEqual(overview.usage.memory.value, 88);
  assert.strictEqual(overview.usage.memory.avg, 49);
  assert.strictEqual(overview.usage.memory.worstNode, "hot");
});

test("pod pressure is worst-node too (a node at its pod cap must not be averaged away)", async () => {
  setup(
    clusterFixture([
      { name: "a", podUsage: 10, podTotal: 110 },
      { name: "full", podUsage: 100, podTotal: 110 },
    ]),
  );
  const { summary } = await collectors.getNodeData();
  assert.strictEqual(summary.pod.usage, 100);
  assert.strictEqual(summary.pod.avg, 55);
  assert.strictEqual(summary.pod.worstNode, "full");
});

// ---------------------------------------------------------------------------
// 2. Blind nodes stay visible
// ---------------------------------------------------------------------------
test("nodes without metrics are null, excluded from the aggregate, and counted in `reporting`", async () => {
  setup(
    clusterFixture([
      { name: "reporting", memAllocatable: 100, workingSet: 60, cpuAllocatable: 4, cpuCores: 1 },
      { name: "blind", memAllocatable: 100 }, // KSM knows it; nothing measures it
    ]),
  );

  const { summary, nodes } = await collectors.getNodeData();
  const blind = nodes.find((n) => n.name === "blind");

  assert.strictEqual(blind.memory.usage, null);
  assert.strictEqual(blind.cpu.usage, null);
  assert.strictEqual(blind.disk.usage, null);
  assert.strictEqual(blind.memory.critical, false, "null must never read as critical");

  assert.strictEqual(summary.memory.usage, 60);
  assert.deepStrictEqual(summary.reporting, { nodesWithData: 1, nodeCount: 2 });
  assert.strictEqual(summary.nodeCount, 2);
});

test("overview carries the reporting counts so a partial cluster can say so", async () => {
  setup(
    clusterFixture([
      { name: "a", memAllocatable: 100, workingSet: 50 },
      { name: "b" },
      { name: "c" },
    ]),
  );
  const overview = await collectors.getOverviewData();
  assert.deepStrictEqual(overview.reporting, { nodesWithData: 1, nodeCount: 3 });
});

// ---------------------------------------------------------------------------
// 3. Memory definition: kubelet working set / allocatable
// ---------------------------------------------------------------------------
test("memory uses the kubelet working set over allocatable, not MemAvailable", async () => {
  // Live nairotech numbers: 4.776 GB working set, 24.289 GB allocatable
  // (= 19.7%). The node-exporter formula reported 16.4% for the same instant.
  const fixture = clusterFixture([
    { name: "n1", instance: "10.0.0.1:9101", workingSet: 4776439808, memAllocatable: 24289017856 },
  ]);
  fixture[QUERIES.NODE_MEMORY_USAGE] = [series({ instance: "10.0.0.1:9101" }, 16.34)];
  setup(fixture);

  const { nodes } = await collectors.getNodeData();
  assert.strictEqual(nodes[0].memory.usage, 19.7);
  assert.strictEqual(nodes[0].memory.source, "kubelet");
  assert.notStrictEqual(nodes[0].memory.usage, 16.3, "must not use the MemAvailable formula");
});

test("memory falls back to node-exporter when the kubelet series is missing (and says so)", async () => {
  const fixture = clusterFixture([
    { name: "n1", instance: "10.0.0.1:9101", memAllocatable: 24289017856 },
  ]);
  fixture[QUERIES.NODE_MEMORY_USAGE] = [series({ instance: "10.0.0.1:9101" }, 16.34)];
  setup(fixture);

  const { nodes } = await collectors.getNodeData();
  assert.strictEqual(nodes[0].memory.usage, 16.3);
  assert.strictEqual(nodes[0].memory.source, "node-exporter");
});

test("memory total is allocatable — the same denominator the percentage uses", async () => {
  setup(
    clusterFixture([
      { name: "n1", workingSet: 4776439808, memAllocatable: 24289017856 },
    ]),
  );
  const { nodes } = await collectors.getNodeData();
  // 24289017856 bytes = 22.6 GiB, and 19.7% of it is the reported working set.
  assert.strictEqual(nodes[0].memory.total, 22.6);
  assert.strictEqual(nodes[0].memory.unit.total, "GiB");
  const impliedBytes = (nodes[0].memory.usage / 100) * 24289017856;
  assert.ok(Math.abs(impliedBytes - 4776439808) / 4776439808 < 0.01);
});

// ---------------------------------------------------------------------------
// 4. CPU definition: kubelet cores / allocatable cores
// ---------------------------------------------------------------------------
test("cpu uses kubelet cores over allocatable cores", async () => {
  setup(clusterFixture([{ name: "n1", cpuCores: 1.05, cpuAllocatable: 7.4 }]));
  const { nodes } = await collectors.getNodeData();
  assert.strictEqual(nodes[0].cpu.usage, 14.2); // matches `kubectl top node`
  assert.strictEqual(nodes[0].cpu.source, "kubelet");
  assert.strictEqual(nodes[0].cpu.total, 7.4);
});

test("cpu fallback is the busy-mode sum, never `1 - avg(idle)`", async () => {
  const fixture = clusterFixture([{ name: "n1", instance: "10.0.0.1:9101", cpuAllocatable: 8 }]);
  fixture[QUERIES.NODE_CPU_USAGE] = [series({ instance: "10.0.0.1:9101" }, 12.6)];
  setup(fixture);

  const { nodes } = await collectors.getNodeData();
  assert.strictEqual(nodes[0].cpu.usage, 12.6);
  assert.strictEqual(nodes[0].cpu.source, "node-exporter");

  // The query itself must not reintroduce the inflating formula.
  assert.ok(!/1 - avg/.test(QUERIES.NODE_CPU_USAGE), "1 - avg(idle) charges unaccounted CPU time to usage");
  assert.ok(QUERIES.NODE_CPU_USAGE.includes('mode!="idle"'));
  assert.ok(QUERIES.NODE_CPU_USAGE.includes("count by (instance)"));
});

// ---------------------------------------------------------------------------
// 5. Disk: fullest real filesystem, percentage and total from the SAME device
// ---------------------------------------------------------------------------
test("disk reports the fullest filesystem and its own size as the total", async () => {
  setup(
    clusterFixture([
      {
        name: "n1",
        instance: "10.0.0.1:9101",
        filesystems: [
          // Root looks nearly empty; the container data disk is what is full —
          // the exact layout the old root-only query under-reported.
          { mountpoint: "/", device: "/dev/sda1", size: 200e9, avail: 140e9 },
          { mountpoint: "/var/lib/containerd", device: "/dev/sdb1", size: 100e9, avail: 15e9 },
        ],
      },
    ]),
  );

  const { nodes } = await collectors.getNodeData();
  assert.strictEqual(nodes[0].disk.usage, 85);
  assert.strictEqual(nodes[0].disk.mountpoint, "/var/lib/containerd");
  assert.strictEqual(nodes[0].disk.source, "node-exporter");
  // 100e9 bytes = 93.1 GiB — the size of the filesystem the 85% refers to,
  // NOT allocatable ephemeral-storage as before.
  assert.strictEqual(nodes[0].disk.total, 93.1);
  assert.strictEqual(nodes[0].disk.unit.total, "GiB");
});

test("disk percentage and total stay consistent (used bytes derivable from what we publish)", async () => {
  setup(
    clusterFixture([
      {
        name: "n1",
        filesystems: [{ mountpoint: "/", device: "/dev/sda1", size: 206900281344, avail: 146064347136 }],
      },
    ]),
  );
  const { nodes } = await collectors.getNodeData();
  assert.strictEqual(nodes[0].disk.usage, 29.4); // matches `df` on the live node
  const totalBytes = nodes[0].disk.total * 1024 ** 3;
  const impliedUsed = (nodes[0].disk.usage / 100) * totalBytes;
  const realUsed = 206900281344 - 146064347136;
  assert.ok(Math.abs(impliedUsed - realUsed) / realUsed < 0.01);
});

test("disk falls back to cAdvisor for nodes without node-exporter", async () => {
  const fixture = clusterFixture([{ name: "n1" }]);
  fixture[QUERIES.NODE_DISK_USAGE_CADVISOR] = [series({ instance: "n1" }, 42.5)];
  fixture[QUERIES.NODE_DISK_TOTAL_CADVISOR] = [series({ instance: "n1" }, 100e9)];
  setup(fixture);

  const { nodes } = await collectors.getNodeData();
  assert.strictEqual(nodes[0].disk.usage, 42.5);
  assert.strictEqual(nodes[0].disk.total, 93.1);
  assert.strictEqual(nodes[0].disk.source, "cadvisor");
});

test("filesystem selector excludes pseudo filesystems and covers separate data disks", async () => {
  for (const q of [QUERIES.NODE_FS_SIZE, QUERIES.NODE_FS_AVAIL]) {
    assert.ok(q.includes('fstype!~'), "must be a deny-list, not an ext/xfs allow-list");
    for (const bad of ["tmpfs", "overlay", "squashfs", "devtmpfs"]) {
      assert.ok(q.includes(bad), `pseudo fs ${bad} must be excluded`);
    }
    assert.ok(q.includes("/var/lib/containerd"), "separate container data disk must be covered");
    assert.ok(q.includes("/var/lib/kubelet"));
    assert.ok(!q.includes('fstype=~"ext.?|xfs"'), "the old allow-list hid btrfs/zfs nodes");
    assert.ok(!/\/var\/lib\/kubelet\/pods/.test(q), "per-pod volume mounts must not turn a node red");
  }
});

// ---------------------------------------------------------------------------
// 6. "No data" is null, never zero
// ---------------------------------------------------------------------------
test("a FAILED query yields null, not a healthy 0%", async () => {
  // null = queryPrometheus signalling failure (timeout / API error).
  setup({
    [QUERIES.NODE_INFO_KSM]: [series({ node: "n1" }, 1)],
    [QUERIES.NODE_MEMORY_WORKING_SET]: null,
    [QUERIES.NODE_MEMORY_USAGE]: null,
    [QUERIES.NODE_CPU_CORES_USED]: null,
    [QUERIES.NODE_CPU_USAGE]: null,
    [QUERIES.NODE_FS_SIZE]: null,
    [QUERIES.NODE_FS_AVAIL]: null,
    [QUERIES.NODE_DISK_USAGE_CADVISOR]: null,
    [QUERIES.POD_STATUS]: null,
  });

  const overview = await collectors.getOverviewData();
  assert.strictEqual(overview.usage.cpu.value, null);
  assert.strictEqual(overview.usage.memory.value, null);
  assert.strictEqual(overview.usage.disk.value, null);
  assert.notStrictEqual(overview.usage.memory.value, 0);
  // Pod counts are unknown too when their query failed.
  assert.strictEqual(overview.cluster.pods.total, null);
  assert.strictEqual(overview.cluster.pods.running, null);
});

test("an EMPTY (but successful) pod query is a real zero", async () => {
  setup(clusterFixture([{ name: "n1", workingSet: 50, memAllocatable: 100 }]));
  const overview = await collectors.getOverviewData();
  assert.strictEqual(overview.cluster.pods.total, 0);
  assert.strictEqual(overview.cluster.pods.running, 0);
});

test("healthy is null when nothing could be measured, boolean when something was", async () => {
  setup({ [QUERIES.NODE_INFO_KSM]: [series({ node: "n1" }, 1)] });
  assert.strictEqual((await collectors.getOverviewData()).healthy, null);

  setup(clusterFixture([{ name: "n1", workingSet: 10, memAllocatable: 100 }]));
  assert.strictEqual((await collectors.getOverviewData()).healthy, true);

  setup(clusterFixture([{ name: "n1", workingSet: 95, memAllocatable: 100 }]));
  const hot = await collectors.getOverviewData();
  assert.strictEqual(hot.healthy, false);
  assert.strictEqual(hot.usage.memory.critical, true);
});

test("sampleValue never turns a non-number into zero", () => {
  const { sampleValue } = collectors;
  assert.strictEqual(sampleValue(series({}, "NaN")), null); // upstream Prometheus emits this
  assert.strictEqual(sampleValue(series({}, "")), null);
  assert.strictEqual(sampleValue(undefined), null);
  assert.strictEqual(sampleValue({ metric: {} }), null);
  assert.strictEqual(sampleValue(series({}, "0")), 0); // a real zero survives
  assert.strictEqual(sampleValue(series({}, "42.5")), 42.5);
});

// ---------------------------------------------------------------------------
// 7. Pod double counting
// ---------------------------------------------------------------------------
test("pod cpu/memory queries filter out the pod cgroup slice and the sandbox", () => {
  for (const q of [QUERIES.POD_CPU_USAGE, QUERIES.POD_MEMORY_USAGE]) {
    assert.ok(q.includes('container!=""'), "pod-level cgroup slice would double every pod");
    assert.ok(q.includes('container!="POD"'), "older cAdvisors label the sandbox container=POD");
  }
});

test("per-pod values are not doubled by the extra cAdvisor series", async () => {
  // What the fixed query returns: ONE series per pod (the container), because
  // the slice/sandbox series carry no `container` label and are filtered out.
  setup({
    [QUERIES.POD_STATUS]: [series({ namespace: "moniple", pod: "agent-1", phase: "Running" }, 1)],
    [QUERIES.POD_MEMORY_USAGE]: [series({ namespace: "moniple", pod: "agent-1" }, 67780608)],
    [QUERIES.POD_CPU_USAGE]: [series({ namespace: "moniple", pod: "agent-1" }, 0.0427)],
  });

  const { pods } = await collectors.getPodData();
  assert.strictEqual(pods[0].memory.value, 64.6); // MiB — was 129.7 with the doubled sum
  assert.strictEqual(pods[0].memory.unit, "MiB");
  assert.strictEqual(pods[0].cpu.value, 0.043);
});

// ---------------------------------------------------------------------------
// 8. Contract preservation (old app builds keep reading the same field names)
// ---------------------------------------------------------------------------
test("legacy snapshot fields are preserved (names unchanged, only semantics)", async () => {
  setup(
    clusterFixture([
      {
        name: "n1",
        workingSet: 50,
        memAllocatable: 100,
        cpuCores: 2,
        cpuAllocatable: 8,
        podUsage: 30,
        filesystems: [{ mountpoint: "/", device: "/dev/sda1", size: 100e9, avail: 50e9 }],
      },
    ]),
  );

  const nodeData = await collectors.getNodeData();
  const overview = await collectors.getOverviewData();

  for (const m of ["cpu", "memory", "disk", "pod"]) {
    for (const f of ["usage", "total", "unit", "critical"]) {
      assert.ok(f in nodeData.summary[m], `summary.${m}.${f} missing`);
    }
    for (const f of ["value", "unit", "critical"]) {
      assert.ok(f in overview.usage[m], `usage.${m}.${f} missing`);
    }
    for (const f of ["usage", "total", "unit", "critical"]) {
      assert.ok(f in nodeData.nodes[0][m], `node.${m}.${f} missing`);
    }
    assert.deepStrictEqual(Object.keys(nodeData.nodes[0][m].unit).sort(), ["total", "usage"]);
  }
  assert.strictEqual(nodeData.ok, true);
  assert.strictEqual(overview.ok, true);
  assert.ok(typeof overview.timestamp === "number");
  assert.ok("nodes" in overview.cluster && "pods" in overview.cluster);
  assert.ok("total" in overview.alerts && "firing" in overview.alerts && "critical" in overview.alerts);
});

test("alerts still drive healthy and the critical counters", async () => {
  setup(clusterFixture([{ name: "n1", workingSet: 10, memAllocatable: 100 }]), [
    { state: "firing", labels: { severity: "critical" } },
    { state: "firing", labels: { severity: "warning" } },
  ]);
  const overview = await collectors.getOverviewData();
  assert.strictEqual(overview.alerts.total, 2);
  assert.strictEqual(overview.alerts.firing, 2);
  assert.strictEqual(overview.alerts.critical, 1);
  assert.strictEqual(overview.healthy, false, "a critical alert must veto healthy");
});
