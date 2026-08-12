// ============================================================================
// HTTP ROUTES (local read API: /health + /metrics/*)
// ============================================================================

const CONFIG = require("./config");
const collectors = require("./collectors");
const { getTimestamp } = require("./utils");

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

function registerRoutes(app) {
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
}

module.exports = { registerRoutes, apiKeyAuth };
