// ============================================================================
// EMBEDDED PROMQL QUERIES (Compatible with both Prometheus & Victoria Metrics)
// ============================================================================

const QUERIES = {
  // Namespace (kube-state-metrics v2 uses exported_namespace label)
  NS: 'kube_namespace_status_phase{phase="Active"}',

  // PVC - try kubelet stats first, fallback to kube-state-metrics
  PVC_USAGE:
    "sum by (namespace,persistentvolumeclaim) (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes * 100)",
  PVC_TOTAL:
    "sum by (namespace,persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes)",
  // Fallback PVC queries using kube-state-metrics
  PVC_INFO: "kube_persistentvolumeclaim_info",
  PVC_CAPACITY:
    "sum by (namespace,persistentvolumeclaim) (kube_persistentvolumeclaim_resource_requests_storage_bytes)",

  // Pod
  POD_STATUS: "sum by(namespace,pod,phase) (kube_pod_status_phase > 0)",
  // Honest pod telemetry (2026-07-15): phase alone hides CrashLoopBackOff
  // (the pod stays Running while its container dies) — restarts + waiting
  // reason make the loop visible.
  POD_RESTARTS: "sum by(namespace,pod) (kube_pod_container_status_restarts_total)",
  POD_WAITING_REASON:
    "max by(namespace,pod,reason) (kube_pod_container_status_waiting_reason == 1)",
  POD_CPU_USAGE:
    'sum by (pod,namespace) (rate(container_cpu_usage_seconds_total{pod!=""}[5m]))',
  POD_MEMORY_USAGE:
    'sum by (pod,namespace) (container_memory_working_set_bytes{pod!=""})',
  POD_OWNER: "kube_pod_owner",
  RS_OWNER: "kube_replicaset_owner",

  // Node (use node_uname_info for correct instance, fallback to kube_node_info)
  NODE_INFO: "node_uname_info or kube_node_info",
  NODE_INFO_EXPORTER: "node_uname_info",
  NODE_INFO_KSM: "kube_node_info",
  NODE_MEMORY_USAGE:
    "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100",
  NODE_MEMORY_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="memory"})',
  NODE_DISK_USAGE:
    'max by (instance) ((node_filesystem_size_bytes{fstype=~"ext.?|xfs",mountpoint="/"} - node_filesystem_avail_bytes{fstype=~"ext.?|xfs",mountpoint="/"}) / node_filesystem_size_bytes{fstype=~"ext.?|xfs",mountpoint="/"} * 100)',
  NODE_DISK_USAGE_CADVISOR:
    'max by (instance) (container_fs_usage_bytes{id="/",device=~"/dev/.*"} / container_fs_limit_bytes{id="/",device=~"/dev/.*"} * 100)',
  NODE_DISK_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="ephemeral_storage"})',
  NODE_DISK_TOTAL_CADVISOR:
    'max by (instance) (container_fs_limit_bytes{id="/",device=~"/dev/.*"})',
  NODE_CPU_USAGE:
    '(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100',
  NODE_CPU_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="cpu"})',
  NODE_POD_USAGE:
    'count by (node) (kube_pod_info) / sum by (node) (kube_node_status_allocatable{resource="pods"}) * 100',
  NODE_POD_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="pods"})',
};

module.exports = QUERIES;
