// ============================================================================
// METRIC COLLECTORS (shape Prometheus/VM data into the agent JSON contract)
// ============================================================================
//
// ACCURACY CONTRACT (2026-08-12 rework)
//
// 1. A cluster-level number is the WORST node, not the average. Users read the
//    dashboard next to `kubectl top nodes`, where they see the hot node; a flat
//    mean hid it (measured on live clusters: 51.9% shown while one node sat at
//    90.7% memory). `summary.<m>.usage` = worst, `.avg` = the old mean (kept
//    for reference), `.worstNode` = which node it came from.
// 2. Node CPU/memory come from the kubelet (cAdvisor root cgroup) divided by
//    ALLOCATABLE — the definition `kubectl top node`, metrics-server and the
//    kubelet's own eviction logic use. node-exporter formulas remain only as a
//    labelled fallback.
// 3. Disk percentage and disk total always describe the SAME filesystem.
// 4. "Could not measure" is null, never 0. A failed query must not publish a
//    healthy-looking zero.
//
// ============================================================================

const CONFIG = require("./config");
const QUERIES = require("./queries");
const { queryPrometheus } = require("./prometheus");
const { formatBytes, round, getTimestamp } = require("./utils");

// NODE_INFO is `node_uname_info or kube_node_info` — a PromQL UNION, not a
// fallback: the two metrics carry disjoint label sets (exporter: nodename +
// instance, KSM: node), so `or` returns BOTH series for every node whenever
// both exporters run — which is the default install. Counting raw series
// therefore doubled the node count. Count distinct node NAMES instead; this
// also absorbs a node-exporter scraped by two jobs (same nodename, different
// instance). Series with no recognizable name label fall back to instance.
function countDistinctNodes(series) {
  const names = new Set();
  for (const item of series || []) {
    const m = item.metric || {};
    const key = m.node || m.nodename || m.exported_node || m.instance;
    if (key) names.add(key);
  }
  return names.size;
}

// Parse a Prometheus sample value.
//
// Returns null — never 0 — for anything that is not a finite number. This is
// the single guard that keeps "no data" from masquerading as "zero": it also
// absorbs Prometheus' literal "NaN" sample values (VictoriaMetrics drops those
// server-side, upstream Prometheus does not), which `round()` would otherwise
// happily turn into a very healthy-looking 0.
function sampleValue(item) {
  if (!item || !Array.isArray(item.value)) return null;
  const n = parseFloat(item.value[1]);
  return Number.isFinite(n) ? n : null;
}

// Does this series belong to `nodeName` (or to its node-exporter `instance`)?
//
// Label conventions differ per monitoring stack, so every known identity label
// is accepted: the bundled scrape config labels kubelet/cAdvisor series with
// instance=<node name> (Prometheus node SD default), kube-prometheus-stack
// keeps instance=<ip:port> and adds `node`, KSM uses `node`, node-exporter uses
// `nodename` + instance=<ip:port>.
function seriesMatchesNode(metric, nodeName, instance) {
  const m = metric || {};
  if (nodeName) {
    if (
      m.node === nodeName ||
      m.instance === nodeName ||
      m.nodename === nodeName ||
      m.exported_node === nodeName ||
      m.kubernetes_io_hostname === nodeName
    ) {
      return true;
    }
  }
  return Boolean(instance) && m.instance === instance;
}

function findNodeSeries(series, nodeName, instance) {
  if (!Array.isArray(series)) return null;
  return (
    series.find((s) => seriesMatchesNode(s.metric, nodeName, instance)) || null
  );
}

