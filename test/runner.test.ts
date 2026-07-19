import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario } from "../src/core/runner.js";
import type { BuiltInAdapterName, Scenario } from "../src/core/types.js";

function chaosScenario(adapter: BuiltInAdapterName): Scenario {
  return {
    version: 1,
    name: `${adapter} partition and lifecycle`,
    adapter,
    seed: "stable-seed",
    clients: ["alice", "bob", "carol"],
    initial: { notes: "", items: [], edits: {}, title: "start" },
    network: {
      latencyMs: { min: 1, max: 20 },
      duplicateRate: 0.6,
      reorderRate: 1,
      reorderWindowMs: 30,
    },
    steps: [
      { partition: { groups: [["alice"], ["bob"], ["carol"]] } },
      {
        parallel: [
          { client: "alice", operation: { type: "set", path: ["edits", "alice"], value: true } },
          { client: "bob", operation: { type: "set", path: ["edits", "bob"], value: true } },
          { client: "carol", operation: { type: "set", path: ["edits", "carol"], value: true } },
        ],
      },
      { action: { client: "alice", operation: { type: "text-insert", path: ["notes"], index: 0, text: "A" } } },
      { action: { client: "bob", operation: { type: "text-insert", path: ["notes"], index: 0, text: "B" } } },
      { action: { client: "carol", operation: { type: "list-insert", path: ["items"], index: 0, values: ["C"] } } },
      { clock: { client: "carol", skewMs: 120_000 } },
      { heal: true },
      { settle: true },
      { restart: "bob" },
      { settle: true },
      { reset: "carol" },
      { settle: true },
      { assert: { id: "SYNC002", type: "converged" } },
      { assert: { id: "SYNC009", type: "no-pending" } },
      { assert: { id: "APP001", type: "contains", client: "alice", path: ["notes"], value: "A" } },
      { assert: { id: "APP002", type: "contains", client: "alice", path: ["notes"], value: "B" } },
      { assert: { id: "APP003", type: "length", client: "alice", path: ["items"], value: 1 } },
    ],
  };
}

for (const adapter of ["reference", "yjs", "automerge"] as const) {
  test(`${adapter} converges under partitions, duplicates, reorder, restart, and reset`, async () => {
    const artifact = await runScenario(chaosScenario(adapter));
    assert.equal(artifact.report.status, "pass", artifact.report.error ?? "scenario did not pass");
    assert.equal(new Set(artifact.report.clients.map((client) => client.stateHash)).size, 1);
    assert.ok(artifact.events.some((event) => event.type === "message.duplicated"));
    assert.ok(artifact.events.some((event) => event.type === "client.storage-reset"));
  });

  test(`${adapter} produces a stable trace fingerprint`, async () => {
    const first = await runScenario(chaosScenario(adapter));
    const second = await runScenario(chaosScenario(adapter));
    assert.equal(first.report.traceFingerprint, second.report.traceFingerprint);
    assert.deepEqual(first.decisions, second.decisions);
  });
}

test("failed assertions have a stable signature", async () => {
  const scenario: Scenario = {
    version: 1,
    name: "intentional failure",
    adapter: "reference",
    clients: ["alice"],
    initial: { value: 1 },
    steps: [{ assert: { id: "APP_FAIL", type: "equals", client: "alice", path: ["value"], value: 2 } }],
  };
  const first = await runScenario(scenario);
  const second = await runScenario(scenario);
  assert.equal(first.report.status, "fail");
  assert.equal(first.report.failureSignature, second.report.failureSignature);
});

test("resource exhaustion is inconclusive rather than a pass", async () => {
  const scenario: Scenario = {
    version: 1,
    name: "queue limit",
    adapter: "reference",
    clients: ["alice", "bob", "carol"],
    initial: { value: 0 },
    network: { duplicateRate: 1 },
    limits: { maxQueuedMessages: 1 },
    steps: [{ action: { client: "alice", operation: { type: "set", path: ["value"], value: 1 } } }],
  };
  const artifact = await runScenario(scenario);
  assert.equal(artifact.report.status, "inconclusive");
  assert.match(artifact.report.error ?? "", /maxQueuedMessages/);
  assert.equal(artifact.report.queuedMessages, 0);
  assert.ok(artifact.events.some((event) => event.type === "message.rejected"));
});

test("semantic path errors are invalid scenarios, not harness failures", async () => {
  const scenario: Scenario = {
    version: 1,
    name: "bad path",
    adapter: "reference",
    clients: ["alice"],
    initial: { value: 0 },
    steps: [{ action: { client: "alice", operation: { type: "set", path: ["missing", "value"], value: 1 } } }],
  };
  const artifact = await runScenario(scenario);
  assert.equal(artifact.report.status, "invalid");
});

test("tick advances to its target instead of double-counting delivered event time", async () => {
  const scenario: Scenario = {
    version: 1,
    name: "exact virtual time",
    adapter: "reference",
    clients: ["alice", "bob"],
    initial: { value: 0 },
    network: { latencyMs: 5 },
    steps: [
      { action: { client: "alice", operation: { type: "set", path: ["value"], value: 1 } } },
      { tick: 10 },
      { assert: { type: "all-equal", path: ["value"], value: 1 } },
    ],
  };
  const artifact = await runScenario(scenario);
  assert.equal(artifact.report.status, "pass");
  assert.equal(artifact.report.virtualTimeMs, 10);
});

test("fractional latency ranges are deterministic and supported", async () => {
  const scenario: Scenario = {
    version: 1,
    name: "fractional latency",
    adapter: "reference",
    seed: "fractional",
    clients: ["alice", "bob"],
    initial: { value: 0 },
    network: { latencyMs: { min: 0.1, max: 0.2 } },
    steps: [
      { action: { client: "alice", operation: { type: "set", path: ["value"], value: 1 } } },
      { tick: 1 },
      { assert: { type: "all-equal", path: ["value"], value: 1 } },
    ],
  };
  const first = await runScenario(scenario);
  const second = await runScenario(scenario);
  assert.equal(first.report.status, "pass");
  assert.equal(first.report.virtualTimeMs, 1);
  assert.equal(first.report.traceFingerprint, second.report.traceFingerprint);
});

for (const adapter of ["reference", "yjs", "automerge"] as const) {
  test(`${adapter} classifies invalid list ranges as invalid input`, async () => {
    const artifact = await runScenario({
      version: 1,
      name: `${adapter} invalid list range`,
      adapter,
      clients: ["alice"],
      initial: { items: [] },
      steps: [{ action: { client: "alice", operation: { type: "list-delete", path: ["items"], index: 1 } } }],
    });
    assert.equal(artifact.report.status, "invalid");
  });
}
