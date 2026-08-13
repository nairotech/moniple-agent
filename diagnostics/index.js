/**
 * Diagnostics Orchestrator
 * Ties together: config fetch → collect → LLM analyze → push report → poll actions → execute
 */

const { DiagnosticCollector } = require("./collector");
const { LLMClient } = require("./llm-client");
const { getSystemPrompt, getUserPrompt } = require("./prompts");

// NOTE (2026-08-13): this agent performs NO git operations and holds NO
// repository credential. GitOps-aware remediation still works exactly as
// before from the user's point of view — the agent applies the live patch and
// the SERVER makes the matching repo commit (moniple-server
// src/modules/doctor/gitops.service.ts). Previously the server shipped a
// decrypted, write-capable GitHub PAT to every agent on each 60s config poll,
// which meant anyone who could read the agent's API key out of the cluster
// could pull the customer's infrastructure-repo credential out of the API.
// Do NOT reintroduce a code path that asks the server for repo credentials.

// ---------------------------------------------------------------------------
// Remediation guardrails (security)
// ---------------------------------------------------------------------------

// Namespaces the agent must NEVER mutate via remediation, even if the server
// approves an action targeting them. Protects the control plane / system.
// NOTE: the monitoring namespace is intentionally NOT here — legit remediation
// (e.g. restart a stuck vmagent) may target it.
const PROTECTED_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
]);

// Action types the agent is allowed to execute. Anything else is rejected.
const ALLOWED_ACTION_TYPES = new Set([
  "restart_pod",
  "restart_deployment",
  "scale_deployment",
  "delete_pod",
  "cordon_node",
  "uncordon_node",
  "adjust_resources",
  "rollback_deployment",
  "delete_job",
  "expand_pvc",
  "update_agent",
]);

// Destructive actions blocked when DOCTOR_REMEDIATION_MODE=safe.
const DESTRUCTIVE_ACTION_TYPES = new Set([
  "delete_pod",
  "delete_job",
  "scale_deployment",
  "cordon_node",
  "rollback_deployment",
]);

// Remediation mode read once at module load: off | safe | full (default full).
// - off:  reject every remediation action.
// - safe: reject destructive actions, allow the rest.
// - full: allow all allowed/validated actions (default — preserves prod behavior).
const REMEDIATION_MODE = (() => {
  const raw = (process.env.DOCTOR_REMEDIATION_MODE || "full").toLowerCase();
  return ["off", "safe", "full"].includes(raw) ? raw : "full";
})();

// Kubernetes resource quantity (e.g. "100m", "256Mi", "1.5", "2Gi").
const K8S_QUANTITY_REGEX = /^\d+(\.\d+)?(m|Mi|Gi|Ki|M|G|K|Ti|T|P|Pi|n|u)?$/;

// Storage-quantity → bytes for size comparisons (expand_pvc guardrails).
// Returns null for unparseable input; cpu-style suffixes (m/n/u) make no
// sense for storage and also return null.
const STORAGE_UNIT_BYTES = {
  "": 1,
  K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
};
function parseK8sStorageQuantity(q) {
  if (typeof q !== "string") return null;
  const m = q.trim().match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|K|M|G|T|P)?$/);
  if (!m) return null;
  return parseFloat(m[1]) * STORAGE_UNIT_BYTES[m[2] || ""];
}