// Pair node_filesystem_size_bytes with node_filesystem_avail_bytes per
// (device, mountpoint) for one node and return the FULLEST filesystem.
//
// Selecting in JS (instead of `max by (instance)` over a PromQL ratio) is what
// lets the reported total belong to the very filesystem the percentage was
// computed from.
function pickFullestFilesystem(sizeSeries, availSeries, nodeName, instance) {
  if (!Array.isArray(sizeSeries)) return null;
  const availByKey = new Map();
  for (const a of availSeries || []) {
    const m = a.metric || {};
    if (!seriesMatchesNode(m, nodeName, instance)) continue;
    availByKey.set(`${m.device}|${m.mountpoint}`, sampleValue(a));
  }

  let best = null;
  for (const s of sizeSeries) {
    const m = s.metric || {};
    if (!seriesMatchesNode(m, nodeName, instance)) continue;
    const size = sampleValue(s);
    const avail = availByKey.get(`${m.device}|${m.mountpoint}`);
    if (size == null || size <= 0 || avail == null) continue;
    const pct = ((size - avail) / size) * 100;
    if (!best || pct > best.pct) {
      best = {
        pct,
        size,
        mountpoint: m.mountpoint || null,
        device: m.device || null,
      };
    }
  }
  return best;
}

async function getNodeData() {
  const [
    nodeInfoExporter,
    nodeInfoKsm,
    memWorkingSet,
    memUsageFallback,
    memTotal,
    cpuCoresUsed,
    cpuUsageFallback,
    cpuTotal,
    fsSize,
    fsAvail,
    diskUsageCadvisor,
    diskTotalCadvisor,
    podUsage,
    podTotal,
  ] = await Promise.all([
    queryPrometheus(QUERIES.NODE_INFO_EXPORTER),
    queryPrometheus(QUERIES.NODE_INFO_KSM),
    queryPrometheus(QUERIES.NODE_MEMORY_WORKING_SET),
    queryPrometheus(QUERIES.NODE_MEMORY_USAGE),
    queryPrometheus(QUERIES.NODE_MEMORY_TOTAL),
    queryPrometheus(QUERIES.NODE_CPU_CORES_USED),
    queryPrometheus(QUERIES.NODE_CPU_USAGE),
    queryPrometheus(QUERIES.NODE_CPU_TOTAL),
    queryPrometheus(QUERIES.NODE_FS_SIZE),
    queryPrometheus(QUERIES.NODE_FS_AVAIL),
    queryPrometheus(QUERIES.NODE_DISK_USAGE_CADVISOR),
    queryPrometheus(QUERIES.NODE_DISK_TOTAL_CADVISOR),
    queryPrometheus(QUERIES.NODE_POD_USAGE),
    queryPrometheus(QUERIES.NODE_POD_TOTAL),
  ]);

  const exporterInfo = nodeInfoExporter || [];
  const ksmInfo = nodeInfoKsm || [];

  // Node list is KSM-authoritative (kube_node_info reports EVERY node), joined
  // with per-node metrics where they exist. Using node-exporter's own list
  // (node_uname_info) as before hid any node that runs no node-exporter — a
  // tainted pool, or a pre-existing exporter with partial coverage — so we now
  // always list all nodes and mark missing per-node system metrics N/A (null).
  const nodeInfo = ksmInfo.length > 0 ? ksmInfo : exporterInfo;

  // node name -> node-exporter instance (IP:port), from node_uname_info, so KSM
  // nodes can pick up node-exporter metrics where available.
  const instanceByNode = new Map();
  exporterInfo.forEach((item) => {
    const nn =
      item.metric.nodename || item.metric.node || item.metric.exported_node;
    if (nn && item.metric.instance) instanceByNode.set(nn, item.metric.instance);
  });

  // KSM-sourced capacity lookups are keyed by node name.
  const memTotalMap = new Map();
  (memTotal || []).forEach((m) => memTotalMap.set(m.metric.node, m));
  const cpuTotalMap = new Map();
  (cpuTotal || []).forEach((c) => cpuTotalMap.set(c.metric.node, c));
  const podUsageMap = new Map();
  (podUsage || []).forEach((p) => podUsageMap.set(p.metric.node, p));
  const podTotalMap = new Map();
  (podTotal || []).forEach((p) => podTotalMap.set(p.metric.node, p));

  const nodes = nodeInfo.map((item) => {
    const nodeName =
      item.metric.node || item.metric.nodename || item.metric.exported_node;
    // Prefer the exporter instance resolved by node name; fall back to the
    // metric's own instance (when the list itself came from node-exporter).
    const instance =
      instanceByNode.get(nodeName) || item.metric.instance || null;

    // ---- memory: kubelet working set / allocatable, node-exporter fallback --
    const allocMemBytes = sampleValue(memTotalMap.get(nodeName));
    const workingSetBytes = sampleValue(
      findNodeSeries(memWorkingSet, nodeName, instance),
    );
    let memoryUsagePercent = null;
    let memorySource = null;
    if (workingSetBytes != null && allocMemBytes != null && allocMemBytes > 0) {
      memoryUsagePercent = round((workingSetBytes / allocMemBytes) * 100);
      memorySource = "kubelet";
    } else {
      const pct = sampleValue(
        findNodeSeries(memUsageFallback, nodeName, instance),
      );
      if (pct != null) {
        memoryUsagePercent = round(pct);
        memorySource = "node-exporter";
      }
    }
    // Total is allocatable — the same denominator the percentage uses when it
    // comes from the kubelet, so "% of N GiB" is internally consistent.
    const memoryTotalVal =
      allocMemBytes != null
        ? formatBytes(allocMemBytes)
        : { value: 0, unit: "GiB" };

    // ---- cpu: kubelet cores / allocatable cores, node-exporter fallback -----
    const allocCores = sampleValue(cpuTotalMap.get(nodeName));
    const coresUsed = sampleValue(
      findNodeSeries(cpuCoresUsed, nodeName, instance),
    );
    let cpuUsagePercent = null;
    let cpuSource = null;
    if (coresUsed != null && allocCores != null && allocCores > 0) {
      cpuUsagePercent = round((coresUsed / allocCores) * 100);
      cpuSource = "kubelet";
    } else {
      const pct = sampleValue(
        findNodeSeries(cpuUsageFallback, nodeName, instance),
      );
      if (pct != null) {
        cpuUsagePercent = round(pct);
        cpuSource = "node-exporter";
      }
    }
    const cpuTotalVal = allocCores != null ? round(allocCores) : 0;

    // ---- disk: fullest real filesystem, cAdvisor rootfs fallback -----------
    let diskUsagePercent = null;
    let diskTotalBytes = null;
    let diskSource = null;
    let diskMountpoint = null;
    const fullest = pickFullestFilesystem(fsSize, fsAvail, nodeName, instance);
    if (fullest) {
      diskUsagePercent = round(fullest.pct);
      diskTotalBytes = fullest.size;
      diskMountpoint = fullest.mountpoint;
      diskSource = "node-exporter";
    } else {
      const pct = sampleValue(
        findNodeSeries(diskUsageCadvisor, nodeName, instance),
      );
      if (pct != null) {
        diskUsagePercent = round(pct);
        diskTotalBytes = sampleValue(
          findNodeSeries(diskTotalCadvisor, nodeName, instance),
        );
        diskMountpoint = "/";
        diskSource = "cadvisor";
      }
    }
    const diskTotalVal =
      diskTotalBytes != null
        ? formatBytes(diskTotalBytes)
        : { value: 0, unit: "GiB" };

    // ---- pods --------------------------------------------------------------
    const podUsageValue = sampleValue(podUsageMap.get(nodeName));
    const podTotalValue = sampleValue(podTotalMap.get(nodeName));
    // `count by (node) (kube_pod_info)` yields NO series for a node that runs
    // zero pods. When KSM does report that node's pod capacity, the absence is
    // a genuine zero (drained / freshly joined node) rather than missing data —
    // an inference we can defend, unlike a fabricated value.
    const podUsagePercent =
      podUsageValue != null
        ? round(podUsageValue)
        : podTotalValue != null
          ? 0
          : null;
    const podTotalVal = podTotalValue != null ? round(podTotalValue) : 0;

    return {
      name: nodeName,
      instance,
      cpu: {
        usage: cpuUsagePercent,
        total: cpuTotalVal,
        unit: { usage: "%", total: "cores" },
        critical: cpuUsagePercent > CONFIG.threshold,
        source: cpuSource,
      },
      memory: {
        usage: memoryUsagePercent,
        total: memoryTotalVal.value,
        unit: { usage: "%", total: memoryTotalVal.unit },
        critical: memoryUsagePercent > CONFIG.threshold,
        source: memorySource,
      },
      disk: {
        usage: diskUsagePercent,
        total: diskTotalVal.value,
        unit: { usage: "%", total: diskTotalVal.unit },
        critical: diskUsagePercent > CONFIG.threshold,
        source: diskSource,
        mountpoint: diskMountpoint,
      },
      pod: {
        usage: podUsagePercent,
        total: podTotalVal,
        unit: { usage: "%", total: "pods" },
        critical: podUsagePercent > CONFIG.threshold,
      },
    };
  });

  // Legacy floor: a cluster is never reported as having zero nodes. The honest
  // count lives in summary.reporting.nodeCount.
  const nodeCount = nodes.length || 1;

  const presentValues = (sel) => nodes.map(sel).filter((v) => v != null);
  const avgUsage = (sel) => {
    const vals = presentValues(sel);
    return vals.length
      ? round(vals.reduce((a, b) => a + b, 0) / vals.length)
      : null;
  };
  // The cluster number: the worst node, and which node that is. A hot node is
  // the thing an operator has to act on; averaging it away is what made the
  // dashboard read lower than `kubectl top nodes`.
  const worstUsage = (sel) => {
    let usage = null;
    let worstNode = null;
    for (const n of nodes) {
      const v = sel(n);
      if (v == null) continue;
      if (usage === null || v > usage) {
        usage = v;
        worstNode = n.name || null;
      }
    }
    return { usage, worstNode };
  };
  const sumTotal = (sel) => nodes.reduce((s, n) => s + (sel(n) || 0), 0);

  const metricSummary = (usageSel, criticalSel, total) => {
    const { usage, worstNode } = worstUsage(usageSel);
    return {
      usage, // WORST node (semantics changed 2026-08-12; was the flat mean)
      avg: avgUsage(usageSel),
      worstNode,
      total,
      unit: "%",
      critical: nodes.some(criticalSel),
    };
  };

  const summary = {
    nodeCount,
    // Blind-node visibility: a node whose metrics never arrive silently left
    // the aggregate before, so a cluster could be summarised from a subset of
    // its nodes with nothing on screen saying so.
    reporting: {
      nodesWithData: nodes.filter(
        (n) =>
          n.cpu.usage != null || n.memory.usage != null || n.disk.usage != null,
      ).length,
      nodeCount: nodes.length,
    },
    cpu: metricSummary(
      (n) => n.cpu.usage,
      (n) => n.cpu.critical,
      sumTotal((n) => n.cpu.total),
    ),
    memory: metricSummary(
      (n) => n.memory.usage,
      (n) => n.memory.critical,
      round(sumTotal((n) => n.memory.total)),
    ),
    disk: metricSummary(
      (n) => n.disk.usage,
      (n) => n.disk.critical,
      round(sumTotal((n) => n.disk.total)),
    ),
    // Pod pressure is worst-node too: pods are scheduled per node, so a node at
    // its pod cap is a real scheduling failure that a cluster mean would hide.
    pod: metricSummary(
      (n) => n.pod.usage,
      (n) => n.pod.critical,
      sumTotal((n) => n.pod.total),
    ),
  };

  return { ok: true, timestamp: getTimestamp(), summary, nodes };
}

