/**
 * Diagnostic Data Collector
 * Collects diagnostic information from K8s API and Prometheus metrics.
 * Each check returns a structured object with findings for the LLM to analyze.
 */

class DiagnosticCollector {
  constructor({ k8sCoreApi, k8sAppsApi, k8sBatchApi, queryPrometheus }) {
    this.k8sCoreApi = k8sCoreApi;
    this.k8sAppsApi = k8sAppsApi;
    this.k8sBatchApi = k8sBatchApi;
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

    // Check PVC usage from Prometheus
    const usageResults = await this.queryPrometheus(
      "sum by (namespace,persistentvolumeclaim) (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes * 100)"
    );

    for (const r of usageResults) {
      const value = parseFloat(r.value?.[1] || 0);
      if (value > 90) {
        issues.push({
          type: "PVCNearFull",
          severity: "critical",
          pvc: r.metric?.persistentvolumeclaim,
          namespace: r.metric?.namespace,
          usagePercent: Math.round(value),
        });
      }
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

    for (const dep of deployments) {
      const name = dep.metadata?.name;
      const ns = dep.metadata?.namespace;
      const desired = dep.spec?.replicas ?? 1;
      const available = dep.status?.availableReplicas ?? 0;
      const ready = dep.status?.readyReplicas ?? 0;
      const unavailable = dep.status?.unavailableReplicas ?? 0;

      if (available >= desired && ready >= desired) {
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

    return { summary, issues };
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

module.exports = { DiagnosticCollector };
