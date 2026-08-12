const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const { DiagnosticsEngine } = require("./diagnostics");
const CONFIG = require("./lib/config");
const swaggerDocument = require("./lib/swagger");
const { queryPrometheus } = require("./lib/prometheus");
const k8sClient = require("./lib/k8s/client");
const monitoring = require("./lib/k8s/monitoring");
const serverPush = require("./lib/server-push");
const { registerRoutes } = require("./lib/routes");

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
// HTTP ROUTES (/health + /metrics/*)
// ============================================================================

registerRoutes(app);

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
      k8sCoreApi: k8sClient.getCoreApi(),
      k8sAppsApi: k8sClient.getAppsApi(),
      k8sBatchApi: k8sClient.getBatchApi(),
      k8sStorageApi: k8sClient.getStorageApi(),
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
  serverPush.sendConnectPing();

  // Start Express FIRST — before ensureMonitoringStack() below. That install
  // makes ~15-25 sequential k8s API calls with none of them timeout-guarded;
  // awaiting it here (as before) left /health unreachable for however long
  // that took. With the install manifest's periodSeconds:10 and the (pre-
  // startupProbe) default failureThreshold:3, a slow or hanging install step
  // got the pod killed by kubelet before it ever started listening — a fresh
  // pod repeats the same slow install and gets killed again, looping
  // forever. That is the exact signature of the 2026-07 two-day restart
  // incident: the fix applied at the time (timeoutSeconds 1->5) only widened
  // the probe window AFTER listen(), not the window BEFORE it. The agent
  // already reports null metrics until the monitoring stack is up (see
  // collectors.js), so it is safe — and now required — to serve /health
  // immediately and run the stack install in the background.
  const server = app.listen(port, () => {
    console.log(`Moniple Agent running on port ${port} (build: ${CONFIG.agentBuildDate})`);
    console.log(`Prometheus API: ${CONFIG.apiUrl}`);

    // Start pushing metrics to server
    serverPush.startMetricsPush();

    // Start diagnostics engine (Doctor)
    startDiagnosticsEngine();
  });

  // Initialize Kubernetes client and ensure monitoring stack — fire-and-
  // forget, now that the HTTP server is already listening. Errors are
  // logged, never thrown into the caller (matches the previous try/catch).
  if (CONFIG.autoInstallMonitoring) {
    const k8sInitialized = k8sClient.initKubernetesClient();
    if (k8sInitialized) {
      monitoring.ensureMonitoringStack().catch((error) => {
        console.error("Error ensuring monitoring stack:", error.message);
      });
    } else {
      console.log("Kubernetes client not available. Skipping auto-install.");
    }
  } else {
    console.log(
      "Auto-install monitoring disabled (AUTO_INSTALL_MONITORING=false)",
    );
  }

  // Graceful shutdown handler
  const shutdown = () => {
    console.log("Shutting down gracefully...");

    serverPush.stopMetricsPush();

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

  // Returned for tests (see test/app-startup-order.test.js); unused by the
  // real entrypoint below, which doesn't capture the call.
  return server;
}

// Start the server — but only when this file is the process entrypoint
// (`node app.js` / the Docker CMD), never on a plain `require("./app")` from
// a test, so startServer's ordering can be exercised directly with mocked
// k8s/monitoring dependencies (see test/app-startup-order.test.js).
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
