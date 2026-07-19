# Determinism and replay

SyncLab is designed to produce the same decisions, event order, final hashes, assertions, and trace fingerprint when the same scenario runs with the same seed, SyncLab version, adapter implementation, and relevant dependency/runtime behavior.

Determinism is an engineering contract with explicit boundaries; it is not a claim that arbitrary adapter code or different dependency versions behave identically.

## Seed selection

The runner chooses the first available value:

1. `RunOptions.seed` or CLI `--seed`;
2. `scenario.seed`; or
3. the default `"1"`.

Numbers and strings are normalized with `String(value)`. The artifact always stores a string seed.

## Random algorithm and streams

SyncLab 0.1 records the algorithm name `xorshift32-v1` in the run environment.

Each named random stream derives a non-zero 32-bit state from the seed and stream name. Network decisions use one stream per directed link, such as `network:alice->bob`. Adapter contexts use one stream per client, such as `adapter:alice`.

Every consumed draw records:

- stream name;
- stream-local sequence number;
- decision label; and
- numeric value.

Probabilities of zero and one return directly and do not consume draws. Changing a rate between those boundary values and a fractional value can therefore change later decisions in that stream.

## Virtual time

The network begins at virtual time zero. It never waits for wall-clock time.

- Sending calculates a virtual delivery timestamp.
- `tick` processes messages due through a target time and advances the clock by the requested interval.
- `settle` repeatedly advances to the next queued delivery.
- Client clock skew only changes `AdapterContext.now`; it does not alter delivery time.

Adapter code that uses wall-clock APIs or real timers steps outside this model.

## Stable ordering

The runner sorts client creation, state collection, broadcast recipients, and anti-entropy link pairs by client ID. The network orders queued messages by:

1. delivery timestamp;
2. queue insertion order; and
3. message ID.

A `parallel` block mutates clients in scenario order and delays all broadcasts until the mutations complete. It does not schedule uncontrolled concurrent promises.

Custom adapters must impose their own stable ordering when converting maps, sets, database results, or engine metadata to updates or JSON.

## Canonical values and hashes

SyncLab canonicalizes values before hashing:

- object keys are sorted;
- `-0` becomes `0`;
- `Uint8Array` becomes a base64 `$bytes` object;
- `Date` becomes an ISO `$date` object;
- bigint becomes a decimal `$bigint` object;
- `undefined` object fields are omitted; and
- cycles and unsupported values are rejected.

Hashes use SHA-256 over compact canonical JSON. `CANONICAL_FORMAT` is currently `1`.

Scenario values are stricter than the generic canonicalizer: they must already be ordinary JSON-compatible values.

## Trace fingerprint

Every trace event has a monotonically increasing sequence, a virtual timestamp, a type, and optional details. The final fingerprint hashes:

- the complete ordered event list;
- recorded random decisions;
- each final client state hash and metadata hash; and
- all assertion results.

The report environment is recorded for diagnosis but is not itself part of the fingerprint. It includes SyncLab, Node.js, platform, architecture, adapter, adapter version, scenario format, trace format, canonical format, and PRNG name.

An assertion failure also receives a separate failure signature based on the first failed assertion's ID, type, message, and details. Other non-passing statuses hash their status and error text. Minimization preserves the failure signature, not necessarily the original trace fingerprint.

## Artifacts

A format-1 artifact contains:

- the validated scenario and seed;
- the complete run report;
- all trace events;
- all random decisions; and
- optional original and minimized scenarios.

Final client snapshots and metadata are always in the report. Without `--trace-values`, operation details contain an operation type, path/name where relevant, and hash rather than the complete value, and checkpoints omit client states. With `--trace-values`, complete operations and checkpoint client results are included.

Artifacts can contain sensitive application data in either mode. Inspect and sanitize them before sharing.

Artifact reads are limited to 64 MiB. Writes use a temporary file in the target directory followed by rename.

## Replay

`replayArtifact` reruns the stored scenario with the stored seed and compares the new fingerprint with the recorded fingerprint.

By default, replay refuses an artifact whose recorded SyncLab version differs from the running version. The CLI flag `--allow-version-drift` bypasses that refusal, but it does not weaken fingerprint comparison. A different fingerprint remains `TRACE_DIVERGENCE` and CLI exit code 3.

Version permission and deterministic equality are separate questions:

- same version plus matching fingerprint: exact replay succeeded;
- same version plus different fingerprint: environment, adapter, or nondeterministic behavior changed;
- allowed version drift plus matching fingerprint: the change happened to preserve this trace; and
- allowed version drift plus different fingerprint: expected drift or a regression must be investigated.

Module adapter paths in an artifact remain scenario-relative data. The CLI resolves them from the artifact directory during replay. Moving an artifact without its relative adapter module can make replay fail.

A replayed invariant failure still exits with code 1 after its fingerprint matches, because the reproduced scenario status remains `fail`. The additional `replay: fingerprint matched` message distinguishes successful reproduction from a passing scenario.

## Minimization

The current minimizer operates only on artifacts with status `fail` and a failure signature. It uses delta-debugging-style removal of contiguous ranges of top-level steps, retaining a candidate only when it still fails with the same signature and seed.

It does not currently shrink:

- nested steps inside a retained `repeat`;
- operation values or paths;
- client lists, initial state, network settings, or limits; or
- assertion details.

The minimized run can have a different trace fingerprint and virtual schedule while representing the same first invariant failure.

## Sources of nondeterminism

Exact replay can be broken by:

- `Date.now()`, `Math.random()`, real timers, or unrecorded randomness in adapters;
- real network, filesystem, database, environment, locale, or process state;
- iteration over data with environment-dependent ordering;
- uncontrolled asynchronous work that outlives an adapter call;
- dependency or adapter version changes;
- JavaScript scenario modules with side effects; or
- an adapter's nondeterministic update encoding, snapshot, or metadata.

Use `AdapterContext.now` and `AdapterContext.random`, keep async work awaited, sort externally sourced values, pin dependencies for reproduction, and record meaningful adapter versions.

SyncLab does not promise equal fingerprints across different SyncLab, Node.js, adapter, or dependency versions. The recorded environment identifies the reproduction target.
