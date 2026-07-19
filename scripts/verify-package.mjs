import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("pack:verify must be run through npm so npm_execpath is available");
const project = process.cwd();
let temporary;
let tarball;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? project,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.error?.message ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout;
}

try {
  const packed = JSON.parse(run(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts"]));
  assert.equal(Array.isArray(packed), true);
  tarball = resolve(project, packed[0].filename);
  temporary = await mkdtemp(join(tmpdir(), "synclab-package-"));
  await writeFile(join(temporary, "package.json"), '{"name":"synclab-package-check","private":true,"type":"module"}\n', "utf8");
  run(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], { cwd: temporary });

  const packageRoot = join(temporary, "node_modules", "synclab");
  const api = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
  assert.equal(api.SYNCLAB_VERSION, "0.1.0");
  assert.equal(typeof api.runScenario, "function");

  const cli = join(packageRoot, "dist", "cli.js");
  assert.equal(run(process.execPath, [cli, "--version"], { cwd: temporary }).trim(), "0.1.0");
  const scenarioPath = join(temporary, "smoke.json");
  await writeFile(scenarioPath, JSON.stringify({
    version: 1,
    name: "packed package smoke test",
    adapter: "yjs",
    clients: ["alice", "bob"],
    initial: { value: 0 },
    steps: [
      { action: { client: "alice", operation: { type: "set", path: ["value"], value: 1 } } },
      { settle: true },
      { assert: { type: "converged" } },
    ],
  }), "utf8");
  const report = JSON.parse(run(process.execPath, [cli, "run", scenarioPath, "--format", "json"], { cwd: temporary }));
  assert.equal(report.status, "pass");
  process.stdout.write(`✓ installed ${basename(tarball)} into an empty project and exercised its API and CLI\n`);
} finally {
  if (tarball) await rm(tarball, { force: true });
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