async function getOverviewData() {
  // The overview is derived from the SAME per-node computation the node view
  // uses. Previously it ran its own parallel set of queries and its own
  // averaging, so the hero number and the node cards could disagree; now they
  // agree by construction (and the push runs fewer queries overall).
  const [nodeData, podStatus] = await Promise.all([
    getNodeData(),
    queryPrometheus(QUERIES.POD_STATUS),
  ]);

  const summary = nodeData.summary;

  // podStatus: null = the query failed (unknown), [] = the query succeeded and
  // the cluster genuinely has no pods.
  const runningPods = podStatus
    ? podStatus.filter((p) => p.metric.phase === "Running").length
    : null;
  const totalPods = podStatus ? podStatus.length : null;

  const usageOf = (m) => ({
    value: m.usage, // worst node
    avg: m.avg,
    worstNode: m.worstNode,
    unit: "%",
    critical: m.critical,
  });

  // healthy is a positive claim: only assert it when at least one resource was
  // actually measured. With no measurements at all the honest answer is "we
  // don't know" (null), not "healthy".
  const measured = [
    summary.cpu.usage,
    summary.memory.usage,
    summary.disk.usage,
  ].filter((v) => v != null);
  const healthy = measured.length === 0 ? null : measured.every((v) => v < CONFIG.threshold);

  return {
    ok: true,
    timestamp: getTimestamp(),
    cluster: {
      nodes: summary.nodeCount,
      pods: { running: runningPods, total: totalPods },
    },
    reporting: summary.reporting,
    usage: {
      cpu: usageOf(summary.cpu),
      memory: usageOf(summary.memory),
      disk: usageOf(summary.disk),
      pod: usageOf(summary.pod),
    },
    // Alert pipeline retired 2026-08-12: no live cluster runs vmalert (the
    // auto-install stack never deploys one), so this was always a real
    // {0,0,0} in production. Kept as a fixed placeholder — not removed —
    // because older app builds still read overview.alerts.
    alerts: { total: 0, firing: 0, critical: 0 },
    healthy,
  };
}

