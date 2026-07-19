#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { builtInAdapters, resolveAdapter } from "./adapters/index.js";
import { minimizeArtifact, readArtifact, replayArtifact, writeArtifact } from "./core/artifacts.js";
import { testAdapter } from "./core/conformance.js";
import { errorMessage, ScenarioValidationError, SyncLabError } from "./core/errors.js";
import { renderReport, exitCodeFor, type ReportFormat } from "./core/reporters.js";
import { runScenario } from "./core/runner.js";
import { loadScenario } from "./core/scenario.js";
import type { AdapterSpec, FailureArtifact, Scenario } from "./core/types.js";
import { SYNCLAB_VERSION } from "./version.js";

const HELP = `SyncLab ${SYNCLAB_VERSION} — deterministic chaos testing for local-first apps

Usage:
  synclab init [file] [--adapter reference|yjs|automerge]
  synclab validate <scenario>
  synclab run <scenario> [--seed value] [--format pretty|json|junit]
  synclab replay <artifact> [--allow-version-drift]
  synclab minimize <artifact> [--output file]
  synclab doctor [--json]
  synclab adapter test <reference|yjs|automerge|module>
  synclab adapters

Run options:
  --artifact <file>       Write the self-contained trace artifact here
  --output <file>         Write the rendered report here instead of stdout
  --trace-values          Include operation values and checkpoint states in traces

Exit codes: 0 pass, 1 invariant failure, 2 invalid input, 3 harness/replay error,
            4 resource limit reached.`;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "scenario";
}

function formatValue(value: unknown): ReportFormat {
  if (value === undefined) return "pretty";
  if (value === "pretty" || value === "json" || value === "junit") return value;
  throw new ScenarioValidationError(["--format must be pretty, json, or junit"]);
}

async function writeOutput(path: string, text: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${text}\n`, "utf8");
  return absolute;
}

function exampleScenario(adapter: "automerge" | "reference" | "yjs"): string {
  return `version: 1
name: offline edits converge after a partition
description: Three clients edit independently, reconnect, and must converge.
adapter: ${adapter}
seed: demo-42
clients: [alice, bob, carol]
initial:
  title: "Trip plan"
  notes: ""
  items: []
  edits: {}
network:
  latencyMs: { min: 5, max: 40 }
  duplicateRate: 0.25
  reorderRate: 0.5
  reorderWindowMs: 25
steps:
  - partition:
      groups: [[alice], [bob], [carol]]
  - parallel:
      - client: alice
        operation: { type: set, path: [edits, alice], value: packed }
      - client: bob
        operation: { type: set, path: [edits, bob], value: booked }
      - client: carol
        operation: { type: set, path: [edits, carol], value: mapped }
  - heal: true
  - settle: true
  - assert: { id: SYNC002, type: converged }
  - assert: { id: SYNC009, type: no-pending }
`;
}

async function commandInit(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { adapter: { type: "string", default: "yjs" } },
  });
  const adapter = parsed.values.adapter;
  if (adapter !== "reference" && adapter !== "yjs" && adapter !== "automerge") {
    throw new ScenarioValidationError(["--adapter must be reference, yjs, or automerge"]);
  }
  const target = resolve(parsed.positionals[0] ?? "synclab.yml");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, exampleScenario(adapter), { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Created ${target}\nRun: synclab run ${target}\n`);
  return 0;
}

async function commandValidate(args: string[]): Promise<number> {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: "boolean" } } });
  const path = parsed.positionals[0];
  if (!path) throw new ScenarioValidationError(["validate requires a scenario path"]);
  const loaded = await loadScenario(path);
  const result = { valid: true, path: loaded.path, name: loaded.scenario.name, clients: loaded.scenario.clients.length, steps: loaded.scenario.steps.length };
  process.stdout.write(parsed.values.json ? `${JSON.stringify(result, null, 2)}\n` : `Valid: ${result.name} (${result.clients} clients, ${result.steps} steps)\n`);
  return 0;
}

async function commandRun(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      seed: { type: "string" },
      format: { type: "string", default: "pretty" },
      artifact: { type: "string" },
      output: { type: "string" },
      "trace-values": { type: "boolean", default: false },
    },
  });
  const path = parsed.positionals[0];
  if (!path) throw new ScenarioValidationError(["run requires a scenario path"]);
  const loaded = await loadScenario(path);
  const artifact = await runScenario(loaded.scenario, {
    ...(parsed.values.seed === undefined ? {} : { seed: parsed.values.seed }),
    baseDirectory: loaded.baseDirectory,
    traceValues: parsed.values["trace-values"],
  });
  const format = formatValue(parsed.values.format);
  const rendered = renderReport(artifact.report, format);
  if (parsed.values.output) await writeOutput(parsed.values.output, rendered);
  else process.stdout.write(`${rendered}\n`);

  let artifactPath = parsed.values.artifact;
  if (!artifactPath && artifact.report.status !== "pass") {
    artifactPath = `.synclab/${slug(loaded.scenario.name)}-${slug(artifact.seed)}.synclab.json`;
  }
  if (artifactPath) {
    const written = await writeArtifact(artifactPath, artifact);
    const note = `artifact: ${written}`;
    if (format === "pretty" && !parsed.values.output) process.stdout.write(`${note}\n`);
    else process.stderr.write(`${note}\n`);
  }
  return exitCodeFor(artifact.report);
}

