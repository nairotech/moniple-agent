/**
 * Diagnostic Data Collector
 * Collects diagnostic information from K8s API and Prometheus metrics.
 * Each check returns a structured object with findings for the LLM to analyze.
 */

const SYSTEM_NAMESPACES = ["kube-system", "kube-public", "kube-node-lease", "moniple"];

// Current requests/limits of one named container in a pod spec. Returns null
// when the container isn't found so the LLM's "values absent → don't propose
// adjust_resources" rule kicks in instead of seeing an empty object.
function currentContainerResources(podSpec, containerName) {
  const all = [...(podSpec?.containers || []), ...(podSpec?.initContainers || [])];
  const c = all.find((x) => x.name === containerName);
  if (!c) return null;
  return {
    container: c.name,
    requests: c.resources?.requests || null,
    limits: c.resources?.limits || null,
  };
}

// Current requests/limits of every (non-init) container in a pod spec.
function currentPodResources(podSpec) {
  return (podSpec?.containers || []).map((c) => ({
    container: c.name,
    requests: c.resources?.requests || null,
    limits: c.resources?.limits || null,
  }));
}

class DiagnosticCollector {
  constructor({ k8sCoreApi, k8sAppsApi, k8sBatchApi, k8sStorageApi, queryPrometheus }) {
    this.k8sCoreApi = k8sCoreApi;
    this.k8sAppsApi = k8sAppsApi;
    this.k8sBatchApi = k8sBatchApi;
    this.k8sStorageApi = k8sStorageApi;
    this.queryPrometheus = queryPrometheus;
  }

  async collect(checks = []) {
    const results = {};
    const checkMap = {
      pods: () => this.checkPods(),
      nodes: () => this.checkNodes(),
      resources: () => this.checkResources(),
      pvcs: () => this.checkPvcs(),
      events: () => this.checkEvents(),
      security: () => this.checkSecurity(),
      deployments: () => this.checkDeployments(),
      logs: () => this.checkLogs(),
    };

    const promises = checks
      .filter((c) => checkMap[c])
      .map(async (check) => {
        try {
          results[check] = await checkMap[check]();
        } catch (err) {
          console.error(`Diagnostic check '${check}' failed:`, err.message);
          results[check] = { error: err.message };
        }
      });

    await Promise.all(promises);
    return results;
  }

  // --- Pod Health ---
  async checkPods() {
    if (!this.k8sCoreApi) return { error: "K8s API not available" };

    const { body } = await this.k8sCoreApi.listPodForAllNamespaces();
    const pods = body.items || [];

    const issues = [];
    const summary = { total: pods.length, running: 0, pending: 0, failed: 0, crashloop: 0, oom: 0, imagepull: 0 };

    for (const pod of pods) {
      const phase = pod.status?.phase;
      const ns = pod.metadata?.namespace;
      const name = pod.metadata?.name;
      // Current requests/limits of a named container — attached to every
      // pod-level issue so the LLM can only ever propose adjust_resources
      // values derived from what is actually configured today.
      const resourcesOf = (containerName) =>
        currentContainerResources(pod.spec, containerName);

      if (phase === "Running") summary.running++;
      else if (phase === "Pending") summary.pending++;
      else if (phase === "Failed") summary.failed++;

      // Check container statuses
      const containerStatuses = [
        ...(pod.status?.containerStatuses || []),
        ...(pod.status?.initContainerStatuses || []),
      ];

      for (const cs of containerStatuses) {
        const waitingReason = cs.state?.waiting?.reason;
        const lastTerminatedReason = cs.lastState?.terminated?.reason;
        const restartCount = cs.restartCount || 0;

        if (waitingReason === "CrashLoopBackOff") {
          summary.crashloop++;
          issues.push({
            type: "CrashLoopBackOff",
            severity: "critical",
            pod: name,
            namespace: ns,
            container: cs.name,
            restartCount,
            message: cs.state?.waiting?.message || "",
            current_resources: resourcesOf(cs.name),
          });
        }

        if (waitingReason === "ImagePullBackOff" || waitingReason === "ErrImagePull") {
          summary.imagepull++;
          issues.push({
            type: "ImagePullError",
            severity: "critical",
            pod: name,
            namespace: ns,
            container: cs.name,
            image: cs.image,
            message: cs.state?.waiting?.message || "",
          });
        }

        if (lastTerminatedReason === "OOMKilled") {
          summary.oom++;
          issues.push({
            type: "OOMKilled",
            severity: "critical",
            pod: name,
            namespace: ns,
            container: cs.name,
            restartCount,
            current_resources: resourcesOf(cs.name),
          });
        }
      }

      // Pending > 5 minutes
      if (phase === "Pending") {
        const createdAt = new Date(pod.metadata?.creationTimestamp);
        const ageMinutes = (Date.now() - createdAt.getTime()) / 60000;
        if (ageMinutes > 5) {
          const conditions = (pod.status?.conditions || [])
            .filter((c) => c.status === "False")
            .map((c) => ({ type: c.type, reason: c.reason, message: c.message }));

          issues.push({
            type: "PendingTooLong",
            severity: "warning",
            pod: name,
            namespace: ns,
            ageMinutes: Math.round(ageMinutes),
            conditions,
            // All containers' requests — Pending is often unschedulable
            // because the requests don't fit any node.
            current_resources: currentPodResources(pod.spec),
          });
        }
      }
    }

    return { summary, issues };
  }

