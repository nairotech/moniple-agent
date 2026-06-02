// ============================================================================
// CONFIGURATION
// ============================================================================
// NOTE: CONFIG is intentionally a plain (non-frozen) object. ensureMonitoringStack()
// mutates CONFIG.apiUrl at runtime after auto-installing the monitoring stack.

require("dotenv").config();

const CONFIG = {
  apiUrl: process.env.PROMETHEUS_API_URL || "http://prometheus:9090/api/v1",
  apiUser: process.env.PROMETHEUS_API_USER || "",
  apiPassword: process.env.PROMETHEUS_API_PASSWORD || "",
  threshold: Number.isNaN(parseInt(process.env.DEFAULT_THRESHOLD)) ? 80 : parseInt(process.env.DEFAULT_THRESHOLD),
  // Moniple Server config
  serverUrl: process.env.MONIPLE_SERVER_URL || "",
  apiKey: process.env.MONIPLE_API_KEY || "",
  pushInterval: parseInt(process.env.PUSH_INTERVAL_SECONDS) || 60,
  // Auto-install monitoring stack
  autoInstallMonitoring: process.env.AUTO_INSTALL_MONITORING !== "false",
  monitoringNamespace: process.env.MONITORING_NAMESPACE || "moniple",
  // Agent build date (injected at Docker build time)
  agentBuildDate: process.env.AGENT_BUILD_DATE || "0",
};

module.exports = CONFIG;
