import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { minimizeArtifact, readArtifact, replayArtifact, writeArtifact } from "../src/core/artifacts.js";
import { referenceAdapter } from "../src/adapters/reference.js";
import { runScenario } from "../src/core/runner.js";
import type { AdapterFactory, Scenario } from "../src/core/types.js";

function failingScenario(): Scenario {
  return {
    version: 1,
    name: "minimize me",
    adapter: "reference",
    seed: "artifact-seed",
    clients: ["alice"],
    initial: { value: 1 },
    steps: [
      { checkpoint: "noise one" },
      { tick: 5 },
      { checkpoint: "noise two" },
      { assert: { id: "APP_FAIL", type: "equals", client: "alice", path: ["value"], value: 2 } },
      { checkpoint: "noise three" },
    ],
  };
}

test("artifacts round-trip and replay with an identical fingerprint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synclab-artifact-"));
  const path = join(directory, "failure.synclab.json");
  const artifact = await runScenario(failingScenario());
  await writeArtifact(path, artifact);
  const loaded = await readArtifact(path);
  const replay = await replayArtifact(loaded);
  assert.equal(replay.matched, true);
  assert.equal(replay.actualFingerprint, replay.expectedFingerprint);
});

test("delta debugging removes irrelevant scenario steps", async () => {
  const artifact = await runScenario(failingScenario());
  const minimized = await minimizeArtifact(artifact);
  assert.ok(minimized.steps.length < artifact.scenario.steps.length);
  const rerun = await runScenario(minimized, { seed: artifact.seed });
  assert.equal(rerun.report.status, "fail");
  assert.equal(rerun.report.failureSignature, artifact.report.failureSignature);
});

test("one hundred deterministic replays remain stable", async () => {
  const artifact = await runScenario(failingScenario());
  for (let run = 0; run < 100; run += 1) {
    const replay = await replayArtifact(artifact);
    assert.equal(replay.matched, true, `replay ${run} diverged`);
  }
});

test("adapter disposal is part of the replay outcome and fingerprint", async () => {
  const disposalFailure: AdapterFactory = {
    name: "disposal-failure",
    version: "1",
    async create(options) {
      const inner = await referenceAdapter.create(options);
      return {
        name: "disposal-failure",
        version: "1",
        createClient: (id) => inner.createClient(id),
        async dispose() {
          await inner.dispose();
          throw new Error("intentional disposal failure");
        },
      };
    },
  };
  const scenario: Scenario = {
    version: 1,
    name: "disposal is observable",
    adapter: "reference",
    clients: ["alice"],
    initial: { value: 1 },
    steps: [{ assert: { type: "equals", client: "alice", path: ["value"], value: 1 } }],
  };
  const recorded = await runScenario(scenario, { adapter: disposalFailure });
  assert.equal(recorded.report.status, "harness-error");
  assert.match(recorded.report.error ?? "", /disposal failure/);
  assert.ok(recorded.events.some((event) => event.type === "run.error"
    && event.details !== null
    && typeof event.details === "object"
    && !Array.isArray(event.details)
    && event.details.code === "DISPOSE_FAILED"));

  const reproduced = await replayArtifact(recorded, { adapter: disposalFailure });
  assert.equal(reproduced.matched, true);
  const clean = await replayArtifact(recorded, { adapter: referenceAdapter });
  assert.equal(clean.matched, false);
});
