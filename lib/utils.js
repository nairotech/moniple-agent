// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB", "PiB"];

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return { value: 0, unit: "bytes" };
  let value = parseFloat(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return {
    value: Math.round(value * 10) / 10,
    unit: UNITS[unitIndex],
  };
}

function round(num, decimals = 1) {
  if (num === null || num === undefined || isNaN(num)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(parseFloat(num) * factor) / factor;
}

function getTimestamp() {
  return Math.floor(Date.now() / 1000);
}

module.exports = { formatBytes, round, getTimestamp };