  // --- Node Health ---
  async checkNodes() {
    if (!this.k8sCoreApi) return { error: "K8s API not available" };

    const { body } = await this.k8sCoreApi.listNode();
    const nodes = body.items || [];

    const issues = [];
    const summary = { total: nodes.length, ready: 0, notReady: 0 };

    for (const node of nodes) {
      const name = node.metadata?.name;
      const conditions = node.status?.conditions || [];

      const readyCondition = conditions.find((c) => c.type === "Ready");
      if (readyCondition?.status === "True") {
        summary.ready++;
      } else {
        summary.notReady++;
        issues.push({
          type: "NodeNotReady",
          severity: "critical",
          node: name,
          reason: readyCondition?.reason,
          message: readyCondition?.message,
        });
      }

      // Pressure conditions
      for (const condition of conditions) {
        if (
          ["DiskPressure", "MemoryPressure", "PIDPressure"].includes(condition.type) &&
          condition.status === "True"
        ) {
          issues.push({
            type: condition.type,
            severity: "critical",
            node: name,
            reason: condition.reason,
            message: condition.message,
          });
        }
      }

      // Unschedulable
      if (node.spec?.unschedulable) {
        issues.push({
          type: "NodeCordoned",
          severity: "info",
          node: name,
        });
      }
    }

    return { summary, issues };
  }

  // --- Resource Usage ---
  async checkResources() {
    const [cpuResults, memResults, diskResults] = await Promise.all([
      this.queryPrometheus(
        '(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100'
      ),
      this.queryPrometheus(
        "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100"
      ),
      this.queryPrometheus(
        'max by (instance) ((node_filesystem_size_bytes{fstype=~"ext.?|xfs|overlay",mountpoint="/"} - node_filesystem_avail_bytes{fstype=~"ext.?|xfs|overlay",mountpoint="/"}) / node_filesystem_size_bytes{fstype=~"ext.?|xfs|overlay",mountpoint="/"} * 100)'
      ),
    ]);

    const issues = [];

    for (const r of cpuResults) {
      const value = parseFloat(r.value?.[1] || 0);
      if (value > 90) {
        issues.push({ type: "HighCPU", severity: "critical", node: r.metric?.instance, value: Math.round(value) });
      } else if (value > 80) {
        issues.push({ type: "HighCPU", severity: "warning", node: r.metric?.instance, value: Math.round(value) });
      }
    }

    for (const r of memResults) {
      const value = parseFloat(r.value?.[1] || 0);
      if (value > 90) {
        issues.push({ type: "HighMemory", severity: "critical", node: r.metric?.instance, value: Math.round(value) });
      } else if (value > 80) {
        issues.push({ type: "HighMemory", severity: "warning", node: r.metric?.instance, value: Math.round(value) });
      }
    }

    for (const r of diskResults) {
      const value = parseFloat(r.value?.[1] || 0);
      if (value > 90) {
        issues.push({ type: "HighDisk", severity: "critical", node: r.metric?.instance, value: Math.round(value) });
      } else if (value > 80) {
        issues.push({ type: "HighDisk", severity: "warning", node: r.metric?.instance, value: Math.round(value) });
      }
    }

    return {
      summary: {
        cpu_nodes: cpuResults.length,
        memory_nodes: memResults.length,
        disk_nodes: diskResults.length,
      },
      issues,
    };
  }

