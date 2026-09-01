// Safe diagnostic reports for failed imports (root ADR 0015).
// This module accepts only already-allowlisted detail from broker adapters. It
// never reads DOM, storage, cookies or response bodies itself.
"use strict";

globalThis.IKDiagnostics = (() => {
  const SCHEMA_VERSION = 1;
  const PHASES = new Set(["detect", "scrape", "normalize", "targets", "handoff"]);
  const COMMON_CODES = new Set([
    "page_not_recognized", "login_required", "portfolio_view_missing",
    "layout_changed", "broker_request_failed", "handoff_timeout",
    // Calibration from a SUCCESSFUL but incomplete import (ADR 0015 addendum
    // 2026-09-01): the import went through, yet a title was skipped or an
    // average could not be derived. Offered after success, confirmed by the
    // member exactly like a failure report.
    "partial_import",
    "unexpected_error",
  ]);

  function browserVersion() {
    const ua = navigator.userAgent || "";
    const m = ua.match(/(?:Edg|Chrome)\/(\d+)/);
    return m ? (ua.includes("Edg/") ? `Edge ${m[1]}` : `Chrome ${m[1]}`) : "Chromium";
  }

  function safeException(error, step) {
    const name = typeof error?.name === "string" ? error.name.slice(0, 40) : "Error";
    const frames = String(error?.stack || "").split("\n").slice(1)
      .map((line) => line.match(/(?:^|\/)([a-z0-9_-]+\.js):(\d+)(?::\d+)?/i))
      .filter(Boolean).slice(0, 3)
      .map((m) => `${m[1]}:${m[2]}`);
    return { name, step: String(step || "unknown").slice(0, 64), frames };
  }

  function failure({ phase, errorCode, brokerDetail = {}, error = null, step = null }) {
    return {
      phase: PHASES.has(phase) ? phase : "scrape",
      errorCode: COMMON_CODES.has(errorCode) ? errorCode : "unexpected_error",
      commonDetail: {
        browser: browserVersion(),
        // Generic broker paths often contain usernames/account/portfolio IDs.
        // An adapter may add a known-safe path to its own explicit allowlist
        // (Fio does); the shared envelope never guesses which segments are safe.
        path: "",
        query: {},
        ...(error ? { exception: safeException(error, step) } : {}),
      },
      brokerDetail,
    };
  }

  function fingerprint(report) {
    const source = JSON.stringify([
      report.broker, report.phase, report.error_code,
      report.plugin_version, report.broker_detail,
    ]);
    let hash = 2166136261;
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function createReport({ broker, brokerLabel, pluginVersion, diagnostic, memberNote = "" }) {
    const report = {
      report_id: crypto.randomUUID(),
      diagnostic_schema_version: SCHEMA_VERSION,
      plugin_version: pluginVersion,
      broker,
      broker_label: brokerLabel,
      phase: diagnostic.phase,
      error_code: diagnostic.errorCode,
      created_at: new Date().toISOString(),
      common_detail: diagnostic.commonDetail || {},
      broker_detail: diagnostic.brokerDetail || {},
      member_note: String(memberNote || "").trim().slice(0, 500),
      fingerprint: "",
    };
    report.fingerprint = fingerprint(report);
    return report;
  }

  return { SCHEMA_VERSION, failure, createReport };
})();
