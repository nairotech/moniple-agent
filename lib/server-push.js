// ============================================================================
// MONIPLE SERVER PUSH
// ============================================================================

const CONFIG = require("./config");
const collectors = require("./collectors");

async function pushMetricsToServer() {
  if (!CONFIG.serverUrl || !CONFIG.apiKey) {
    return; // Server not configured, skip push
  }

  try {
    console.log(`[${new Date().toISOString()}] Pushing metrics to server...`);

    // Collect all metrics in parallel
    const [overview, node, pod, pvc, ns, alerts] = await Promise.all([
      collectors.getOverviewData().catch((e) => {
        console.error("Overview error:", e.message);
        return null;
      }),
      collectors.getNodeData().catch((e) => {
        console.error("Node error:", e.message);
        return null;
      }),
      collectors.getPodData().catch((e) => {
        console.error("Pod error:", e.message);
        return null;
      }),
      collectors.getPvcData().catch((e) => {
        console.error("PVC error:", e.message);
        return null;
      }),
      collectors.getNsData().catch((e) => {
        console.error("NS error:", e.message);
        return null;
      }),
      collectors.getAlertsData().catch((e) => {
        console.error("Alerts error:", e.message);
        return null;
      }),
    ]);

    // Push to server using /api/v1/agent/snapshots endpoint
    // Cluster ID is automatically resolved from API key on server side
    const response = await fetch(`${CONFIG.serverUrl}/api/v1/agent/snapshots`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify({
        overview,
        node,
        pod,
        pvc,
        ns,
        alerts,
        agent_version: CONFIG.agentBuildDate,
      }),
    });

    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] Push failed with status ${response.status}`);
      return;
    }

    const result = await response.json();
    if (result.ok) {
      console.log(
        `[${new Date().toISOString()}] Metrics pushed successfully:`,
        result.data?.stored?.join(", "),
      );
    } else {
      console.error(`[${new Date().toISOString()}] Push failed:`, result.error);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Push error:`, error.message);
  }
}

// Best-effort "agent installed & running" ping.
//
// Fires on boot BEFORE the slow monitoring-stack install, so the server (and
// therefore the app) learns the agent is up within seconds — well before the
// first metrics push (~70s later). Hits /agent/heartbeat, which records
// agent_connected_at WITHOUT setting has_metrics, so the app shows the
// "installed, waiting for first metrics" screen. Never blocks boot: it retries
// a few times and gives up silently. If it never lands, the first metrics push
// sets both fields anyway and the app simply skips the waiting screen.
async function sendConnectPing() {
  if (!CONFIG.serverUrl || !CONFIG.apiKey) {
    return; // Server not configured, nothing to ping
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${CONFIG.serverUrl}/api/v1/agent/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.apiKey}`,
        },
        body: JSON.stringify({
          agent_version: CONFIG.agentBuildDate,
          timestamp: Math.floor(Date.now() / 1000),
          status: "healthy",
        }),
      });
      if (response.ok) {
        console.log(
          `[${new Date().toISOString()}] Connect ping sent — agent install signaled to server`,
        );
        return;
      }
      console.error(
        `[${new Date().toISOString()}] Connect ping failed: HTTP ${response.status}`,
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Connect ping error (attempt ${attempt}/3):`,
        error.message,
      );
    }
    // Brief backoff before retry (server may still be cold / DNS not ready)
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.error(
    `[${new Date().toISOString()}] Connect ping gave up after 3 attempts (metrics push will set state later)`,
  );
}

// Start push interval
let metricsPushInterval = null;

function startMetricsPush() {
  if (!CONFIG.serverUrl || !CONFIG.apiKey) {
    console.log("Moniple Server not configured. Skipping metrics push.");
    return;
  }

  console.log(
    `Starting metrics push to ${CONFIG.serverUrl} every ${CONFIG.pushInterval}s (agent_build_date: ${CONFIG.agentBuildDate})`,
  );

  // Initial push after 5 seconds
  setTimeout(pushMetricsToServer, 5000);

  // Then push at configured interval
  metricsPushInterval = setInterval(async () => {
    try {
      await pushMetricsToServer();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Unhandled push error:`, err.message);
    }
  }, CONFIG.pushInterval * 1000);
}

function stopMetricsPush() {
  if (metricsPushInterval) {
    clearInterval(metricsPushInterval);
    metricsPushInterval = null;
  }
}

module.exports = {
  pushMetricsToServer,
  sendConnectPing,
  startMetricsPush,
  stopMetricsPush,
};
