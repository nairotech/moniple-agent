const { test } = require("node:test");
const assert = require("node:assert");

function loadFreshConfig(env) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes("/lib/config.js")) delete require.cache[k];
  }
  const saved = { ...process.env };
  // Clear the vars we control so leftovers from the shell don't leak in.
  for (const k of [
    "DEFAULT_THRESHOLD",
    "AUTO_INSTALL_MONITORING",
    "PUSH_INTERVAL_SECONDS",
    "MONIPLE_SERVER_URL",
    "MONIPLE_API_KEY",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  const cfg = require("../lib/config");
  process.env = saved;
  return cfg;
}

test("threshold defaults to 80 when unset/invalid", () => {
  assert.strictEqual(loadFreshConfig({}).threshold, 80);
});

test("threshold honors a numeric override", () => {
  assert.strictEqual(loadFreshConfig({ DEFAULT_THRESHOLD: "90" }).threshold, 90);
});

test("autoInstallMonitoring is false only when explicitly 'false'", () => {
  assert.strictEqual(loadFreshConfig({ AUTO_INSTALL_MONITORING: "false" }).autoInstallMonitoring, false);
  assert.strictEqual(loadFreshConfig({ AUTO_INSTALL_MONITORING: "true" }).autoInstallMonitoring, true);
  assert.strictEqual(loadFreshConfig({}).autoInstallMonitoring, true);
});

test("pushInterval defaults to 60", () => {
  assert.strictEqual(loadFreshConfig({}).pushInterval, 60);
});

test("CONFIG is mutable (not frozen) — monitoring mutates apiUrl at runtime", () => {
  const cfg = loadFreshConfig({});
  cfg.apiUrl = "http://changed/api/v1";
  assert.strictEqual(cfg.apiUrl, "http://changed/api/v1");
});