async function commandReplay(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      format: { type: "string", default: "pretty" },
      "allow-version-drift": { type: "boolean", default: false },
    },
  });
  const path = parsed.positionals[0];
  if (!path) throw new ScenarioValidationError(["replay requires an artifact path"]);
  const recorded = await readArtifact(path);
  const replay = await replayArtifact(recorded, {
    allowVersionDrift: parsed.values["allow-version-drift"],
    baseDirectory: dirname(resolve(path)),
  });
  const format = formatValue(parsed.values.format);
  process.stdout.write(`${renderReport(replay.artifact.report, format)}\n`);
  if (!replay.matched) {
    process.stderr.write(`TRACE_DIVERGENCE: expected ${replay.expectedFingerprint}, got ${replay.actualFingerprint}\n`);
    return 3;
  }
  if (format === "pretty") process.stdout.write("replay: fingerprint matched\n");
  return exitCodeFor(replay.artifact.report);
}

async function commandMinimize(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { output: { type: "string" } },
  });
  const path = parsed.positionals[0];
  if (!path) throw new ScenarioValidationError(["minimize requires an artifact path"]);
  const recorded = await readArtifact(path);
  const baseDirectory = dirname(resolve(path));
  const minimized = await minimizeArtifact(recorded, { baseDirectory });
  const minimizedRun = await runScenario(minimized, { seed: recorded.seed, baseDirectory });
  const outputArtifact: FailureArtifact = {
    ...minimizedRun,
    originalScenario: recorded.scenario,
    minimizedScenario: minimized,
  };
  const extension = extname(path);
  const defaultOutput = resolve(dirname(path), `${basename(path, extension)}.min${extension || ".json"}`);
  const output = await writeArtifact(parsed.values.output ?? defaultOutput, outputArtifact);
  process.stdout.write(`Minimized ${recorded.scenario.steps.length} steps to ${minimized.steps.length}\n${output}\n`);
  return 0;
}

async function commandDoctor(args: string[]): Promise<number> {
  const parsed = parseArgs({ args, allowPositionals: false, strict: true, options: { json: { type: "boolean" } } });
  const results = [];
  for (const adapter of Object.values(builtInAdapters)) results.push(await testAdapter(adapter));
  const report = {
    ok: results.every((result) => result.passed),
    synclab: SYNCLAB_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    adapters: results.map((result) => ({
      name: result.adapter,
      version: result.version,
      passed: result.passed,
      scenarios: result.reports.map((entry) => ({ name: entry.scenario, status: entry.status })),
    })),
  };
  if (parsed.values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`SyncLab ${report.synclab}\nNode ${report.node} (${report.platform})\n`);
    for (const adapter of report.adapters) process.stdout.write(`${adapter.passed ? "✓" : "✗"} ${adapter.name}@${adapter.version}\n`);
  }
  return report.ok ? 0 : 3;
}

async function commandAdapter(args: string[]): Promise<number> {
  if (args[0] !== "test" || !args[1]) throw new ScenarioValidationError(["Usage: synclab adapter test <adapter or module>"]);
  const target = args[1];
  const spec: AdapterSpec = target === "reference" || target === "yjs" || target === "automerge"
    ? target
    : { module: target };
  const factory = await resolveAdapter(spec);
  const result = await testAdapter(factory);
  process.stdout.write(`${result.passed ? "PASS" : "FAIL"} ${result.adapter}@${result.version}\n`);
  for (const report of result.reports) process.stdout.write(`  ${report.status === "pass" ? "✓" : "✗"} ${report.scenario}\n`);
  return result.passed ? 0 : 3;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${SYNCLAB_VERSION}\n`);
    return 0;
  }
  switch (command) {
    case "init": return commandInit(args);
    case "validate": return commandValidate(args);
    case "run": return commandRun(args);
    case "replay": return commandReplay(args);
    case "minimize": return commandMinimize(args);
    case "doctor": return commandDoctor(args);
    case "adapter": return commandAdapter(args);
    case "adapters":
      for (const adapter of Object.values(builtInAdapters)) process.stdout.write(`${adapter.name}\t${adapter.version}\n`);
      return 0;
    default:
      throw new ScenarioValidationError([`Unknown command \"${command}\"`]);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const code = error instanceof ScenarioValidationError || error instanceof SyntaxError || error instanceof TypeError ? 2
    : error instanceof SyncLabError && error.code === "NOT_MINIMIZABLE" ? 2
      : 3;
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = code;
}