class DiagnosticsEngine {
  constructor({
    k8sCoreApi,
    k8sAppsApi,
    k8sBatchApi,
    k8sStorageApi,
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
      k8sStorageApi,
      queryPrometheus,
    });
    this.config = null;
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
        // The gitops block here is metadata only ({configured, delivery_mode,
        // managed_by:"server"}). There is nothing to act on: repo
        // connectivity is measured server-side (the agent has no credential
        // with which to measure it) and the commit is made server-side.
        return this.config;
      }
    } catch (err) {
      console.error("[Doctor] Failed to fetch config:", err.message);
    }
    return null;
  }

  // --- GitOps desired state (server-provided LLM context) ---

  /**
   * Ask the SERVER for the attached repo's desired-state workload digest.
   * The server owns the credential and does the (jailed, cached) clone; the
   * agent only receives the extracted digest. Returns null on ANY failure —
   * including an older server without the endpoint (404) — so a scan never
   * fails because a repo was unreachable.
   */
  async fetchDesiredState() {
    if (!this.serverUrl || !this.apiKey) return null;
    try {
      const response = await fetch(
        `${this.serverUrl}/api/v1/agent/doctor/gitops/desired-state`,
        { headers: { Authorization: `Bearer ${this.apiKey}` } }
      );
      if (!response.ok) return null;
      const data = await response.json();
      const digest = data?.data?.digest;
      return digest && Array.isArray(digest.workloads) && digest.workloads.length
        ? digest
        : null;
    } catch (err) {
      console.error("[Doctor] Desired-state fetch failed:", err.message);
      return null;
    }
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

      // 1.5 Analysis context (both best-effort — a scan never fails because
      // the repo or the server was unreachable).
      //
      // GitOps desired-state digest: lets the LLM base proposed values on the
      // manifests that will be committed, and report live-vs-git drift. The
      // digest comes FROM THE SERVER (which owns the repo credential); the
      // agent never clones anything.
      if (this.config?.gitops) {
        const digest = await this.fetchDesiredState();
        if (digest) {
          diagnosticData.gitops_managed = true;
          diagnosticData.gitops_desired_state = digest;
        }
      }

      // Last-2-scan history (this scan makes 3 evaluated in total — kept
      // small deliberately: each report carries findings + actions and the
      // tokens land on the user's LLM bill): powers the rejected-action
      // suppression and the recurring-approved-action root-cause rules.
      const scanHistory = await this.fetchScanHistory();

      // 2. Call LLM for analysis
      const llmClient = new LLMClient(this.config.llm);
      const locale = this.config.llm.locale || "en";
      const minSeverity = this.config.schedule?.min_severity || "warning";
      const systemPrompt = getSystemPrompt(locale, {
        hasGitops: !!diagnosticData.gitops_desired_state,
        hasHistory: !!scanHistory,
      });
      const userPrompt = getUserPrompt(diagnosticData, minSeverity, scanHistory);

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

      // NOTE: gitops_preview used to be computed here (a clone per scan with
      // the customer's PAT). The SERVER computes it now, right after this
      // report is stored, and writes it onto the action rows — it holds the
      // credential and the preview is read by the human who approves the
      // action, so it must not be agent-supplied.

      // 4. Push report to server
      await this.pushReport({
        ...(reportId ? { report_id: reportId } : {}),
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

  // --- Previous-scan history (context for the LLM) ---

  /**
   * Fetch the cluster's last 2 completed scans (findings + action outcomes)
   * from the server. Returns null on ANY failure or when there is no history
   * — the prompt then simply omits the SCAN HISTORY section. Older servers
   * without the endpoint 404 into the same null path.
   */
  async fetchScanHistory() {
    if (!this.serverUrl || !this.apiKey) return null;
    try {
      const response = await fetch(
        `${this.serverUrl}/api/v1/agent/doctor/history?limit=2`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        }
      );
      if (!response.ok) return null;
      const data = await response.json();
      const scans = data?.data?.scans;
      return Array.isArray(scans) && scans.length ? scans : null;
    } catch (err) {
      console.error("[Doctor] Scan history fetch failed:", err.message);
      return null;
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

    // -----------------------------------------------------------------------
    // Guardrails: validate BEFORE any k8s call. Rejected actions throw an
    // Error here; pollAndExecuteActions() catches it and reports the action
    // back to the server as "failed" with the reason (existing failure path).
    // -----------------------------------------------------------------------

    // 1. Remediation globally disabled by agent config.
    if (REMEDIATION_MODE === "off") {
      throw new Error("remediation disabled by agent config");
    }

    // 2. Unknown / unsupported action type.
    if (!ALLOWED_ACTION_TYPES.has(action.action_type)) {
      throw new Error("unsupported action type");
    }

    // 3. Target namespace is on the protected (system) denylist.
    if (ns && PROTECTED_NAMESPACES.has(ns)) {
      throw new Error("protected namespace");
    }

    // 4. Destructive action attempted in safe mode.
    if (
      REMEDIATION_MODE === "safe" &&
      DESTRUCTIVE_ACTION_TYPES.has(action.action_type)
    ) {
      throw new Error("destructive action blocked in safe mode");
    }

    // 5. Per-type parameter validation.
    if (action.action_type === "scale_deployment") {
      const replicas = params.replicas;
      if (
        !Number.isInteger(replicas) ||
        replicas < 0 ||
        replicas > 1000
      ) {
        throw new Error("invalid replicas");
      }
    }

    if (action.action_type === "adjust_resources") {
      for (const bag of [params.request, params.limit]) {
        if (bag === undefined || bag === null) continue;
        // Accept either a bare quantity string or a {cpu, memory} object.
        const values =
          typeof bag === "object" ? Object.values(bag) : [bag];
        for (const v of values) {
          if (v === undefined || v === null) continue;
          if (typeof v !== "string" || !K8S_QUANTITY_REGEX.test(v)) {
            throw new Error("invalid resource quantity");
          }
        }
      }
    }

    // Audit log: every action that passed validation and is about to execute.
    console.log(
      `[Doctor][audit] executing action=${action.action_type} target=${ns || "-"}/${name || "-"} mode=${REMEDIATION_MODE}`
    );

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
        // The matching repo edit (if the cluster has a GitOps repo attached)
        // is made by the SERVER when it receives this result — see
        // moniple-server gitops.service.applyApprovedActionEdit.
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
        const result = {
          action: "resources_adjusted",
          deployment: name,
          namespace: ns,
          container,
          resource,
          request: params.request,
          limit: params.limit,
        };
        return result;
      }

      case "expand_pvc": {
        const k8sStorageApi = this.collector.k8sStorageApi;
        const newSize = params.new_size;
        if (typeof newSize !== "string" || !K8S_QUANTITY_REGEX.test(newSize)) {
          throw new Error("invalid new_size (expected a quantity like 20Gi)");
        }

        const { body: pvc } =
          await k8sCoreApi.readNamespacedPersistentVolumeClaim(name, ns);
        const currentSize = pvc.spec?.resources?.requests?.storage;
        const currentBytes = parseK8sStorageQuantity(currentSize);
        const newBytes = parseK8sStorageQuantity(newSize);
        if (currentBytes === null || newBytes === null) {
          throw new Error("cannot parse PVC sizes for comparison");
        }
        // PVCs can only GROW — a shrink patch is rejected by the API server
        // anyway, but fail it here with a clear reason.
        if (newBytes <= currentBytes) {
          throw new Error(
            `new_size ${newSize} must be larger than current ${currentSize}`,
          );
        }
        // Cost guardrail: refuse absurd one-step growth (>4x current size).
        if (newBytes > currentBytes * 4) {
          throw new Error("new_size exceeds 4x current size — refusing");
        }

        // The StorageClass must allow expansion or the patch would just
        // wedge the PVC in a FileSystemResizePending-less limbo.
        const scName = pvc.spec?.storageClassName;
        if (scName && k8sStorageApi) {
          try {
            const { body: sc } = await k8sStorageApi.readStorageClass(scName);
            if (sc.allowVolumeExpansion !== true) {
              throw new Error(
                `StorageClass ${scName} does not allow volume expansion`,
              );
            }
          } catch (scErr) {
            // Propagate our own guard error; treat a read failure (RBAC/404)
            // as non-fatal and let the API server be the final judge.
            if (String(scErr.message).includes("does not allow")) throw scErr;
          }
        }

        await k8sCoreApi.patchNamespacedPersistentVolumeClaim(
          name,
          ns,
          { spec: { resources: { requests: { storage: newSize } } } },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
        );
        const result = {
          action: "pvc_expanded",
          pvc: name,
          namespace: ns,
          previousSize: currentSize,
          newSize,
          note: "Filesystem resize completes automatically; some provisioners require a pod restart to finish the resize.",
        };
        return result;
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
          // The SERVER makes the matching repo edit, but the concrete
          // previous-revision image is only knowable HERE (from live
          // ReplicaSet history), so report it. More than one container in the
          // previous template means we cannot tell which image the caller
          // meant — report null rather than guess; the server then skips the
          // repo edit and says so (the live rollback already happened).
          const previousContainers = previousRS.spec?.template?.spec?.containers || [];
          const resolvedImage = previousContainers.length === 1 ? previousContainers[0].image : null;
          return {
            action: "deployment_rolled_back",
            deployment: name,
            namespace: ns,
            revision: previousRev,
            resolved_image: resolvedImage,
          };
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

  // NOTE: the GitOps repo edit that used to run here (_applyGitopsEdit ->
  // gitops.applyEdit with the customer's PAT) is gone. The server performs
  // it when this action's result is reported, and writes the outcome to the
  // same `execution_result.gitops` field the app already renders.

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

        // Check for pending triggers (manual AND server-scheduled)
        await this.checkPendingTrigger();
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

  // NOTE: there is deliberately NO agent-local auto-diagnostic timer. The
  // server's schedule processor is the single scheduler: it enforces the
  // per-user scan quota and creates an idempotent PENDING report row, which
  // checkPendingTrigger() above picks up. A local timer would double-scan the
  // cluster (burning the user's LLM tokens), bypass the quota, and its
  // report push (report_id: null) is rejected by the server by design.
  stop() {
    if (this.configRefreshInterval) {
      clearInterval(this.configRefreshInterval);
      this.configRefreshInterval = null;
    }
    console.log("[Doctor] Diagnostics engine stopped");
  }
}

module.exports = { DiagnosticsEngine };
