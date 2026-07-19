import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const cli = resolve("src/cli.ts");
const tsxLoader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;

function runCli(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("CLI prints its version", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.1.0");
});

test("CLI init, validate, and run form a complete quick start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synclab-cli-"));
  const scenario = join(directory, "demo.yml");
  const initialized = runCli(["init", scenario, "--adapter", "yjs"], directory);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(existsSync(scenario), true);
  const validated = runCli(["validate", scenario, "--json"], directory);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).valid, true);
  const executed = runCli(["run", scenario, "--format", "json"], directory);
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).status, "pass");
});

test("CLI returns exit code 1 and writes a replay artifact for invariant failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synclab-cli-failure-"));
  const scenario = join(directory, "failure.json");
  await writeFile(scenario, JSON.stringify({
    version: 1,
    name: "cli failure",
    adapter: "reference",
    clients: ["alice"],
    initial: { value: 1 },
    steps: [{ assert: { id: "FAIL", type: "equals", client: "alice", path: ["value"], value: 2 } }],
  }), "utf8");
  const artifact = join(directory, "failure.synclab.json");
  const executed = runCli(["run", scenario, "--artifact", artifact], directory);
  assert.equal(executed.status, 1, executed.stderr);
  assert.equal(existsSync(artifact), true);
  const replayed = runCli(["replay", artifact], directory);
  assert.equal(replayed.status, 1, replayed.stderr);
  assert.match(replayed.stdout, /fingerprint matched/);
});

test("separate CLI processes produce the same deterministic fingerprint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synclab-cli-determinism-"));
  const scenario = join(directory, "deterministic.json");
  await writeFile(scenario, JSON.stringify({
    version: 1,
    name: "process determinism",
    adapter: "automerge",
    seed: "same-process-seed",
    clients: ["alice", "bob"],
    initial: { value: 0 },
    network: { latencyMs: { min: 1, max: 9 }, duplicateRate: 0.5 },
    steps: [
      { action: { client: "alice", operation: { type: "set", path: ["value"], value: 1 } } },
      { settle: true },
      { assert: { type: "converged" } },
    ],
  }), "utf8");
  const first = runCli(["run", scenario, "--format", "json"], directory);
  const second = runCli(["run", scenario, "--format", "json"], directory);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(first.stdout).traceFingerprint, JSON.parse(second.stdout).traceFingerprint);
});

test("unknown CLI options are invalid input", () => {
  const result = runCli(["doctor", "--unknown"]);
  assert.equal(result.status, 2);
});
