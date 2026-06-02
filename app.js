const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const k8s = require("@kubernetes/client-node");
const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");
const { DiagnosticsEngine } = require("./diagnostics");
const CONFIG = require("./lib/config");
const { formatBytes, round, getTimestamp } = require("./lib/utils");
const QUERIES = require("./lib/queries");
const swaggerDocument = require("./lib/swagger");
const { queryPrometheus, fetchAlerts } = require("./lib/prometheus");
const k8sClient = require("./lib/k8s/client");
const monitoring = require("./lib/k8s/monitoring");
const collectors = require("./lib/collectors");

const app = express();
const port = process.env.PORT || 3000;

// CORS
// These are machine endpoints (k8s probes + agent→server push), not a browser
// app — so CORS is disabled by default. The SaaS metrics push is the agent
// initiating outbound requests, which is NOT subject to browser CORS, so this
// does not affect it. An operator can opt into a specific origin via
// AGENT_CORS_ORIGIN (e.g. a debugging dashboard) if ever needed.
app.use(
  cors({
    origin: process.env.AGENT_CORS_ORIGIN || false,
    methods: ["GET", "POST", "OPTIONS"],
  }),
);


// Swagger UI
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocument, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "Moniple Agent API",
  }),
);

// Swagger JSON endpoint
app.get("/swagger.json", (req, res) => {
  res.json(swaggerDocument);
});


// ============================================================================
// API KEY AUTH MIDDLEWARE
// ============================================================================

const apiKeyAuth = (req, res, next) => {
  // Header-only: accept the key via x-api-key header (no query-string fallback,
  // which would leak the key into logs/referrers).
  const apiKey = req.headers['x-api-key'];

  // Fail-closed: when no key is configured, deny access UNLESS the operator has
  // explicitly opted into unauthenticated metrics. Production agents set
  // MONIPLE_API_KEY, so the valid-key path below is unchanged for them.
  if (!CONFIG.apiKey) {
    if (process.env.ALLOW_UNAUTHENTICATED_METRICS === "true") {
      return next();
    }
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (apiKey === CONFIG.apiKey) {
    return next();
  }
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
};

// ============================================================================
// ENDPOINTS
// ============================================================================

// Health check (no auth required)
app.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: getTimestamp() });
});

// Apply API key auth to all /metrics/* routes
app.use("/metrics", apiKeyAuth);

// -----------------------------------------------------------------------------
// GET /metrics/ns - Namespace listesi
// -----------------------------------------------------------------------------
app.get("/metrics/ns", async (req, res) => {
  try {
    const data = await collectors.getNsData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/pod - Pod durumları ve resource kullanımı
// -----------------------------------------------------------------------------
app.get("/metrics/pod", async (req, res) => {
  try {
    const data = await collectors.getPodData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/pvc - PersistentVolumeClaim durumları
// -----------------------------------------------------------------------------
app.get("/metrics/pvc", async (req, res) => {
  try {
    const data = await collectors.getPvcData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/node - Node durumları ve resource kullanımı
// -----------------------------------------------------------------------------
app.get("/metrics/node", async (req, res) => {
  try {
    const data = await collectors.getNodeData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/alerts - Aktif alertler
// -----------------------------------------------------------------------------
app.get("/metrics/alerts", async (req, res) => {
  try {
    const data = await collectors.getAlertsData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/overview - Mobil dashboard için tek endpoint
// -----------------------------------------------------------------------------
app.get("/metrics/overview", async (req, res) => {
  try {
    const data = await collectors.getOverviewData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// MONIPLE SERVER PUSH FUNCTIONS
// ============================================================================

// Internal functions to get metrics data (reuse endpoint logic)

// Push all metrics to Moniple Server
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

// ============================================================================
// DIAGNOSTICS ENGINE (DOCTOR)
// ============================================================================

let diagnosticsEngine = null;

function startDiagnosticsEngine() {
  if (!CONFIG.serverUrl || !CONFIG.apiKey) {
    console.log("[Doctor] Server not configured. Diagnostics disabled.");
    return;
  }

  try {
    diagnosticsEngine = new DiagnosticsEngine({
      k8sCoreApi,
      k8sAppsApi,
      k8sBatchApi,
      queryPrometheus,
      serverUrl: CONFIG.serverUrl,
      apiKey: CONFIG.apiKey,
    });

    diagnosticsEngine.startSchedule();
  } catch (err) {
    console.error("[Doctor] Failed to start diagnostics engine:", err.message);
  }
}

// ============================================================================
// START SERVER
// ============================================================================

async function startServer() {
  // Fire-and-forget: signal "agent installed & running" to the server BEFORE
  // the slow monitoring-stack install below, so the app flips from the install
  // guide to "waiting for first metrics" within seconds. Not awaited — must
  // never delay or block boot.
  sendConnectPing();

  // Initialize Kubernetes client and ensure monitoring stack
  if (CONFIG.autoInstallMonitoring) {
    const k8sInitialized = k8sClient.initKubernetesClient();
    if (k8sInitialized) {
      try {
        await monitoring.ensureMonitoringStack();
      } catch (error) {
        console.error("Error ensuring monitoring stack:", error.message);
      }
    } else {
      console.log("Kubernetes client not available. Skipping auto-install.");
    }
  } else {
    console.log(
      "Auto-install monitoring disabled (AUTO_INSTALL_MONITORING=false)",
    );
  }

  // Start Express server
  const server = app.listen(port, () => {
    console.log(`Moniple Agent running on port ${port} (build: ${CONFIG.agentBuildDate})`);
    console.log(`Prometheus API: ${CONFIG.apiUrl}`);

    // Start pushing metrics to server
    startMetricsPush();

    // Start diagnostics engine (Doctor)
    startDiagnosticsEngine();
  });

  // Graceful shutdown handler
  const shutdown = () => {
    console.log("Shutting down gracefully...");

    if (metricsPushInterval) {
      clearInterval(metricsPushInterval);
      metricsPushInterval = null;
    }

    if (diagnosticsEngine) {
      diagnosticsEngine.stop();
    }

    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });

    // Force exit after 10 seconds if server.close hangs
    setTimeout(() => {
      console.error("Forced shutdown after timeout.");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Start the server
startServer();
