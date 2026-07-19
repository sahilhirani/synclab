import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario } from "../src/core/runner.js";
import type { BuiltInAdapterName, Scenario, ScenarioStep } from "../src/core/types.js";

const clients = ["alice", "bob", "carol"] as const;

function generatedScenario(adapter: BuiltInAdapterName, run: number): Scenario {
  const steps: ScenarioStep[] = [
    { partition: { groups: [["alice"], ["bob"], ["carol"]] } },
  ];
  for (let operation = 0; operation < 8; operation += 1) {
    const client = clients[(run * 7 + operation * 5) % clients.length]!;
    steps.push({
      action: {
        client,
        operation: {
          type: "set",
          path: ["values", `r${run}-o${operation}`],
          value: { client, value: run * 100 + operation },
        },
      },
    });
    if (operation === 3 && run % 3 === 0) steps.push({ restart: client });
    if (operation === 5 && run % 7 === 0) steps.push({ clock: { client, skewMs: run % 2 === 0 ? 60_000 : -60_000 } });
  }
  steps.push(
    { network: { dropRate: 0, duplicateRate: 0.4, reorderRate: 0.7, reorderWindowMs: 15 } },
    { heal: true },
    { sync: true },
    { settle: true },
    { assert: { id: "SYNC002", type: "converged" } },
    { assert: { id: "SYNC009", type: "no-pending" } },
    { assert: { id: "ALL_WRITES", type: "length", client: "alice", path: ["values"], value: 8 } },
  );
  return {
    version: 1,
    name: `${adapter} generated run ${run}`,
    adapter,
    seed: `generated-${run}`,
    clients: [...clients],
    initial: { values: {} },
    network: {
      latencyMs: { min: 0, max: 10 },
      dropRate: (run % 5) / 10,
      duplicateRate: (run % 4) / 5,
      reorderRate: (run % 3) / 3,
      reorderWindowMs: 20,
    },
    steps,
  };
}

for (const adapter of ["reference", "yjs", "automerge"] as const) {
  test(`${adapter} passes 100 bounded generated chaos scenarios`, async () => {
    for (let run = 0; run < 100; run += 1) {
      const artifact = await runScenario(generatedScenario(adapter, run));
      assert.equal(artifact.report.status, "pass", `${artifact.report.scenario}: ${artifact.report.error ?? artifact.report.failureSignature}`);
    }
  });
}
