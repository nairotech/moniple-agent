/**
 * Startup ordering fix (2026-08-12): the HTTP server must start accepting
 * /health checks WITHOUT waiting for monitoring.ensureMonitoringStack() to
 * finish. ensureMonitoringStack() makes ~15-25 sequential k8s API calls with
 * no per-call timeout; awaiting it before app.listen() (the old code) left
 * /health unreachable for the whole duration. With the install manifest's
 * periodSeconds:10 (pre-startupProbe default failureThreshold:3 = 30s to
 * first kill), a slow or hanging install step got the pod killed by kubelet
 * before it ever started listening — a fresh pod repeats the same slow
 * install and gets killed again, looping forever. That is the exact
 * signature of the 2026-07 two-day restart incident.
 *
 * app.js self-invokes startServer() only when it is the process entrypoint
 * (`require.main === module`, i.e. `node app.js` / the Docker CMD) —
 * requiring it here does NOT also start a real server, so this file drives
 * startServer() itself with the k8s client + monitoring stack stubbed out.
 */
const { test, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");

// No server URL/API key configured -> sendConnectPing/startMetricsPush/
// startDiagnosticsEngine all no-op (see lib/config.js) — no real network I/O
// or dangling timers. PORT=0 asks the OS for a free ephemeral port so this
// can never collide with another test file's server.
process.env.MONIPLE_SERVER_URL = "";
process.env.MONIPLE_API_KEY = "";
process.env.PORT = "0";
process.env.AUTO_INSTALL_MONITORING = "true";

const k8sClient = require("../lib/k8s/client");
const monitoring = require("../lib/k8s/monitoring");

const state = { stackStarted: false, stackResolved: false };
let releaseStack;

k8sClient.initKubernetesClient = () => true;
monitoring.ensureMonitoringStack = () => {
  state.stackStarted = true;
  // Deliberately never resolves on its own — stands in for a slow/hanging
  // sequential k8s API call chain (the real function makes ~15-25 of them,
  // none timeout-guarded).
  return new Promise((resolve) => {
    releaseStack = () => {
      state.stackResolved = true;
      resolve();
    };
  });
};

const { startServer } = require("../app.js");

let server;
after(async () => {
  if (releaseStack) releaseStack(); // don't leak a dangling promise
  if (server) await new Promise((resolve) => server.close(resolve));
});

function getHealth(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/health`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

test("app.listen() serves /health while ensureMonitoringStack() is still pending", async () => {
  server = await startServer();
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", resolve);
  });
  const port = server.address().port;

  assert.ok(state.stackStarted, "ensureMonitoringStack should have been kicked off");
  assert.strictEqual(
    state.stackResolved,
    false,
    "the install must still be pending once the server is already listening",
  );

  const res = await getHealth(port);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.body).ok, true);

  // Still unresolved even after a full, successful /health round trip —
  // proves listen() did not wait for (or get blocked by) the install.
  assert.strictEqual(
    state.stackResolved,
    false,
    "the install is still running in the background after /health already answered",
  );
});
