// ============================================================================
// EMBEDDED PROMQL QUERIES (Compatible with both Prometheus & Victoria Metrics)
// ============================================================================

// Real node filesystems only.
//
// Pseudo / ephemeral filesystems are excluded by TYPE (a deny-list, so ext4,
// xfs, btrfs and zfs all pass — the previous `fstype=~"ext.?|xfs"` allow-list
// silently produced NO disk data at all on btrfs/zfs nodes), and the mountpoint
// list covers the node root PLUS the paths where a cluster puts its container /
// kubelet data when those live on a separate volume. That layout is common on
// managed and pre-provisioned nodes, and with a root-only query "/" looks
// nearly empty while the real data disk fills up.
//
// The list is deliberately explicit rather than `/var/lib/.+`: per-pod volume
// mounts live under /var/lib/kubelet/pods/... and a full PVC must never turn a
// NODE red. (The bundled node-exporter already excludes those, but external
// exporters are not guaranteed to.)
const FS_SELECTOR =
  'fstype!~"tmpfs|devtmpfs|ramfs|overlay|squashfs|iso9660|autofs|nsfs|shm|rootfs|fuse.*|nfs.*|cifs",' +
  'mountpoint=~"/|/var|/var/lib|/var/lib/docker|/var/lib/containerd|/var/lib/kubelet|/var/lib/crio|/var/lib/rancher|/var/lib/longhorn"';

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
  // cAdvisor exports THREE series for a single-container pod: the container
  // itself (container="<name>"), the pod-level cgroup slice (NO container
  // label) and the pause sandbox. Summing them without a container filter
  // counts every pod roughly twice — measured 2.03x on k8s 1.31 / containerd
  // 2.0 (136.0 MB reported vs 67.8 MB real for the same pod). container!="POD"
  // additionally drops the sandbox on older cAdvisors that label it that way.
  POD_CPU_USAGE:
    'sum by (pod,namespace) (rate(container_cpu_usage_seconds_total{pod!="",container!="",container!="POD"}[5m]))',
  POD_MEMORY_USAGE:
    'sum by (pod,namespace) (container_memory_working_set_bytes{pod!="",container!="",container!="POD"})',
  POD_OWNER: "kube_pod_owner",
  RS_OWNER: "kube_replicaset_owner",

  // Node (use node_uname_info for correct instance, fallback to kube_node_info)
  NODE_INFO: "node_uname_info or kube_node_info",
  NODE_INFO_EXPORTER: "node_uname_info",
  NODE_INFO_KSM: "kube_node_info",

  // ---------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------
  // PRIMARY (bytes): the kubelet/cAdvisor root-cgroup working set — the exact
  // number `kubectl top node`, metrics-server and the kubelet's own eviction
  // logic use. node_memory_MemAvailable counts reclaimable page cache and slab
  // as free, so a percentage derived from it reads systematically LOW:
  // measured 4.16 GB vs a 4.78 GB working set on a 23.5 GiB node (-13%, stable
  // across 24h). The collector divides this by ALLOCATABLE (below), which is
  // also the denominator `kubectl top node` uses.
  //
  // cAdvisor's `instance` label is the NODE NAME under the bundled scrape
  // config (Prometheus node SD sets it that way); the collector additionally
  // matches `node` / `kubernetes_io_hostname` so external monitoring stacks
  // (kube-prometheus-stack et al.) join correctly too.
  NODE_MEMORY_WORKING_SET:
    'max by (instance) (container_memory_working_set_bytes{id="/"})',
  // FALLBACK (percent) — node-exporter only, used when cAdvisor's root cgroup
  // is unavailable. Reads low by design (see above) and is relative to physical
  // RAM rather than allocatable; the collector reports which source it used.
  NODE_MEMORY_USAGE:
    "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100",
  NODE_MEMORY_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="memory"})',

  // ---------------------------------------------------------------------
  // CPU
  // ---------------------------------------------------------------------
  // PRIMARY (cores): kubelet/cAdvisor root cgroup, the `kubectl top node`
  // source. A 2m window keeps 4 samples at the bundled 30s scrape interval
  // while staying closer to the ~30s window metrics-server reports over; the
  // old 5m window flattened real peaks (measured 26.9% against a 30.8% peak
  // inside the very same 5 minutes).
  NODE_CPU_CORES_USED:
    'max by (instance) (rate(container_cpu_usage_seconds_total{id="/"}[2m]))',
  // FALLBACK (percent). Deliberately NOT `1 - avg(idle)`: on VMs whose
  // /proc/stat does not account for all wall-clock CPU time (measured 6.96 of
  // 8 core-seconds per second on a KVM guest with steal=0), the unaccounted
  // time silently lands in `1 - idle` and inflates usage ~2x. Summing the busy
  // modes and dividing by the CPU count only ever reports time the kernel
  // actually attributed to work.
  NODE_CPU_USAGE:
    'sum by (instance) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / count by (instance) (node_cpu_seconds_total{mode="idle"}) * 100',
  NODE_CPU_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="cpu"})',

  // ---------------------------------------------------------------------
  // Disk
  // ---------------------------------------------------------------------
  // PRIMARY: raw per-filesystem size/avail series. The collector pairs them per
  // (device, mountpoint), picks the FULLEST filesystem of a node and reports
  // that filesystem's own size as the total — so the percentage and the total
  // always describe the same device. (Previously the percentage came from "/"
  // while the total came from allocatable ephemeral-storage: 29.4% was shown
  // next to 172.4 GiB although the percentage referred to a 192.7 GiB disk.)
  NODE_FS_SIZE: `max by (instance,node,mountpoint,device) (node_filesystem_size_bytes{${FS_SELECTOR}})`,
  NODE_FS_AVAIL: `max by (instance,node,mountpoint,device) (node_filesystem_avail_bytes{${FS_SELECTOR}})`,
  // FALLBACK: cAdvisor's view of the kubelet root filesystem. Usage and limit
  // come from the same device, so the pair stays consistent. This is also the
  // only disk source for nodes that run no node-exporter.
  NODE_DISK_USAGE_CADVISOR:
    'max by (instance) (container_fs_usage_bytes{id="/",device=~"/dev/.*"} / container_fs_limit_bytes{id="/",device=~"/dev/.*"} * 100)',
  NODE_DISK_TOTAL_CADVISOR:
    'max by (instance) (container_fs_limit_bytes{id="/",device=~"/dev/.*"})',

  NODE_POD_USAGE:
    'count by (node) (kube_pod_info) / sum by (node) (kube_node_status_allocatable{resource="pods"}) * 100',
  NODE_POD_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="pods"})',
};

module.exports = QUERIES;