async function getPodData() {
  const [statusData, cpuData, memoryData, ownerData, rsOwnerData, restartsData, waitingData] =
    await Promise.all([
      queryPrometheus(QUERIES.POD_STATUS),
      queryPrometheus(QUERIES.POD_CPU_USAGE),
      queryPrometheus(QUERIES.POD_MEMORY_USAGE),
      queryPrometheus(QUERIES.POD_OWNER),
      queryPrometheus(QUERIES.RS_OWNER),
      queryPrometheus(QUERIES.POD_RESTARTS).catch(() => []),
      queryPrometheus(QUERIES.POD_WAITING_REASON).catch(() => []),
    ]);

  const restartsMap = new Map();
  (restartsData || []).forEach((r) => {
    restartsMap.set(`${r.metric.namespace}/${r.metric.pod}`, parseInt(r.value?.[1] ?? "0", 10) || 0);
  });
  // Only PROBLEM waiting reasons are surfaced; transient scheduling states
  // (ContainerCreating, PodInitializing) are normal and stay null.
  const PROBLEM_REASONS = new Set([
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError",
    "CreateContainerError",
    "InvalidImageName",
  ]);
  const waitingMap = new Map();
  (waitingData || []).forEach((w) => {
    const reason = w.metric.reason;
    if (PROBLEM_REASONS.has(reason)) {
      waitingMap.set(`${w.metric.namespace}/${w.metric.pod}`, reason);
    }
  });

  // Build lookup maps for O(1) access (I2)
  const cpuMap = new Map();
  (cpuData || []).forEach((c) => {
    const key = `${c.metric.namespace}/${c.metric.pod}`;
    cpuMap.set(key, c);
  });
  const memMap = new Map();
  (memoryData || []).forEach((m) => {
    const key = `${m.metric.namespace}/${m.metric.pod}`;
    memMap.set(key, m);
  });
  const ownerMap = new Map();
  (ownerData || []).forEach((o) => {
    const key = `${o.metric.namespace}/${o.metric.pod}`;
    ownerMap.set(key, o);
  });

  // Build ReplicaSet → Deployment lookup map
  const rsToDeployment = {};
  for (const rs of rsOwnerData || []) {
    const ns = rs.metric.namespace;
    const rsName = rs.metric.replicaset;
    const ownerKind = rs.metric.owner_kind;
    const ownerName = rs.metric.owner_name;
    if (ownerKind === "Deployment" && rsName && ownerName) {
      rsToDeployment[`${ns}/${rsName}`] = ownerName;
    }
  }

  const pods = (statusData || []).map((item) => {
    const namespace = item.metric.exported_namespace || item.metric.namespace;
    const podName = item.metric.pod;
    const podKey = `${namespace}/${podName}`;

    const cpuValue = sampleValue(cpuMap.get(podKey));
    const cpuCores = cpuValue != null ? round(cpuValue, 3) : 0;
    const memValue = sampleValue(memMap.get(podKey));
    const memory =
      memValue != null ? formatBytes(memValue) : { value: 0, unit: "bytes" };

    // Owner resolution: Pod → ReplicaSet → Deployment, or Pod → StatefulSet/DaemonSet/Job
    const ownerItem = ownerMap.get(podKey);
    let podOwnerKind = null;
    let podOwnerName = null;
    if (ownerItem) {
      const directKind = ownerItem.metric.owner_kind;
      const directName = ownerItem.metric.owner_name;

      if (directKind === "ReplicaSet") {
        const deploymentName =
          rsToDeployment[`${namespace}/${directName}`];
        if (deploymentName) {
          podOwnerKind = "Deployment";
          podOwnerName = deploymentName;
        } else {
          podOwnerKind = "ReplicaSet";
          podOwnerName = directName;
        }
      } else if (
        directKind &&
        directKind !== "<none>" &&
        directKind !== "Node"
      ) {
        podOwnerKind = directKind;
        podOwnerName = directName;
      }
    }

    return {
      namespace,
      name: podName,
      phase: item.metric.phase,
      ownerKind: podOwnerKind,
      ownerName: podOwnerName,
      restarts: restartsMap.get(`${namespace}/${podName}`) ?? 0,
      waiting_reason: waitingMap.get(`${namespace}/${podName}`) ?? null,
      cpu: { value: cpuCores, unit: "cores" },
      memory: { value: memory.value, unit: memory.unit },
    };
  });

  const summary = {
    total: pods.length,
    running: pods.filter((p) => p.phase === "Running").length,
    pending: pods.filter((p) => p.phase === "Pending").length,
    failed: pods.filter((p) => p.phase === "Failed").length,
    // Pods stuck in a problem waiting state (CrashLoopBackOff & co) — these
    // keep phase=Running, so they are invisible to the phase buckets above.
    problem: pods.filter((p) => p.waiting_reason).length,
  };

  return { ok: true, timestamp: getTimestamp(), summary, pods };
}

