import assert from "node:assert/strict";
import { test } from "node:test";
import { automergeAdapter } from "../src/adapters/automerge.js";
import { referenceAdapter } from "../src/adapters/reference.js";
import { yjsAdapter } from "../src/adapters/yjs.js";

const context = (clientId: string) => ({ clientId, now: 0, random: () => 0.5 });

for (const factory of [referenceAdapter, yjsAdapter, automergeAdapter]) {
  test(`${factory.name} ignores duplicate updates`, async () => {
    const adapter = await factory.create({ initial: { title: "before" }, seed: "duplicate", options: {} });
    const alice = await adapter.createClient("alice");
    const bob = await adapter.createClient("bob");
    const mutation = await alice.mutate({ type: "set", path: ["title"], value: "after" }, context("alice"));
    await bob.receive(mutation.update, context("bob"));
    await bob.receive(mutation.update, context("bob"));
    assert.deepEqual(await bob.snapshot(), { title: "after" });
    await adapter.dispose();
  });

  test(`${factory.name} changes replica identity after storage reset`, async () => {
    const adapter = await factory.create({ initial: { value: 0 }, seed: "identity", options: {} });
    const alice = await adapter.createClient("alice");
    const bob = await adapter.createClient("bob");
    const before = await alice.mutate({ type: "set", path: ["value"], value: 1 }, context("alice"));
    await bob.receive(before.update, context("bob"));
    await alice.reset();
    await alice.receive(await bob.exportState(), context("alice"));
    const after = await alice.mutate({ type: "set", path: ["value"], value: 2 }, context("alice"));
    assert.notEqual(after.operationId, before.operationId);
    await bob.receive(after.update, context("bob"));
    assert.deepEqual(await bob.snapshot(), { value: 2 });
    await adapter.dispose();
  });
}

test("Automerge buffers causally dependent changes delivered in reverse order", async () => {
  const adapter = await automergeAdapter.create({ initial: { title: "zero" }, seed: "causal", options: {} });
  const alice = await adapter.createClient("alice");
  const bob = await adapter.createClient("bob");
  const first = await alice.mutate({ type: "set", path: ["title"], value: "one" }, context("alice"));
  const second = await alice.mutate({ type: "set", path: ["title"], value: "two" }, context("alice"));
  await bob.receive(second.update, context("bob"));
  assert.equal(await bob.pending(), 1);
  assert.deepEqual(await bob.snapshot(), { title: "zero" });
  await bob.receive(first.update, context("bob"));
  assert.equal(await bob.pending(), 0);
  assert.deepEqual(await bob.snapshot(), { title: "two" });
  await adapter.dispose();
});

test("built-in adapters reject an invalid path atomically", async () => {
  for (const factory of [referenceAdapter, yjsAdapter, automergeAdapter]) {
    const adapter = await factory.create({ initial: { title: "safe" }, seed: "atomic", options: {} });
    const client = await adapter.createClient("alice");
    await assert.rejects(
      client.mutate({ type: "set", path: ["missing", "nested"], value: true }, context("alice")),
      /container|traverse|exist/i,
    );
    assert.deepEqual(await client.snapshot(), { title: "safe" });
    await adapter.dispose();
  }
});

test("built-in adapters reject invalid list ranges consistently and atomically", async () => {
  for (const factory of [referenceAdapter, yjsAdapter, automergeAdapter]) {
    const adapter = await factory.create({ initial: { items: [] }, seed: "range", options: {} });
    const client = await adapter.createClient("alice");
    await assert.rejects(
      client.mutate({ type: "list-insert", path: ["items"], index: 2, values: ["bad"] }, context("alice")),
      (error) => error instanceof Error && "code" in error && error.code === "PATH_RANGE",
    );
    assert.deepEqual(await client.snapshot(), { items: [] });
    await adapter.dispose();
  }
});
