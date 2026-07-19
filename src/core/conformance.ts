import { runScenario } from "./runner.js";
import type { AdapterFactory, RunReport, Scenario } from "./types.js";

function conformanceScenarios(): Scenario[] {
  return [
    {
      version: 1,
      name: "adapter converges after a three-way partition",
      adapter: "reference",
      seed: "conformance-partition",
      clients: ["alice", "bob", "carol"],
      initial: { title: "", items: [], flags: {} },
      steps: [
        { partition: { groups: [["alice"], ["bob"], ["carol"]] } },
        {
          parallel: [
            { client: "alice", operation: { type: "set", path: ["flags", "alice"], value: true } },
            { client: "bob", operation: { type: "set", path: ["flags", "bob"], value: true } },
            { client: "carol", operation: { type: "set", path: ["flags", "carol"], value: true } },
          ],
        },
        { heal: true },
        { settle: true },
        { assert: { id: "SYNC002", type: "converged" } },
        { assert: { id: "SYNC009", type: "no-pending" } },
      ],
    },
    {
      version: 1,
      name: "adapter ignores duplicate deliveries and survives restart",
      adapter: "reference",
      seed: "conformance-duplicate",
      clients: ["alice", "bob"],
      initial: { title: "before", items: [], flags: {} },
      network: { duplicateRate: 1, latencyMs: { min: 1, max: 5 }, reorderRate: 1, reorderWindowMs: 10 },
      steps: [
        { action: { client: "alice", operation: { type: "set", path: ["title"], value: "after" } } },
        { settle: true },
        { restart: "bob" },
        { settle: true },
        { assert: { id: "SYNC003", type: "all-equal", path: ["title"], value: "after" } },
        { assert: { id: "SYNC002", type: "converged" } },
      ],
    },
    {
      version: 1,
      name: "adapter rebuilds a reset replica from anti-entropy",
      adapter: "reference",
      seed: "conformance-reset",
      clients: ["alice", "bob"],
      initial: { title: "initial", items: [], flags: {} },
      steps: [
        { action: { client: "alice", operation: { type: "set", path: ["title"], value: "durable" } } },
        { settle: true },
        { reset: "bob" },
        { settle: true },
        { assert: { id: "SYNC007", type: "all-equal", path: ["title"], value: "durable" } },
        { assert: { id: "SYNC002", type: "converged" } },
      ],
    },
  ];
}

export interface ConformanceResult {
  adapter: string;
  version: string;
  passed: boolean;
  reports: RunReport[];
}

export async function testAdapter(factory: AdapterFactory): Promise<ConformanceResult> {
  const reports: RunReport[] = [];
  for (const scenario of conformanceScenarios()) {
    reports.push((await runScenario(scenario, { adapter: factory })).report);
  }
  return {
    adapter: factory.name,
    version: factory.version,
    passed: reports.every((report) => report.status === "pass"),
    reports,
  };
}
