import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalStringify, hashValue, jsonEqual } from "../src/core/canonical.js";
import { DeterministicRandom } from "../src/core/random.js";

test("named random streams are deterministic and isolated", () => {
  const first = new DeterministicRandom("seed-42");
  const second = new DeterministicRandom("seed-42");
  const firstNetwork = [first.stream("network").next("a"), first.stream("network").next("b")];
  first.stream("unrelated").next("noise");
  const secondNetwork = [second.stream("network").next("a"), second.stream("network").next("b")];
  assert.deepEqual(firstNetwork, secondNetwork);
  assert.notEqual(first.stream("network").next("c"), first.stream("other").next("c"));
});

test("canonical JSON sorts keys and normalizes negative zero", () => {
  assert.equal(canonicalStringify({ z: -0, a: { y: 2, x: 1 } }), '{"a":{"x":1,"y":2},"z":0}');
  assert.equal(hashValue({ b: 2, a: 1 }), hashValue({ a: 1, b: 2 }));
  assert.equal(jsonEqual([1, { b: 2, a: 1 }], [1, { a: 1, b: 2 }]), true);
});

test("canonical JSON rejects cycles and non-finite numbers", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalStringify(cyclic), /cycles/);
  assert.throws(() => canonicalStringify({ value: Number.NaN }), /non-finite/);
});
