# Architecture

This document describes the implemented SyncLab 0.1 architecture. SyncLab is an in-process TypeScript test harness: it loads a scenario, creates simulated clients through an adapter, routes their updates through a deterministic virtual network, evaluates assertions, and returns a report plus a replay artifact.

## Components

| Component | Responsibility |
| --- | --- |
| Scenario loader and validator | Load YAML, JSON, or JavaScript modules and reject unknown or invalid fields before execution. |
| Runner | Create clients, interpret steps in order, track status, and assemble the final report and artifact. |
| Deterministic random streams | Make network and adapter random decisions from a string seed and record each draw. |
| Simulated network | Queue in-memory updates with virtual latency, drops, duplication, reordering, and partitions. |
| Adapter | Translate generic operations into a synchronization engine and expose snapshots, metadata, and full-state updates. |
| Assertions | Compare canonical client state, metadata, expected values, lengths, containment, and pending work. |
| Trace recorder | Record ordered virtual-time events and calculate a trace fingerprint. |
| Artifact utilities | Read and atomically write format-1 artifacts, replay them, and remove top-level steps while preserving a failure signature. |
| Reporters | Render a `RunReport` as pretty text, JSON, or JUnit XML and map status to an exit code. |

The public ESM entry point exports the built-in adapters, scenario functions, runner, artifact functions, reporters, canonicalization helpers, conformance function, errors, version, and core TypeScript types.

## Execution flow

`runScenario` performs these stages:

1. Validate and clone the scenario.
2. Select the seed from `RunOptions.seed`, then `scenario.seed`, then the default string `"1"`.
3. Merge scenario resource limits over the built-in defaults.
4. Resolve a built-in or module adapter and call its factory with the initial JSON object, normalized string seed, and adapter options.
5. Create clients in sorted client-ID order.
6. Construct the virtual network at time zero.
7. Execute scenario steps in listed order, recursively interpreting repeated blocks.
8. Evaluate assertions when their steps are reached. A failed assertion changes the run status to `fail` but does not stop later steps.
9. Catch validation, resource, adapter, and unexpected errors and classify the run status.
10. Collect canonical final state and metadata from every created client.
11. Record `run.completed`, calculate the failure signature and trace fingerprint, and build the environment block.
12. Dispose the adapter and return a format-1 `FailureArtifact`, even for a passing run.

All adapter and network work occurs in the caller's Node.js process. There are no worker threads, child processes, real sockets, or operating-system sandboxes in the harness.

## Step ordering and concurrency

Normal `action` steps call one client's `mutate` method and then enqueue the resulting update for every other client.

A `parallel` step is a deterministic mutation batch rather than JavaScript-level parallelism. SyncLab invokes each mutation in listed order without broadcasting any result. After every mutation has completed, it broadcasts the results in the same listed order. This prevents one action in the batch from receiving another action's update before its own mutation.

Queued messages are delivered only when virtual time is advanced or the network is settled. Even zero-latency messages remain queued until a `tick` or `settle` step processes them. An explicit `sync` or automatic sync after `heal`, `restart`, or `reset` also enqueues updates; it does not settle the queue.

## Virtual network

The network stores an ordered queue of byte payloads. Each directed link uses either the current global configuration or a link-specific override. Sending an update:

1. rejects payloads larger than `maxPayloadBytes`;
2. drops it immediately if the link is partitioned;
3. makes a seeded drop decision;
4. makes a seeded duplication decision;
5. chooses seeded latency and optional reorder delay for each copy; and
6. queues the copies, enforcing `maxQueuedMessages`.

The queue is ordered by delivery time, insertion order, then message ID. If a link becomes partitioned after a message is queued but before delivery, the message is dropped at delivery time.

`tick` processes messages due through the target virtual time. `settle` repeatedly advances to the next delivery until the queue is empty or an event limit is reached.

## Adapter boundary

An adapter factory creates one `SyncAdapter` per run. That adapter creates one `AdapterClient` per scenario client. Generic operations cross into the adapter through `mutate`; adapter-specific byte updates cross the network and return through `receive`.

`exportState` supplies a full-state or full-history update for anti-entropy sync. `snapshot` supplies user-visible JSON for assertions. `metadata` supplies adapter-specific convergence evidence. By default, the `converged` assertion requires both snapshot and metadata hashes to match.

`restart` asks a client to recreate its runtime while retaining durable state. `reset` asks it to clear local state. Both steps resync by default. The harness cannot verify an adapter's storage claims directly; adapter behavior and conformance tests provide the evidence.

See [Adapter authoring](adapter-authoring.md) for the full contract.

## Canonical data and traces

Client snapshots, metadata, assertion details, and trace fingerprint inputs are converted to canonical JSON. Object keys are sorted, negative zero becomes zero, byte arrays become base64-tagged objects, and unsupported values or cycles are rejected.

A trace event has a sequence number, virtual timestamp, type, and optional client, message, and JSON details. The fingerprint hashes:

- all trace events;
- all recorded random decisions;
- final client state and metadata hashes; and
- assertion results.

The environment block separately records the SyncLab, Node.js, adapter, scenario-format, trace-format, canonical-format, platform, architecture, and PRNG versions.

## Status and error model

| Status | Meaning |
| --- | --- |
| `pass` | Execution completed and every reached assertion passed. |
| `fail` | At least one reached assertion failed. |
| `invalid` | Scenario data or a supported operation/time/network path was invalid. |
| `inconclusive` | A configured resource limit was reached. |
| `harness-error` | Adapter resolution, adapter execution, replay, collection, disposal, or another unexpected harness operation failed. |

The first failed assertion determines an invariant failure signature. For other non-passing statuses, the signature hashes the status and error text. The minimizer only operates on `fail` artifacts with a failure signature.

## Trust boundaries and non-goals

SyncLab does not sandbox JavaScript scenarios or custom adapters. They have the same file, network, environment, and process access as the CLI. The virtual network only controls updates that adapters return to the harness; it cannot intercept real I/O performed by adapter code.

SyncLab also does not prove a CRDT or sync engine correct. It deterministically executes the scenarios supplied to it. Adapter conformance covers three implemented workflows, not every conflict or persistence behavior.

See [Determinism](determinism.md) and [Security policy](../SECURITY.md) for the exact guarantees and boundaries.
