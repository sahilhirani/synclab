# Adapter authoring

Adapters connect SyncLab's generic scenarios to a synchronization engine. They run in-process and are trusted code. A custom adapter module must export an `AdapterFactory` as its default export or as a named `adapter` export.

## Select a module adapter

```yaml
adapter:
  module: ./adapters/my-adapter.js
  options:
    storageMode: memory
```

The module path is resolved relative to the scenario file. For `synclab adapter test`, a relative module path is resolved from the current working directory.

Adapter types are exported by the main package:

```ts
import type {
  AdapterClient,
  AdapterContext,
  AdapterCreateOptions,
  AdapterFactory,
  MutationResult,
  Operation,
  SyncAdapter,
} from "synclab";
```

## Factory lifecycle

An `AdapterFactory` has stable `name` and `version` strings and creates one run-scoped `SyncAdapter`:

```ts
interface AdapterFactory {
  readonly name: string;
  readonly version: string;
  create(options: AdapterCreateOptions): Promise<SyncAdapter>;
}
```

`AdapterCreateOptions` contains:

- `initial`: a cloned JSON object shared as the logical starting state;
- `seed`: the normalized string seed; and
- `options`: the JSON object from the module adapter spec, or `{}`.

The factory should not reuse mutable run state across calls.

## Run-scoped adapter

```ts
interface SyncAdapter {
  readonly name: string;
  readonly version: string;
  createClient(id: string): Promise<AdapterClient>;
  dispose(): Promise<void>;
}
```

SyncLab calls `createClient` once per configured ID, in sorted ID order. Each returned client must be isolated logically from other clients until it receives an update. `dispose` must release every resource owned by the run; it should be safe after partial setup.

The run report records the `SyncAdapter` name and version, not only the factory values. Keep them consistent.

## Client contract

```ts
interface AdapterClient {
  readonly id: string;
  mutate(operation: Operation, context: AdapterContext): Promise<MutationResult>;
  receive(update: Uint8Array, context: AdapterContext): Promise<void>;
  exportState(): Promise<Uint8Array>;
  snapshot(): Promise<JsonValue>;
  metadata(): Promise<JsonValue>;
  pending(): Promise<number>;
  restart(): Promise<void>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}
```

### `mutate`

Apply one generic operation locally and return:

```ts
interface MutationResult {
  update: Uint8Array;
  operationId: string;
  durability: "durable" | "memory" | "rejected";
}
```

The update is copied into one message per other client. `operationId` should be deterministic and useful in traces. A `rejected` result stops the run with an adapter error. The current runner records `durable` versus `memory` but does not otherwise enforce storage semantics.

The built-in operations are `set`, `delete`, `increment`, `list-insert`, `list-delete`, `text-insert`, `text-delete`, `merge`, and `custom`. A custom adapter may interpret named `custom` operations. It should reject unsupported operations explicitly.

### `receive`

Apply an update from another client. Network faults may deliver the same update twice, deliver updates out of order, or omit them entirely. A production-style adapter should make duplicate application safe according to its engine's semantics.

`receive` gets the target client's context at delivery time. It must not assume the sender's clock.

### `exportState`

Return a self-contained full-state or full-history update suitable for anti-entropy. SyncLab uses this method for `sync`, and automatically after `heal`, `restart`, or `reset` when resync is enabled.

The update may be sent to a client with no local state or to a client that already has every operation. Both cases should be safe.

### `snapshot`

Return the user-visible document as JSON-compatible data. SyncLab canonicalizes it for assertions, final reports, hashes, and artifacts. Do not include timestamps, process IDs, random IDs, map iteration artifacts, or other nondeterministic diagnostic data in the snapshot.

### `metadata`

Return JSON-compatible convergence metadata, such as state vectors, change heads, or an operation-set hash. `converged` compares metadata by default, so semantically equivalent replicas should return equal canonical metadata once fully synchronized.

Use `compareMetadata: false` in a scenario only when metadata equality is intentionally not part of that adapter's convergence definition.

### `pending`

Return a non-negative count of adapter-internal work that must complete before the client is quiescent. `no-pending` adds these counts to the virtual network queue length. The built-in adapters perform work synchronously and return zero.

### `restart`

Recreate volatile runtime state while retaining the adapter's durable local state. SyncLab may immediately enqueue bidirectional anti-entropy updates after this call. Do not silently restore from another client inside `restart`; the harness controls message flow.

### `reset`

Clear local state as if local storage were lost. The default scenario behavior then resyncs the client. A reset client must be able to accept `exportState` data from a peer.

### `dispose`

Release client resources. The run-scoped adapter also receives a final `dispose` call. Make cleanup idempotent where practical because failures can occur during setup or final state collection.

## Adapter context

```ts
interface AdapterContext {
  readonly clientId: string;
  readonly now: number;
  readonly random: () => number;
}
```

- `clientId` identifies the client receiving the call.
- `now` is virtual network time plus the client's configured clock skew.
- `random` reads from a deterministic per-client adapter stream and records the decision in the artifact.

Use this context instead of `Date.now()` or `Math.random()`. Avoid real timers, uncontrolled promises, network requests, filesystem state, environment-dependent ordering, and globally shared mutable state during a run.

## Update encoding

SyncLab treats updates as opaque bytes. The adapter owns encoding, versioning, and validation. Keep encoding deterministic for the same logical input. Reject malformed data clearly; a thrown receive error becomes a harness error unless it is one of SyncLab's classified invalid-operation errors.

Payloads larger than the scenario's `maxPayloadBytes` are rejected before queuing. A full-state update has the same limit as a delta.

## Conformance command

Build the project, then test a module:

```sh
npm run build
node dist/cli.js adapter test ./adapters/my-adapter.js
```

The same command accepts `reference`, `yjs`, or `automerge`. `synclab doctor` runs the suite for all built-in adapters.

The implemented conformance suite checks three cases:

1. convergence and no pending work after a three-way partition and heal;
2. duplicate/reordered delivery followed by restart; and
3. rebuilding a reset replica through full-state anti-entropy.

Passing is a baseline, not certification. Add adapter-specific tests for every supported operation, conflict type, update ordering, invalid update, restart boundary, and version migration.

## Built-in adapter behavior

| Adapter | Version | Notes |
| --- | --- | --- |
| `reference` | `1` | Replays a deterministic operation log ordered by virtual timestamp, actor ID, and sequence. It is a harness reference, not a production CRDT. |
| `yjs` | `13.6.31` | Uses Yjs updates and state vectors with garbage collection disabled. Strings in initial JSON become `Y.Text`. |
| `automerge` | `3.3.2` | Encodes Automerge changes as a JSON array of base64 changes and reports sorted heads as metadata. |

All three built-ins report durable mutations, return zero pending work, support the eight path-based operations, and reject `custom` operations.