  // --- PVC Status ---
  async checkPvcs() {
    if (!this.k8sCoreApi) return { error: "K8s API not available" };

    const { body } = await this.k8sCoreApi.listPersistentVolumeClaimForAllNamespaces();
    const pvcs = body.items || [];

    const issues = [];
    const summary = { total: pvcs.length, bound: 0, pending: 0, lost: 0 };

    for (const pvc of pvcs) {
      const phase = pvc.status?.phase;
      const name = pvc.metadata?.name;
      const ns = pvc.metadata?.namespace;

      if (phase === "Bound") summary.bound++;
      else if (phase === "Pending") {
        summary.pending++;
        issues.push({
          type: "PVCPending",
          severity: "warning",
          pvc: name,
          namespace: ns,
          storageClass: pvc.spec?.storageClassName,
          requestedSize: pvc.spec?.resources?.requests?.storage,
        });
      } else if (phase === "Lost") {
        summary.lost++;
        issues.push({
          type: "PVCLost",
          severity: "critical",
          pvc: name,
          namespace: ns,
        });
      }
    }

    // StorageClass expandability map — lets the LLM know whether an
    // expand_pvc action is even possible for a given PVC.
    const expandableClasses = {};
    if (this.k8sStorageApi) {
      try {
        const { body: scList } = await this.k8sStorageApi.listStorageClass();
        for (const sc of scList.items || []) {
          expandableClasses[sc.metadata?.name] = sc.allowVolumeExpansion === true;
        }
      } catch (e) {
        // RBAC may not cover storageclasses on old installs — non-fatal.
      }
    }

    // PVC metadata lookup for enriching usage findings (size, class).
    const pvcMeta = {};
    for (const pvc of pvcs) {
      const key = `${pvc.metadata?.namespace}/${pvc.metadata?.name}`;
      const scName = pvc.spec?.storageClassName;
      pvcMeta[key] = {
        requestedSize:
          pvc.status?.capacity?.storage ||
          pvc.spec?.resources?.requests?.storage,
        storageClass: scName,
        expandable: scName ? expandableClasses[scName] === true : false,
      };
    }

    // Check PVC usage from Prometheus. Two bands: >90% critical (about to
    // fill), >80% warning (plan capacity now). Findings carry current size,
    // storage class and whether the class allows online expansion so the
    // LLM can propose a concrete expand_pvc action.
    const usageResults = await this.queryPrometheus(
      "sum by (namespace,persistentvolumeclaim) (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes * 100)"
    );

    for (const r of usageResults) {
      const value = parseFloat(r.value?.[1] || 0);
      if (value <= 80) continue;
      const name = r.metric?.persistentvolumeclaim;
      const ns = r.metric?.namespace;
      const meta = pvcMeta[`${ns}/${name}`] || {};
      issues.push({
        type: value > 90 ? "PVCNearFull" : "PVCHighUsage",
        severity: value > 90 ? "critical" : "warning",
        pvc: name,
        namespace: ns,
        usagePercent: Math.round(value),
        currentSize: meta.requestedSize,
        storageClass: meta.storageClass,
        expandable: meta.expandable === true,
      });
    }

    // Visibility note: some provisioners (e.g. local-path) never expose
    // kubelet_volume_stats, so "no usage findings" must not be read as
    // "all volumes healthy".
    summary.usageDataAvailable = usageResults.length > 0;
    if (!summary.usageDataAvailable && pvcs.length > 0) {
      summary.usageNote =
        "PVC usage metrics unavailable (provisioner does not expose kubelet_volume_stats) — usage-based findings are not possible for this cluster.";
    }

    return { summary, issues };
  }

