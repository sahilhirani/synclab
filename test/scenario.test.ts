import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScenarioValidationError } from "../src/core/errors.js";
import { loadScenario, validateScenario } from "../src/core/scenario.js";

const validScenario = {
  version: 1,
  name: "valid",
  adapter: "reference",
  clients: ["alice", "bob"],
  initial: { title: "hello" },
  steps: [
    { action: { client: "alice", operation: { type: "set", path: ["title"], value: "world" } } },
    { settle: true },
    { assert: { type: "converged" } },
  ],
};

test("scenario validation accepts the strict v1 schema", () => {
  const scenario = validateScenario(validScenario);
  assert.equal(scenario.version, 1);
  assert.deepEqual(scenario.clients, ["alice", "bob"]);
});

test("scenario validation rejects unknown keys and bad client references", () => {
  assert.throws(
    () => validateScenario({ ...validScenario, surprise: true }),
    (error) => error instanceof ScenarioValidationError && error.issues.some((issue) => issue.includes("surprise")),
  );
  assert.throws(
    () => validateScenario({ ...validScenario, steps: [{ action: { client: "mallory", operation: { type: "delete", path: ["title"] } } }] }),
    /configured client/,
  );
});

test("partitions must contain every client exactly once", () => {
  assert.throws(
    () => validateScenario({ ...validScenario, steps: [{ partition: { groups: [["alice"], ["alice"]] } }] }),
    /every client exactly once/,
  );
});

test("YAML scenarios load with source-relative context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synclab-scenario-"));
  const path = join(directory, "example.yml");
  await writeFile(path, `version: 1
name: yaml works
adapter: reference
clients: [alice]
initial: { title: hello }
steps:
  - assert: { type: equals, client: alice, path: [title], value: hello }
`, "utf8");
  const loaded = await loadScenario(path);
  assert.equal(loaded.scenario.name, "yaml works");
  assert.equal(loaded.baseDirectory, directory);
});
