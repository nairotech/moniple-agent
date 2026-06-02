// ============================================================================
// PROMETHEUS/VICTORIAMETRICS API CLIENT
// ============================================================================

const CONFIG = require("./config");

async function queryPrometheus(query) {
  const url = `${CONFIG.apiUrl}/query?query=${encodeURIComponent(query)}`;
  const options = {};

  if (CONFIG.apiUser && CONFIG.apiPassword) {
    const auth = Buffer.from(
      `${CONFIG.apiUser}:${CONFIG.apiPassword}`,
    ).toString("base64");
    options.headers = { Authorization: `Basic ${auth}` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();

    if (data.status === "success") {
      return data.data.result || [];
    }
    console.error("Query failed:", query, data.error);
    return [];
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("Query timeout (30s):", query);
    } else {
      console.error("Fetch error:", error.message);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAlerts() {
  const url = `${CONFIG.apiUrl}/alerts`;
  const options = {};

  if (CONFIG.apiUser && CONFIG.apiPassword) {
    const auth = Buffer.from(
      `${CONFIG.apiUser}:${CONFIG.apiPassword}`,
    ).toString("base64");
    options.headers = { Authorization: `Basic ${auth}` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    return data.status === "success" ? data.data.alerts || [] : [];
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("Alerts fetch timeout (30s)");
    } else {
      console.error("Alerts fetch error:", error.message);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { queryPrometheus, fetchAlerts };