  // --- Warning Events ---
  async checkEvents() {
    if (!this.k8sCoreApi) return { error: "K8s API not available" };

    const { body } = await this.k8sCoreApi.listEventForAllNamespaces();
    const events = body.items || [];

    const oneHourAgo = new Date(Date.now() - 3600000);
    const warningEvents = events.filter((e) => {
      if (e.type !== "Warning") return false;
      const lastSeen = new Date(e.lastTimestamp || e.metadata?.creationTimestamp);
      return lastSeen >= oneHourAgo;
    });

    // Group by reason
    const grouped = {};
    for (const e of warningEvents) {
      const key = `${e.reason}:${e.involvedObject?.kind}`;
      if (!grouped[key]) {
        grouped[key] = {
          reason: e.reason,
          kind: e.involvedObject?.kind,
          count: 0,
          samples: [],
        };
      }
      grouped[key].count += (e.count || 1);
      if (grouped[key].samples.length < 3) {
        grouped[key].samples.push({
          name: e.involvedObject?.name,
          namespace: e.involvedObject?.namespace,
          message: e.message,
        });
      }
    }

    return {
      summary: {
        total_warning_events: warningEvents.length,
        unique_reasons: Object.keys(grouped).length,
      },
      event_groups: Object.values(grouped).sort((a, b) => b.count - a.count).slice(0, 20),
    };
  }

  // --- Security Issues ---
  async checkSecurity() {
    if (!this.k8sCoreApi) return { error: "K8s API not available" };

    const { body } = await this.k8sCoreApi.listPodForAllNamespaces();
    const pods = body.items || [];

    const issues = [];

    for (const pod of pods) {
      const ns = pod.metadata?.namespace;
      const name = pod.metadata?.name;
      // Skip system namespaces
      if (["kube-system", "kube-public", "kube-node-lease", "moniple"].includes(ns)) continue;

      const containers = [...(pod.spec?.containers || []), ...(pod.spec?.initContainers || [])];

      for (const c of containers) {
        const sc = c.securityContext || {};

        // Privileged containers
        if (sc.privileged) {
          issues.push({
            type: "PrivilegedContainer",
            severity: "warning",
            pod: name,
            namespace: ns,
            container: c.name,
          });
        }

        // Running as root
        if (sc.runAsUser === 0) {
          issues.push({
            type: "RunAsRoot",
            severity: "info",
            pod: name,
            namespace: ns,
            container: c.name,
          });
        }

        // Missing resource limits
        if (!c.resources?.limits?.cpu || !c.resources?.limits?.memory) {
          issues.push({
            type: "MissingResourceLimits",
            severity: "info",
            pod: name,
            namespace: ns,
            container: c.name,
            missingCpu: !c.resources?.limits?.cpu,
            missingMemory: !c.resources?.limits?.memory,
          });
        }
      }

      // Default service account
      if (pod.spec?.serviceAccountName === "default" && ns !== "default") {
        issues.push({
          type: "DefaultServiceAccount",
          severity: "info",
          pod: name,
          namespace: ns,
        });
      }
    }

    return {
      summary: {
        scanned_pods: pods.length,
        issues_found: issues.length,
      },
      // Limit to top 50 most important
      issues: issues
        .sort((a, b) => {
          const sev = { critical: 0, warning: 1, info: 2 };
          return (sev[a.severity] || 3) - (sev[b.severity] || 3);
        })
        .slice(0, 50),
    };
  }

