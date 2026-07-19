import type { RunReport } from "./types.js";

export type ReportFormat = "json" | "junit" | "pretty";

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function reportAsJson(report: RunReport): string {
  return JSON.stringify(report, null, 2);
}

export function reportAsJUnit(report: RunReport): string {
  const harnessFailure = report.status !== "pass" && report.status !== "fail";
  const tests = report.assertions.length + (harnessFailure ? 1 : 0);
  const failures = report.assertions.filter((assertion) => assertion.status === "fail").length;
  const errors = harnessFailure ? 1 : 0;
  const cases = report.assertions.map((assertion) => {
    const failure = assertion.status === "fail"
      ? `<failure message="${xmlEscape(assertion.message)}">${xmlEscape(JSON.stringify(assertion.details ?? {}))}</failure>`
      : "";
    return `  <testcase classname="synclab.${xmlEscape(report.scenario)}" name="${xmlEscape(assertion.id)}">${failure}</testcase>`;
  });
  if (harnessFailure) {
    cases.push(`  <testcase classname="synclab.${xmlEscape(report.scenario)}" name="harness"><error message="${xmlEscape(report.error ?? report.status)}" /></testcase>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xmlEscape(report.scenario)}" tests="${tests}" failures="${failures}" errors="${errors}" time="0">`,
    ...cases,
    "</testsuite>",
  ].join("\n");
}

export function reportAsPretty(report: RunReport): string {
  const icon = report.status === "pass" ? "PASS" : report.status.toUpperCase();
  const lines = [
    `${icon}  ${report.scenario}`,
    `seed: ${report.seed}`,
    `adapter: ${report.environment.adapter}@${report.environment.adapterVersion}`,
    `virtual time: ${report.virtualTimeMs}ms | events: ${report.processedEvents} | queued: ${report.queuedMessages}`,
  ];
  for (const assertion of report.assertions) {
    lines.push(`${assertion.status === "pass" ? "  ✓" : "  ✗"} ${assertion.id}: ${assertion.message}`);
  }
  if (report.error) lines.push(`error: ${report.error}`);
  if (report.failureSignature) lines.push(`failure: ${report.failureSignature}`);
  lines.push(`trace: ${report.traceFingerprint}`);
  return lines.join("\n");
}

export function renderReport(report: RunReport, format: ReportFormat): string {
  if (format === "json") return reportAsJson(report);
  if (format === "junit") return reportAsJUnit(report);
  return reportAsPretty(report);
}

export function exitCodeFor(report: RunReport): number {
  switch (report.status) {
    case "pass": return 0;
    case "fail": return 1;
    case "invalid": return 2;
    case "harness-error": return 3;
    case "inconclusive": return 4;
  }
}
