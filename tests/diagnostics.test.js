"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(require.resolve("../lib/diagnostics.js"), "utf8");

function loadDiagnostics() {
  const sandbox = {
    navigator: { userAgent: "Mozilla/5.0 Chrome/140.0.0.0" },
    location: { pathname: "/broker/private", search: "?account=secret" },
    crypto: { randomUUID: () => "12345678-1234-4234-8234-123456789abc" },
    Date,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return sandbox.IKDiagnostics;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("creates a versioned report only from supplied allowlisted detail", () => {
  const diagnostics = loadDiagnostics();
  const failure = diagnostics.failure({
    phase: "scrape",
    errorCode: "layout_changed",
    brokerDetail: { headers: ["Symbol", "Majetek"], row_count: 3 },
  });
  const report = diagnostics.createReport({
    broker: "fio",
    brokerLabel: "Fio e-Broker",
    pluginVersion: "0.4.0",
    diagnostic: failure,
    memberNote: " stránka se obnovila ",
  });

  assert.equal(report.diagnostic_schema_version, 1);
  assert.equal(report.report_id, "12345678-1234-4234-8234-123456789abc");
  assert.deepEqual(plain(report.common_detail.query), {});
  assert.deepEqual(plain(report.broker_detail), {
    headers: ["Symbol", "Majetek"], row_count: 3,
  });
  assert.equal(report.member_note, "stránka se obnovila");
  assert.equal(report.common_detail.path, "");
  assert.ok(!JSON.stringify(report).includes("account=secret"));
  assert.ok(!JSON.stringify(report).includes("/broker/private"));
  assert.match(report.fingerprint, /^[0-9a-f]{8}$/);
});

test("sanitizes unexpected exceptions to name, step and first-party frames", () => {
  const diagnostics = loadDiagnostics();
  const error = new Error("portfolio value 123456 and account ABC");
  error.stack = "Error: secret\n at scrape (chrome-extension://id/content/brokers/fio.js:184:9)\n at popup (chrome-extension://id/popup/popup.js:77:2)";
  const failure = diagnostics.failure({
    phase: "scrape", errorCode: "unexpected_error", error, step: "fio.scrape",
  });
  const serialized = JSON.stringify(failure);

  assert.deepEqual(plain(failure.commonDetail.exception), {
    name: "Error", step: "fio.scrape", frames: ["fio.js:184", "popup.js:77"],
  });
  assert.ok(!serialized.includes("123456"));
  assert.ok(!serialized.includes("account ABC"));
  assert.ok(!serialized.includes("chrome-extension"));
});

test("unknown phases and codes fail closed to generic values", () => {
  const diagnostics = loadDiagnostics();
  const failure = diagnostics.failure({ phase: "raw_dump", errorCode: "send_everything" });
  assert.equal(failure.phase, "scrape");
  assert.equal(failure.errorCode, "unexpected_error");
});