async function getPvcData() {
  let [totalData, usageData] = await Promise.all([
    queryPrometheus(QUERIES.PVC_TOTAL),
    queryPrometheus(QUERIES.PVC_USAGE),
  ]);

  if (!totalData || totalData.length === 0) {
    totalData = await queryPrometheus(QUERIES.PVC_CAPACITY);
  }

  const pvcs = (totalData || []).map((item) => {
    const namespace = item.metric.exported_namespace || item.metric.namespace;
    const pvcName =
      item.metric.exported_persistentvolumeclaim ||
      item.metric.persistentvolumeclaim;
    const total = formatBytes(item.value[1]);
    const usageItem = (usageData || []).find(
      (u) =>
        (u.metric.exported_namespace || u.metric.namespace) === namespace &&
        (u.metric.exported_persistentvolumeclaim ||
          u.metric.persistentvolumeclaim) === pvcName,
    );
    const usageValue = sampleValue(usageItem);
    const usagePercent = usageValue != null ? round(usageValue) : null;

    return {
      namespace,
      name: pvcName,
      total: { value: total.value, unit: total.unit },
      usage:
        usagePercent !== null
          ? { value: usagePercent, unit: "%" }
          : { value: "N/A", unit: "" },
      critical: usagePercent !== null ? usagePercent > CONFIG.threshold : false,
    };
  });

  return { ok: true, timestamp: getTimestamp(), count: pvcs.length, pvcs };
}

async function getNsData() {
  const result = await queryPrometheus(QUERIES.NS);
  const namespaces = (result || [])
    .map((item) => item.metric.exported_namespace || item.metric.namespace)
    .filter(Boolean);

  return {
    ok: true,
    timestamp: getTimestamp(),
    count: namespaces.length,
    namespaces: [...new Set(namespaces)].sort(),
  };
}

module.exports = {
  getOverviewData,
  getNodeData,
  getPodData,
  getPvcData,
  getNsData,
  countDistinctNodes,
  // Exported for unit tests (pure helpers).
  sampleValue,
  seriesMatchesNode,
  pickFullestFilesystem,
};
