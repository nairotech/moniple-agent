// ============================================================================
// METRIC COLLECTORS (shape Prometheus/VM data into the agent JSON contract)
// ============================================================================

const CONFIG = require("./config");
const QUERIES = require("./queries");
const { queryPrometheus, fetchAlerts } = require("./prometheus");
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

async function getOverviewData() {
  const [
    nodeInfo,
    memUsage,
    cpuUsage,
    diskUsage,
    diskUsageCadvisor,
    podUsage,
    podStatus,
    alerts,
  ] = await Promise.all([
    queryPrometheus(QUERIES.NODE_INFO),
    queryPrometheus(QUERIES.NODE_MEMORY_USAGE),
    queryPrometheus(QUERIES.NODE_CPU_USAGE),
    queryPrometheus(QUERIES.NODE_DISK_USAGE),
    queryPrometheus(QUERIES.NODE_DISK_USAGE_CADVISOR),
    queryPrometheus(QUERIES.NODE_POD_USAGE),
    queryPrometheus(QUERIES.POD_STATUS),
    fetchAlerts(),
  ]);

  // Use node_filesystem metrics if available, otherwise fallback to cadvisor
  const effectiveDiskUsage =
    diskUsage.length > 0 ? diskUsage : diskUsageCadvisor;

  const nodeCount = countDistinctNodes(nodeInfo) || 1;
  const avgCpu =
    cpuUsage.length > 0
      ? round(
          cpuUsage.reduce((sum, c) => sum + parseFloat(c.value[1] || 0), 0) /
            cpuUsage.length,
        )
      : 0;
  const avgMemory =
    memUsage.length > 0
      ? round(
          memUsage.reduce((sum, m) => sum + parseFloat(m.value[1] || 0), 0) /
            memUsage.length,
        )
      : 0;
  const avgDisk =
    effectiveDiskUsage.length > 0
      ? round(
          effectiveDiskUsage.reduce(
            (sum, d) => sum + parseFloat(d.value[1] || 0),
            0,
          ) / effectiveDiskUsage.length,
        )
      : 0;
  const avgPod =
    podUsage.length > 0
      ? round(
          podUsage.reduce((sum, p) => sum + parseFloat(p.value[1] || 0), 0) /
            podUsage.length,
        )
      : 0;

  const runningPods = podStatus.filter(
    (p) => p.metric.phase === "Running",
  ).length;
  const totalPods = podStatus.length;
  const firingAlerts = alerts.filter((a) => a.state === "firing").length;
  const criticalAlerts = alerts.filter(
    (a) => a.labels?.severity === "critical",
  ).length;

  return {
    ok: true,
    timestamp: getTimestamp(),
    cluster: {
      nodes: nodeCount,
      pods: { running: runningPods, total: totalPods },
    },
    usage: {
      cpu: { value: avgCpu, unit: "%", critical: avgCpu > CONFIG.threshold },
      memory: {
        value: avgMemory,
        unit: "%",
        critical: avgMemory > CONFIG.threshold,
      },
      disk: { value: avgDisk, unit: "%", critical: avgDisk > CONFIG.threshold },
      pod: { value: avgPod, unit: "%", critical: avgPod > CONFIG.threshold },
    },
    alerts: {
      total: alerts.length,
      firing: firingAlerts,
      critical: criticalAlerts,
    },
    healthy:
      avgCpu < CONFIG.threshold &&
      avgMemory < CONFIG.threshold &&
      avgDisk < CONFIG.threshold &&
      criticalAlerts === 0,
  };
}

