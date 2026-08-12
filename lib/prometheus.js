// ============================================================================
// PROMETHEUS/VICTORIAMETRICS API CLIENT
// ============================================================================

const CONFIG = require("./config");

/**
 * Run an instant PromQL query.
 *
 * Returns:
 *   Array  — the (possibly EMPTY) result of a successful query
 *   null   — the query FAILED (transport error, timeout, API error)
 *
 * The distinction is load-bearing: collectors must never turn "we could not
 * measure" into "the value is zero". Returning [] for a failed query is what
 * made a single bad push publish `cpu: 0% / memory: 0%` for a whole cluster
 * (measured: 21 one-minute zero readings on one cluster in 3 days — memory can
 * never legitimately be 0%). Callers that genuinely do not care may use
 * `?? []`, but they have to say so explicitly.
 */
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
    return null; // failure — NOT an empty result
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("Query timeout (30s):", query);
    } else {
      console.error("Fetch error:", error.message);
    }
    return null; // failure — NOT an empty result
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch active alerts.
 *
 * Deliberately keeps the legacy `[]`-on-failure contract: an alerting backend
 * is optional (a cluster without vmalert legitimately has zero alerts), and the
 * alerts snapshot feeds a server-side ingest path with its own semantics.
 * Failing "quiet" here is the historical behaviour and is out of scope for the
 * metric-accuracy work.
 */
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
