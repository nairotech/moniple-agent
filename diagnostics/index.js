/**
 * Diagnostics Orchestrator
 * Ties together: config fetch → collect → LLM analyze → push report → poll actions → execute
 */

const { DiagnosticCollector } = require("./collector");
const { LLMClient } = require("./llm-client");
const { getSystemPrompt, getUserPrompt } = require("./prompts");

class DiagnosticsEngine {
  constructor({
    k8sCoreApi,
    k8sAppsApi,
    k8sBatchApi,
    queryPrometheus,
    serverUrl,
    apiKey,
  }) {
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
    this.collector = new DiagnosticCollector({
      k8sCoreApi,
      k8sAppsApi,
      k8sBatchApi,
      queryPrometheus,
    });
    this.config = null;
    this.scheduleTimer = null;
    this.running = false;
  }

  // --- Config Management ---

  async fetchConfig() {
    if (!this.serverUrl || !this.apiKey) return null;

    try {
      const response = await fetch(
        `${this.serverUrl}/api/v1/agent/doctor/config`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        }
      );

      if (!response.ok) return null;

      const result = await response.json();
      if (result.ok) {
        this.config = result.data;
        return this.config;
      }
    } catch (err) {
      console.error("[Doctor] Failed to fetch config:", err.message);
    }
    return null;
  }

  // --- Diagnostic Cycle ---

  async runDiagnostic(triggerType = "auto", reportId = null) {
    if (this.running) {
      console.log("[Doctor] Diagnostic already running, skipping");
      return;
    }

    if (!this.config?.enabled || !this.config?.llm) {
      return;
    }

    this.running = true;
    const startTime = Date.now();

    try {
      console.log(
        `[Doctor] Starting ${triggerType} diagnostic (${this.config.llm.provider}/${this.config.llm.model})`
      );

      // 1. Collect diagnostic data
      let checks = this.config.schedule?.checks || [
        "pods",
        "nodes",
        "resources",
        "pvcs",
        "events",
        "security",
        "deployments",
      ];
      // checks may come as JSON string from DB
      if (typeof checks === "string") {
        try { checks = JSON.parse(checks); } catch { checks = ["pods", "nodes", "resources", "pvcs", "events", "security", "deployments"]; }
      }
      const diagnosticData = await this.collector.collect(checks);

      // 2. Call LLM for analysis
      const llmClient = new LLMClient(this.config.llm);
      const locale = this.config.llm.locale || "en";
      const minSeverity = this.config.schedule?.min_severity || "info";
      const systemPrompt = getSystemPrompt(locale);
      const userPrompt = getUserPrompt(diagnosticData, minSeverity);

      let analysis = null;
      let tokensUsed = null;
      let status = "completed";

      try {
        const result = await llmClient.analyze(systemPrompt, userPrompt);
        analysis = result.analysis;
        tokensUsed = result.tokens_used;
        if (!analysis || !analysis.findings) {
          console.error("[Doctor] LLM returned empty or invalid analysis (no findings)");
          status = "failed";
        }
      } catch (llmErr) {
        console.error("[Doctor] LLM analysis failed:", llmErr.message);
        status = "failed";
      }

      // 3. Filter findings by min_severity and extract actions
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      const minSevLevel = severityOrder[minSeverity] ?? 2;

      if (analysis?.findings) {
        analysis.findings = analysis.findings.filter((f) => {
          const fLevel = severityOrder[f.severity] ?? 2;
          return fLevel <= minSevLevel;
        });
        analysis.severity = analysis.findings.length > 0
          ? analysis.findings.reduce((worst, f) => {
              const wl = severityOrder[worst] ?? 2;
              const fl = severityOrder[f.severity] ?? 2;
              return fl < wl ? f.severity : worst;
            }, "info")
          : "healthy";
      }

      // Filter actions by max_risk_level
      const maxRiskLevel = this.config.schedule?.max_risk_level || "high";
      const riskOrder = { low: 0, medium: 1, high: 2 };
      const maxRiskNum = riskOrder[maxRiskLevel] ?? 2;

      const actions = [];
      if (analysis?.findings) {
        for (const finding of analysis.findings) {
          if (finding.remediation_actions) {
            for (const action of finding.remediation_actions) {
              const actionRisk = riskOrder[action.risk_level] ?? 0;
              if (actionRisk <= maxRiskNum) {
                actions.push(action);
              }
            }
          }
        }
      }

      // 4. Push report to server
      await this.pushReport({
        report_id: reportId,
        diagnostic_data: diagnosticData,
        analysis,
        summary: analysis?.summary || null,
        severity: analysis?.severity || null,
        finding_count: analysis?.findings?.length || 0,
        action_count: actions.length,
        llm_provider: this.config.llm.provider,
        llm_model: this.config.llm.model,
        llm_tokens_used: tokensUsed,
        status,
        actions,
      });

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `[Doctor] Diagnostic completed in ${elapsed}s: ${analysis?.severity || "unknown"} - ${analysis?.findings?.length || 0} findings, ${actions.length} actions`
      );
    } catch (err) {
      console.error("[Doctor] Diagnostic cycle error:", err.message);
    } finally {
      this.running = false;
    }
  }

  // --- Check for pending manual triggers ---

  async checkPendingTrigger() {
    if (!this.serverUrl || !this.apiKey) return;

    try {
      const response = await fetch(
        `${this.serverUrl}/api/v1/agent/doctor/pending`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        }
      );

      if (!response.ok) return;

      const result = await response.json();
      if (result.ok && result.data?.pending) {
        const pendingId = result.data.pending.id;
        console.log(
          `[Doctor] Manual diagnostic trigger found: ${pendingId}`
        );
        await this.runDiagnostic("manual", pendingId);
      }
    } catch {
      // Silent - non-critical
    }
  }

  // --- Push report to server ---

  async pushReport(reportData) {
    if (!this.serverUrl || !this.apiKey) return;

    try {
      const response = await fetch(
        `${this.serverUrl}/api/v1/agent/doctor/reports`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(reportData),
        }
      );

      const result = await response.json();
      if (!result.ok) {
        console.error("[Doctor] Failed to push report:", result.error);
      }
    } catch (err) {
      console.error("[Doctor] Push report error:", err.message);
    }
  }

  // --- Poll and execute approved actions ---

  async pollAndExecuteActions() {
    if (!this.serverUrl || !this.apiKey) return;

    try {
      const response = await fetch(
        `${this.serverUrl}/api/v1/agent/doctor/actions`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        }
      );

      if (!response.ok) return;

      const result = await response.json();
      if (!result.ok || !result.data?.actions?.length) return;

      for (const action of result.data.actions) {
        console.log(
          `[Doctor] Executing approved action: ${action.action_type} on ${action.target_kind}/${action.target_name}`
        );

        // Mark as executing
        await this.reportActionResult(action.id, {
          status: "executing",
        });

        try {
          const execResult = await this.executeAction(action);
          await this.reportActionResult(action.id, {
            status: "completed",
            execution_result: execResult,
          });
          console.log(
            `[Doctor] Action ${action.id} completed successfully`
          );
        } catch (err) {
          await this.reportActionResult(action.id, {
            status: "failed",
            execution_result: { error: err.message },
          });
          console.error(
            `[Doctor] Action ${action.id} failed:`,
            err.message
          );
        }
      }
    } catch {
      // Silent
    }
  }

  // --- Execute a single remediation action ---

  async executeAction(action) {
    const { k8sCoreApi, k8sAppsApi } = this.collector;
    const ns = action.target_namespace;
    const name = action.target_name;
    const params = action.parameters || {};

    switch (action.action_type) {
      case "restart_pod": {
        await k8sCoreApi.deleteNamespacedPod(name, ns);
        return { action: "pod_deleted", pod: name, namespace: ns };
      }

      case "restart_deployment": {
        const patch = {
          spec: {
            template: {
              metadata: {
                annotations: {
                  "moniple.com/restartedAt": new Date().toISOString(),
                },
              },
            },
          },
        };
        await k8sAppsApi.patchNamespacedDeployment(
          name,
          ns,
          patch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
        );
        return { action: "deployment_restarted", deployment: name, namespace: ns };
      }

      case "scale_deployment": {
        const replicas = params.replicas;
        if (replicas === undefined) throw new Error("replicas parameter required");
        const scalePatch = { spec: { replicas } };
        await k8sAppsApi.patchNamespacedDeployment(
          name,
          ns,
          scalePatch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
        );
        return { action: "deployment_scaled", deployment: name, namespace: ns, replicas };
      }

      case "delete_pod": {
        await k8sCoreApi.deleteNamespacedPod(name, ns);
        return { action: "pod_deleted", pod: name, namespace: ns };
      }

      case "cordon_node": {
        const cordonPatch = { spec: { unschedulable: true } };
        await k8sCoreApi.patchNode(
          name,
          cordonPatch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
        );
        return { action: "node_cordoned", node: name };
      }

      case "uncordon_node": {
        const uncordonPatch = { spec: { unschedulable: false } };
        await k8sCoreApi.patchNode(
          name,
          uncordonPatch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
        );
        return { action: "node_uncordoned", node: name };
      }

      case "adjust_resources": {
        const container = params.container;
        const resource = params.resource; // cpu or memory
        if (!container || !resource) throw new Error("container and resource parameters required");

        // Read current deployment
        const { body: dep } = await k8sAppsApi.readNamespacedDeployment(name, ns);
        const containers = dep.spec.template.spec.containers;
        const targetContainer = containers.find((c) => c.name === container);
        if (!targetContainer) throw new Error(`Container ${container} not found`);

        // Build patch
        if (!targetContainer.resources) targetContainer.resources = {};
        if (!targetContainer.resources.requests) targetContainer.resources.requests = {};
        if (!targetContainer.resources.limits) targetContainer.resources.limits = {};

        if (params.request) targetContainer.resources.requests[resource] = params.request;
        if (params.limit) targetContainer.resources.limits[resource] = params.limit;

        const resPatch = {
          spec: {
            template: {
              spec: {
                containers: containers,
              },
            },
          },
        };

        await k8sAppsApi.patchNamespacedDeployment(
          name,
          ns,
          resPatch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
        );
        return {
          action: "resources_adjusted",
          deployment: name,
          namespace: ns,
          container,
          resource,
          request: params.request,
          limit: params.limit,
        };
      }

      case "rollback_deployment": {
        try {
          // List ReplicaSets owned by this deployment
          const rsList = await k8sAppsApi.listNamespacedReplicaSet(ns, undefined, undefined, undefined, undefined, `app=${name}`);
          // Filter to only RS owned by this deployment and sort by revision
          const sorted = rsList.body.items
            .filter(rs => rs.metadata.ownerReferences?.some(ref => ref.name === name))
            .sort((a, b) => {
              const revA = parseInt(a.metadata.annotations?.['deployment.kubernetes.io/revision'] || '0');
              const revB = parseInt(b.metadata.annotations?.['deployment.kubernetes.io/revision'] || '0');
              return revB - revA;
            });
          if (sorted.length < 2) {
            return { success: false, message: 'No previous revision found to rollback to' };
          }
          const previousRS = sorted[1];
          // Patch deployment with previous RS template
          await k8sAppsApi.patchNamespacedDeployment(
            name,
            ns,
            { spec: { template: previousRS.spec.template } },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
          );
          const previousRev = previousRS.metadata.annotations?.['deployment.kubernetes.io/revision'] || 'unknown';
          return { action: "deployment_rolled_back", deployment: name, namespace: ns, revision: previousRev };
        } catch (rollbackErr) {
          return { success: false, message: `Rollback failed: ${rollbackErr.message}` };
        }
      }

      case "update_agent": {
        // Self-update: change image tag to target version to bypass registry cache
        const agentNs = process.env.POD_NAMESPACE || params.namespace || "moniple";
        const agentDep = params.deployment || "moniple-agent";
        const targetVersion = params.target_version;
        // Validate version format to prevent injection
        if (targetVersion) {
          const versionRegex = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
          if (!versionRegex.test(targetVersion)) {
            return { success: false, message: `Invalid version format: ${targetVersion}` };
          }
        }
        const targetImage = targetVersion
          ? `nairotech/moniple-agent:v${targetVersion}`
          : "nairotech/moniple-agent:latest";
        console.log(`[Doctor] Updating agent image to ${targetImage}`);
        const updatePatch = {
          spec: {
            template: {
              metadata: {
                annotations: {
                  "moniple.com/updatedAt": new Date().toISOString(),
                },
              },
              spec: {
                containers: [
                  {
                    name: "moniple-agent",
                    image: targetImage,
                  },
                ],
              },
            },
          },
        };
        await k8sAppsApi.patchNamespacedDeployment(
          agentDep,
          agentNs,
          updatePatch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
        );
        return { action: "agent_updated", deployment: agentDep, namespace: agentNs, image: targetImage };
      }

      case "delete_job": {
        // Use batch API if available, otherwise core
        if (this.collector.k8sBatchApi) {
          await this.collector.k8sBatchApi.deleteNamespacedJob(
            name,
            ns,
            undefined,
            undefined,
            undefined,
            undefined,
            "Background"
          );
        }
        return { action: "job_deleted", job: name, namespace: ns };
      }

      default:
        throw new Error(`Unknown action type: ${action.action_type}`);
    }
  }

  // --- Report action execution result ---

  async reportActionResult(actionId, result) {
    if (!this.serverUrl || !this.apiKey) return;

    try {
      await fetch(
        `${this.serverUrl}/api/v1/agent/doctor/actions/${actionId}/result`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(result),
        }
      );
    } catch {
      // Silent
    }
  }

  // --- Schedule Management ---

  startSchedule() {
    // Initial config fetch + pending check after 10 seconds
    setTimeout(async () => {
      try {
        await this.fetchConfig();

        // Check for pending manual triggers
        await this.checkPendingTrigger();

        // Start auto schedule if enabled
        this._setupScheduleTimer();
      } catch (err) {
        console.error("[Doctor] Initial config fetch error:", err.message);
      }
    }, 10000);

    // Refresh config and check pending every 60 seconds (piggybacking on push cycle)
    this.configRefreshInterval = setInterval(async () => {
      try {
        await this.fetchConfig();
        await this.checkPendingTrigger();
        await this.pollAndExecuteActions();
      } catch (err) {
        console.error("[Doctor] Config refresh cycle error:", err.message);
      }
    }, 60000);

    console.log("[Doctor] Diagnostics engine started");
  }

  _setupScheduleTimer() {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }

    if (!this.config?.enabled || !this.config?.schedule?.auto_enabled) {
      return;
    }

    const intervalMs = (this.config.schedule.interval_minutes || 30) * 60 * 1000;
    console.log(
      `[Doctor] Auto-diagnostics scheduled every ${this.config.schedule.interval_minutes || 30} minutes`
    );

    this.scheduleTimer = setInterval(async () => {
      try {
        await this.runDiagnostic("auto");
      } catch (err) {
        console.error("[Doctor] Scheduled diagnostic error:", err.message);
      }
    }, intervalMs);
  }

  stop() {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (this.configRefreshInterval) {
      clearInterval(this.configRefreshInterval);
      this.configRefreshInterval = null;
    }
    console.log("[Doctor] Diagnostics engine stopped");
  }
}

module.exports = { DiagnosticsEngine };
