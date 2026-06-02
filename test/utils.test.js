const { test } = require("node:test");
const assert = require("node:assert");
const { formatBytes, round, getTimestamp } = require("../lib/utils");

test("formatBytes picks the right unit", () => {
  assert.deepStrictEqual(formatBytes(0), { value: 0, unit: "bytes" });
  assert.deepStrictEqual(formatBytes(null), { value: 0, unit: "bytes" });
  assert.strictEqual(formatBytes(512).unit, "bytes");
  assert.strictEqual(formatBytes(2048).unit, "KiB");
  assert.strictEqual(formatBytes(2048).value, 2);
  assert.strictEqual(formatBytes(5 * 1024 * 1024).unit, "MiB");
  assert.strictEqual(formatBytes(3 * 1024 * 1024 * 1024).unit, "GiB");
  assert.strictEqual(formatBytes(2 * 1024 ** 4).unit, "TiB");
});

test("round respects decimals (default 1)", () => {
  assert.strictEqual(round(1.2345), 1.2);
  assert.strictEqual(round(1.2345, 2), 1.23);
  assert.strictEqual(round(NaN), 0);
  assert.strictEqual(round(null), 0);
  assert.strictEqual(round(undefined), 0);
});

test("getTimestamp returns integer unix seconds", () => {
  const t = getTimestamp();
  assert.strictEqual(Number.isInteger(t), true);
  assert.ok(t > 1_000_000_000);
});