  // --- Deployment Issues ---
  async checkDeployments() {
    if (!this.k8sAppsApi) return { error: "K8s API not available" };

    const { body } = await this.k8sAppsApi.listDeploymentForAllNamespaces();
    const deployments = body.items || [];

    const issues = [];
    const summary = { total: deployments.length, healthy: 0, degraded: 0 };

    // Current per-container requests/limits for every deployment — the source
    // the LLM must derive adjust_resources values from (degraded workloads
    // first so they survive the cap on large clusters).
    const workloadResources = [];

    for (const dep of deployments) {
      const name = dep.metadata?.name;
      const ns = dep.metadata?.namespace;
      const desired = dep.spec?.replicas ?? 1;
      const available = dep.status?.availableReplicas ?? 0;
      const ready = dep.status?.readyReplicas ?? 0;
      const unavailable = dep.status?.unavailableReplicas ?? 0;
      const degraded = !(available >= desired && ready >= desired);
      const containers = currentPodResources(dep.spec?.template?.spec);

      if (!SYSTEM_NAMESPACES.includes(ns)) {
        workloadResources.push({
          deployment: name,
          namespace: ns,
          replicas: desired,
          degraded,
          containers,
        });
      }

      if (!degraded) {
        summary.healthy++;
      } else {
        summary.degraded++;
        issues.push({
          type: unavailable > 0 ? "UnavailableReplicas" : "InsufficientReplicas",
          severity: available === 0 ? "critical" : "warning",
          deployment: name,
          namespace: ns,
          desired,
          available,
          ready,
          unavailable,
          current_resources: containers,
        });
      }

      // Check for stuck rollouts
      const conditions = dep.status?.conditions || [];
      const progressing = conditions.find((c) => c.type === "Progressing");
      if (progressing?.status === "False" && progressing?.reason === "ProgressDeadlineExceeded") {
        issues.push({
          type: "RolloutStuck",
          severity: "critical",
          deployment: name,
          namespace: ns,
          message: progressing.message,
        });
      }
    }

    workloadResources.sort((a, b) => (b.degraded ? 1 : 0) - (a.degraded ? 1 : 0));

    return {
      summary,
      issues,
      workload_resources: workloadResources.slice(0, 100),
    };
  }

  // --- Log Analysis (CrashLoopBackOff pods only) ---
  async checkLogs() {
    if (!this.k8sCoreApi) return { error: "K8s API not available" };

    const { body } = await this.k8sCoreApi.listPodForAllNamespaces();
    const pods = body.items || [];

    const crashPods = [];
    for (const pod of pods) {
      const statuses = pod.status?.containerStatuses || [];
      for (const cs of statuses) {
        if (
          cs.state?.waiting?.reason === "CrashLoopBackOff" ||
          cs.lastState?.terminated?.reason === "OOMKilled" ||
          cs.lastState?.terminated?.reason === "Error"
        ) {
          crashPods.push({
            name: pod.metadata?.name,
            namespace: pod.metadata?.namespace,
            container: cs.name,
            reason: cs.state?.waiting?.reason || cs.lastState?.terminated?.reason,
            current_resources: currentContainerResources(pod.spec, cs.name),
          });
        }
      }
    }

    // Fetch last 50 lines for up to 5 crash pods
    const logResults = [];
    for (const cp of crashPods.slice(0, 5)) {
      try {
        const { body: logs } = await this.k8sCoreApi.readNamespacedPodLog(
          cp.name,
          cp.namespace,
          cp.container,
          undefined, // follow
          undefined, // insecureSkipTLSVerifyBackend
          undefined, // limitBytes
          undefined, // pretty
          true, // previous (get previous terminated container logs)
          undefined, // sinceSeconds
          50, // tailLines
          undefined, // timestamps
        );
        logResults.push({
          ...cp,
          logs: typeof logs === "string" ? logs : "",
        });
      } catch {
        // Try current logs
        try {
          const { body: logs } = await this.k8sCoreApi.readNamespacedPodLog(
            cp.name,
            cp.namespace,
            cp.container,
            undefined,
            undefined,
            undefined,
            undefined,
            false,
            undefined,
            50,
          );
          logResults.push({
            ...cp,
            logs: typeof logs === "string" ? logs : "",
          });
        } catch {
          logResults.push({ ...cp, logs: "(unable to fetch logs)" });
        }
      }
    }

    return {
      summary: {
        crash_pods_found: crashPods.length,
        logs_fetched: logResults.length,
      },
      pod_logs: logResults,
    };
  }
}

module.exports = { DiagnosticCollector, currentContainerResources, currentPodResources };
