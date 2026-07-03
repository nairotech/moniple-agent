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
    serverPush.startMetricsPush();

    // Start diagnostics engine (Doctor)
    startDiagnosticsEngine();
  });

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
}

// Start the server
startServer();