async function getNodeData() {
  let [
    nodeInfoExporter,
    nodeInfoKsm,
    memUsage,
    memTotal,
    diskUsage,
    diskUsageCadvisor,
    diskTotal,
    diskTotalCadvisor,
    cpuUsage,
    cpuTotal,
    podUsage,
    podTotal,
  ] = await Promise.all([
    queryPrometheus(QUERIES.NODE_INFO_EXPORTER),
    queryPrometheus(QUERIES.NODE_INFO_KSM),
    queryPrometheus(QUERIES.NODE_MEMORY_USAGE),
    queryPrometheus(QUERIES.NODE_MEMORY_TOTAL),
    queryPrometheus(QUERIES.NODE_DISK_USAGE),
    queryPrometheus(QUERIES.NODE_DISK_USAGE_CADVISOR),
    queryPrometheus(QUERIES.NODE_DISK_TOTAL),
    queryPrometheus(QUERIES.NODE_DISK_TOTAL_CADVISOR),
    queryPrometheus(QUERIES.NODE_CPU_USAGE),
    queryPrometheus(QUERIES.NODE_CPU_TOTAL),
    queryPrometheus(QUERIES.NODE_POD_USAGE),
    queryPrometheus(QUERIES.NODE_POD_TOTAL),
  ]);

  // Use node_filesystem metrics if available, otherwise fallback to cadvisor
  const useCadvisorDisk = diskUsage.length === 0;
  const effectiveDiskUsage = useCadvisorDisk ? diskUsageCadvisor : diskUsage;
  const effectiveDiskTotal = useCadvisorDisk ? diskTotalCadvisor : diskTotal;

  // Node list is KSM-authoritative (kube_node_info reports EVERY node), joined
  // with node-exporter metrics where they exist. Using node-exporter's own list
  // (node_uname_info) as before hid any node that runs no node-exporter — a
  // tainted pool, or a pre-existing exporter with partial coverage — so we now
  // always list all nodes and mark missing per-node system metrics N/A (null).
  const nodeInfo = nodeInfoKsm.length > 0 ? nodeInfoKsm : nodeInfoExporter;

  // node name -> node-exporter instance (IP:port), from node_uname_info, so KSM
  // nodes can pick up node-exporter CPU / memory / disk usage where available.
  const instanceByNode = new Map();
  nodeInfoExporter.forEach((item) => {
    const nn =
      item.metric.nodename || item.metric.node || item.metric.exported_node;
    if (nn && item.metric.instance) instanceByNode.set(nn, item.metric.instance);
  });

  // Build lookup maps for O(1) access (I2)
  const memUsageMap = new Map();
  memUsage.forEach((m) => memUsageMap.set(m.metric.instance, m));
  const memTotalMap = new Map();
  memTotal.forEach((m) => memTotalMap.set(m.metric.node, m));
  const cpuUsageMap = new Map();
  cpuUsage.forEach((c) => cpuUsageMap.set(c.metric.instance, c));
  const cpuTotalMap = new Map();
  cpuTotal.forEach((c) => cpuTotalMap.set(c.metric.node, c));
  const podUsageMap = new Map();
  podUsage.forEach((p) => podUsageMap.set(p.metric.node, p));
  const podTotalMap = new Map();
  podTotal.forEach((p) => podTotalMap.set(p.metric.node, p));

  const nodes = nodeInfo.map((item) => {
    const nodeName =
      item.metric.node || item.metric.nodename || item.metric.exported_node;
    // Prefer the exporter instance resolved by node name; fall back to the
    // metric's own instance (when the list itself came from node-exporter).
    const instance =
      instanceByNode.get(nodeName) || item.metric.instance || null;

    const memUsageItem = memUsageMap.get(instance);
    const memTotalItem = memTotalMap.get(nodeName);
    const memoryUsagePercent = memUsageItem
      ? round(parseFloat(memUsageItem.value[1]))
      : null;
    const memoryTotalVal = memTotalItem
      ? formatBytes(memTotalItem.value[1])
      : { value: 0, unit: "GiB" };

    // Disk: multi-key lookup (instance, nodeName, kubernetes_io_hostname)
    const diskUsageItem = effectiveDiskUsage.find(
      (d) =>
        d.metric.instance === instance ||
        d.metric.instance === nodeName ||
        d.metric.kubernetes_io_hostname === nodeName,
    );
    const diskTotalItem = effectiveDiskTotal.find(
      (d) =>
        d.metric.node === nodeName ||
        d.metric.instance === instance ||
        d.metric.instance === nodeName ||
        d.metric.kubernetes_io_hostname === nodeName,
    );
    const diskUsagePercent = diskUsageItem
      ? round(parseFloat(diskUsageItem.value[1]))
      : null;
    const diskTotalVal = diskTotalItem
      ? formatBytes(diskTotalItem.value[1])
      : { value: 0, unit: "GiB" };

    const cpuUsageItem = cpuUsageMap.get(instance);
    const cpuTotalItem = cpuTotalMap.get(nodeName);
    const cpuUsagePercent = cpuUsageItem
      ? round(parseFloat(cpuUsageItem.value[1]))
      : null;
    const cpuTotalVal = cpuTotalItem
      ? round(parseFloat(cpuTotalItem.value[1]))
      : 0;

    const podUsageItem = podUsageMap.get(nodeName);
    const podTotalItem = podTotalMap.get(nodeName);
    const podUsagePercent = podUsageItem
      ? round(parseFloat(podUsageItem.value[1]))
      : 0;
    const podTotalVal = podTotalItem
      ? round(parseFloat(podTotalItem.value[1]))
      : 0;

    return {
      name: nodeName,
      instance,
      cpu: {
        usage: cpuUsagePercent,
        total: cpuTotalVal,
        unit: { usage: "%", total: "cores" },
        critical: cpuUsagePercent > CONFIG.threshold,
      },
      memory: {
        usage: memoryUsagePercent,
        total: memoryTotalVal.value,
        unit: { usage: "%", total: memoryTotalVal.unit },
        critical: memoryUsagePercent > CONFIG.threshold,
      },
      disk: {
        usage: diskUsagePercent,
        total: diskTotalVal.value,
        unit: { usage: "%", total: diskTotalVal.unit },
        critical: diskUsagePercent > CONFIG.threshold,
      },
      pod: {
        usage: podUsagePercent,
        total: podTotalVal,
        unit: { usage: "%", total: "pods" },
        critical: podUsagePercent > CONFIG.threshold,
      },
    };
  });

  const nodeCount = nodes.length || 1;
  // Average usage only over nodes that actually reported it (node-exporter gaps
  // leave usage null); sum totals treating null as 0.
  const avgUsage = (sel) => {
    const vals = nodes.map(sel).filter((v) => v != null);
    return vals.length
      ? round(vals.reduce((a, b) => a + b, 0) / vals.length)
      : null;
  };
  const sumTotal = (sel) => nodes.reduce((s, n) => s + (sel(n) || 0), 0);
  const summary = {
    nodeCount,
    cpu: {
      usage: avgUsage((n) => n.cpu.usage),
      total: sumTotal((n) => n.cpu.total),
      unit: "%",
      critical: nodes.some((n) => n.cpu.critical),
    },
    memory: {
      usage: avgUsage((n) => n.memory.usage),
      total: round(sumTotal((n) => n.memory.total)),
      unit: "%",
      critical: nodes.some((n) => n.memory.critical),
    },
    disk: {
      usage: avgUsage((n) => n.disk.usage),
      total: round(sumTotal((n) => n.disk.total)),
      unit: "%",
      critical: nodes.some((n) => n.disk.critical),
    },
    pod: {
      usage: avgUsage((n) => n.pod.usage),
      total: sumTotal((n) => n.pod.total),
      unit: "%",
      critical: nodes.some((n) => n.pod.critical),
    },
  };

  return { ok: true, timestamp: getTimestamp(), summary, nodes };
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
  restartsData.forEach((r) => {
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
  waitingData.forEach((w) => {
    const reason = w.metric.reason;
    if (PROBLEM_REASONS.has(reason)) {
      waitingMap.set(`${w.metric.namespace}/${w.metric.pod}`, reason);
    }
  });

  // Build lookup maps for O(1) access (I2)
  const cpuMap = new Map();
  cpuData.forEach((c) => {
    const key = `${c.metric.namespace}/${c.metric.pod}`;
    cpuMap.set(key, c);
  });
  const memMap = new Map();
  memoryData.forEach((m) => {
    const key = `${m.metric.namespace}/${m.metric.pod}`;
    memMap.set(key, m);
  });
  const ownerMap = new Map();
  ownerData.forEach((o) => {
    const key = `${o.metric.namespace}/${o.metric.pod}`;
    ownerMap.set(key, o);
  });

  // Build ReplicaSet → Deployment lookup map
  const rsToDeployment = {};
  for (const rs of rsOwnerData) {
    const ns = rs.metric.namespace;
    const rsName = rs.metric.replicaset;
    const ownerKind = rs.metric.owner_kind;
    const ownerName = rs.metric.owner_name;
    if (ownerKind === "Deployment" && rsName && ownerName) {
      rsToDeployment[`${ns}/${rsName}`] = ownerName;
    }
  }

  const pods = statusData.map((item) => {
    const namespace = item.metric.exported_namespace || item.metric.namespace;
    const podName = item.metric.pod;
    const podKey = `${namespace}/${podName}`;

    const cpuItem = cpuMap.get(podKey);
    const cpuCores = cpuItem ? round(parseFloat(cpuItem.value[1]), 3) : 0;
    const memItem = memMap.get(podKey);
    const memory = memItem
      ? formatBytes(memItem.value[1])
      : { value: 0, unit: "bytes" };

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

  if (totalData.length === 0) {
    totalData = await queryPrometheus(QUERIES.PVC_CAPACITY);
  }

  const pvcs = totalData.map((item) => {
    const namespace = item.metric.exported_namespace || item.metric.namespace;
    const pvcName =
      item.metric.exported_persistentvolumeclaim ||
      item.metric.persistentvolumeclaim;
    const total = formatBytes(item.value[1]);
    const usageItem = usageData.find(
      (u) =>
        (u.metric.exported_namespace || u.metric.namespace) === namespace &&
        (u.metric.exported_persistentvolumeclaim ||
          u.metric.persistentvolumeclaim) === pvcName,
    );
    const usagePercent = usageItem
      ? round(parseFloat(usageItem.value[1]))
      : null;

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
  const namespaces = result
    .map((item) => item.metric.exported_namespace || item.metric.namespace)
    .filter(Boolean);

  return {
    ok: true,
    timestamp: getTimestamp(),
    count: namespaces.length,
    namespaces: [...new Set(namespaces)].sort(),
  };
}

async function getAlertsData() {
  const alerts = await fetchAlerts();
  const formatted = alerts.map((alert) => ({
    name: alert.labels?.alertname || "Unknown",
    severity: alert.labels?.severity || "unknown",
    state: alert.state,
    namespace: alert.labels?.namespace || "",
    summary: alert.annotations?.summary || alert.annotations?.description || "",
    activeAt: alert.activeAt,
  }));

  const summary = {
    total: formatted.length,
    firing: formatted.filter((a) => a.state === "firing").length,
    pending: formatted.filter((a) => a.state === "pending").length,
    critical: formatted.filter((a) => a.severity === "critical").length,
    warning: formatted.filter((a) => a.severity === "warning").length,
  };

  return { ok: true, timestamp: getTimestamp(), summary, alerts: formatted };
}

module.exports = {
  getOverviewData,
  getNodeData,
  getPodData,
  getPvcData,
  getNsData,
  getAlertsData,
  countDistinctNodes,
};
