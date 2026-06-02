// ============================================================================
// METRIC COLLECTORS (shape Prometheus/VM data into the agent JSON contract)
// ============================================================================

const CONFIG = require("./config");
const QUERIES = require("./queries");
const { queryPrometheus, fetchAlerts } = require("./prometheus");
const { formatBytes, round, getTimestamp } = require("./utils");

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

  const nodeCount = nodeInfo.length || 1;
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

  const nodeInfo = nodeInfoExporter.length > 0 ? nodeInfoExporter : nodeInfoKsm;

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
      item.metric.nodename || item.metric.node || item.metric.exported_node;
    const instance = item.metric.instance;

    const memUsageItem = memUsageMap.get(instance);
    const memTotalItem = memTotalMap.get(nodeName);
    const memoryUsagePercent = memUsageItem
      ? round(parseFloat(memUsageItem.value[1]))
      : 0;
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
      : 0;
    const diskTotalVal = diskTotalItem
      ? formatBytes(diskTotalItem.value[1])
      : { value: 0, unit: "GiB" };

    const cpuUsageItem = cpuUsageMap.get(instance);
    const cpuTotalItem = cpuTotalMap.get(nodeName);
    const cpuUsagePercent = cpuUsageItem
      ? round(parseFloat(cpuUsageItem.value[1]))
      : 0;
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
  const summary = {
    nodeCount,
    cpu: {
      usage: round(nodes.reduce((sum, n) => sum + n.cpu.usage, 0) / nodeCount),
      total: nodes.reduce((sum, n) => sum + n.cpu.total, 0),
      unit: "%",
      critical: nodes.some((n) => n.cpu.critical),
    },
    memory: {
      usage: round(
        nodes.reduce((sum, n) => sum + n.memory.usage, 0) / nodeCount,
      ),
      total: round(nodes.reduce((sum, n) => sum + n.memory.total, 0)),
      unit: "%",
      critical: nodes.some((n) => n.memory.critical),
    },
    disk: {
      usage: round(nodes.reduce((sum, n) => sum + n.disk.usage, 0) / nodeCount),
      total: round(nodes.reduce((sum, n) => sum + n.disk.total, 0)),
      unit: "%",
      critical: nodes.some((n) => n.disk.critical),
    },
    pod: {
      usage: round(nodes.reduce((sum, n) => sum + n.pod.usage, 0) / nodeCount),
      total: nodes.reduce((sum, n) => sum + n.pod.total, 0),
      unit: "%",
      critical: nodes.some((n) => n.pod.critical),
    },
  };

  return { ok: true, timestamp: getTimestamp(), summary, nodes };
}

async function getPodData() {
  const [statusData, cpuData, memoryData, ownerData, rsOwnerData] =
    await Promise.all([
      queryPrometheus(QUERIES.POD_STATUS),
      queryPrometheus(QUERIES.POD_CPU_USAGE),
      queryPrometheus(QUERIES.POD_MEMORY_USAGE),
      queryPrometheus(QUERIES.POD_OWNER),
      queryPrometheus(QUERIES.RS_OWNER),
    ]);

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
      cpu: { value: cpuCores, unit: "cores" },
      memory: { value: memory.value, unit: memory.unit },
    };
  });

  const summary = {
    total: pods.length,
    running: pods.filter((p) => p.phase === "Running").length,
    pending: pods.filter((p) => p.phase === "Pending").length,
    failed: pods.filter((p) => p.phase === "Failed").length,
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
};
