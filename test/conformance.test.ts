import assert from "node:assert/strict";
import { test } from "node:test";
import { automergeAdapter, referenceAdapter, yjsAdapter } from "../src/adapters/index.js";
import { testAdapter } from "../src/core/conformance.js";

for (const adapter of [referenceAdapter, yjsAdapter, automergeAdapter]) {
  test(`${adapter.name} passes the public adapter conformance suite`, async () => {
    const result = await testAdapter(adapter);
    assert.equal(result.passed, true, JSON.stringify(result.reports, null, 2));
  });
}
