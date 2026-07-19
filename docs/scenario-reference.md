# Scenario reference

SyncLab scenario format 1 is a strict description of clients, initial state, network faults, operations, lifecycle events, and assertions. Unknown top-level, step, operation, assertion, network, limit, or adapter keys are rejected.

## File formats

The CLI accepts:

- `.yaml` and `.yml` files;
- `.json` files; and
- `.js`, `.mjs`, and `.cjs` modules.

YAML and JSON files are limited to 1,048,576 bytes. YAML merge keys are disabled and duplicate keys are rejected by the parser. A JavaScript module must export the scenario as its default export or as a named `scenario` export. JavaScript scenario modules execute as trusted code in the current Node.js process.

The TypeScript API can construct a scenario with `defineScenario`, which validates at runtime and preserves the input's inferred type.

## Complete example

```yaml
version: 1
name: offline edits converge after a partition
description: Three clients edit independently, reconnect, and must converge.
adapter: yjs
seed: demo-42
clients: [alice, bob, carol]
initial:
  title: Trip plan
  edits: {}
network:
  latencyMs: { min: 5, max: 40 }
  duplicateRate: 0.25
  reorderRate: 0.5
  reorderWindowMs: 25
steps:
  - partition:
      groups: [[alice], [bob], [carol]]
  - parallel:
      - client: alice
        operation: { type: set, path: [edits, alice], value: packed }
      - client: bob
        operation: { type: set, path: [edits, bob], value: booked }
      - client: carol
        operation: { type: set, path: [edits, carol], value: mapped }
  - heal: true
  - settle: true
  - assert: { id: SYNC002, type: converged }
  - assert: { id: SYNC009, type: no-pending }
```

## Top-level fields

| Field | Required | Type and rules | Default |
| --- | --- | --- | --- |
| `version` | Yes | Must be the number `1`. | None |
| `name` | Yes | Non-empty string, at most 200 characters. | None |
| `description` | No | String. | Omitted |
| `adapter` | Yes | `reference`, `yjs`, `automerge`, or a module spec. | None |
| `seed` | No | String or number; normalized to a string at run time. | `"1"` |
| `clients` | Yes | 1-100 unique client IDs. | None |
| `initial` | No | JSON object. | `{}` |
| `network` | No | Partial global network configuration. | Fault-free, zero latency |
| `limits` | No | Positive integer resource-limit overrides. | Built-in limits |
| `steps` | Yes | Non-empty array of supported steps. | None |

Client IDs must match `[A-Za-z][A-Za-z0-9_-]{0,63}`.

Scenario JSON values may contain only null, booleans, finite numbers, strings, arrays, and objects. Cycles, `undefined`, functions, symbols, bigint values, and non-finite numbers are invalid scenario values.

## Adapter selection

Built-in adapters use a string:

```yaml
adapter: automerge
```

A custom adapter uses a module spec:

```yaml
adapter:
  module: ./adapters/my-adapter.js
  options:
    storageMode: memory
```

Relative module paths are resolved from the scenario file's directory. The module must export an `AdapterFactory` as its default export or named `adapter` export. `options` must be a JSON object and is passed unchanged to the factory.

## Paths

Operation and assertion paths are arrays of string object keys and non-negative safe-integer array indexes:

```yaml
path: [boards, 0, title]
```

Operation paths cannot be empty and cannot target the document root. The `equals` and `not-equals` assertions may omit `path` to compare the complete snapshot.

Path containers must already exist. A `set` operation can add an object property, but it does not create missing parent objects or arrays. Adapter-specific type and range checks may be stricter.

## Network configuration

The top-level `network` object sets global defaults. A `network` step changes the current global configuration or one directed link.

| Field | Type | Default | Behavior |
| --- | --- | --- | --- |
| `latencyMs` | Non-negative number or `{ min, max }` | `0` | Fixed or seeded integer delivery latency. Range values must have `max >= min`. |
| `dropRate` | Number from 0 to 1 | `0` | Probability that a sent update is discarded. |
| `duplicateRate` | Number from 0 to 1 | `0` | Probability that exactly one extra copy is queued. |
| `reorderRate` | Number from 0 to 1 | `0` | Probability of adding a seeded reorder delay. |
| `reorderWindowMs` | Non-negative number | `0` | Inclusive maximum added reorder delay. |

Probability decisions at exactly `0` or `1` do not consume a random draw. A link override requires both `from` and `to` and is directional:

```yaml
- network:
    from: alice
    to: bob
    dropRate: 1
```

Configuration changes merge with the link's current configuration or the current global configuration; omitted fields retain their prior value.

## Resource limits

| Field | Default | Limit enforced |
| --- | ---: | --- |
| `maxEvents` | 100,000 | Total delivered network events in a run. |
| `maxQueuedMessages` | 25,000 | Messages simultaneously held in the virtual queue. |
| `maxPayloadBytes` | 8,388,608 | Size of one adapter update. |
| `maxVirtualTimeMs` | 86,400,000 | Maximum virtual timestamp. |

Overrides must be positive safe integers. Reaching a limit produces an `inconclusive` report and CLI exit code 4.

## Operations

Every operation is an object with a `type`.

| Type | Fields | Meaning |
| --- | --- | --- |
| `set` | `path`, `value` | Replace an existing array element or set an object property. |
| `delete` | `path` | Delete an object property or array element. |
| `increment` | `path`, optional `by` | Add `by`, defaulting to `1`, to a numeric value. |
| `list-insert` | `path`, `index`, `values` | Insert JSON values into a list. The index may equal the list length. |
| `list-delete` | `path`, `index`, optional `count` | Delete list entries; `count` defaults to `1`. |
| `text-insert` | `path`, `index`, `text` | Insert text at a character index. |
| `text-delete` | `path`, `index`, `count` | Delete a positive number of characters. |
| `merge` | `path`, `value` | Set each property from a JSON object on an existing object/map. |
| `custom` | `name`, optional `input` | Delegate an adapter-defined operation. |

All built-in adapters reject `custom` operations. Custom adapters decide their supported custom names and inputs.

The operation schema validates general shapes and non-negative indexes. Actual container types, path existence, and detailed range validity are checked when the adapter executes the operation. Such errors produce an `invalid` run.

## Steps

Every step object must contain exactly one supported step key.

### `action`

Mutate one client and broadcast the returned update to every other client:

```yaml
- action:
    client: alice
    operation: { type: increment, path: [count], by: 2 }
```

Broadcasting queues updates; it does not deliver them until `tick` or `settle`.

### `parallel`

Apply a non-empty batch of client operations before broadcasting any result:

```yaml
- parallel:
    - client: alice
      operation: { type: set, path: [votes, alice], value: yes }
    - client: bob
      operation: { type: set, path: [votes, bob], value: no }
```

Mutations and later broadcasts use listed order. This is deterministic batching, not worker-thread execution.

### `partition`

Replace the current partition with groups that contain every configured client exactly once:

```yaml
- partition:
    groups: [[alice, bob], [carol]]
```

Traffic within a group remains possible; traffic between groups is blocked in both directions. Updates sent while blocked are not queued. Updates already queued are dropped if the link is still blocked at delivery.

### `heal`

Heal all links and request full-state sync:

```yaml
- heal: true
```

Or heal every blocked link incident to selected clients and sync those clients bidirectionally with all clients:

```yaml
- heal: { clients: [bob] }
```

Healing enqueues sync updates but does not settle them.

### `network`

Merge a global or directed-link network configuration. See [Network configuration](#network-configuration).

### `tick`

Process queued messages due during a non-negative virtual-time interval:

```yaml
- tick: 100
- tick: { ms: 50 }
```

After processing due messages, virtual time advances by the requested amount.

### `settle`

Deliver queued messages until the queue is empty:

```yaml
- settle: true
- settle: { maxEvents: 500 }
```

The optional positive `maxEvents` is a per-settlement bound; the run-wide event limit still applies.

### `sync`

Export and exchange full adapter state:

```yaml
- sync: true
- sync: { clients: [alice, bob] }
```

With selected clients, SyncLab sends their state to every other client and every other client's state back to them. Without a selection, it sends every client's state to every other client. The resulting messages still follow current faults and require delivery.

### `restart`

Ask an adapter client to restart while retaining its durable state:

```yaml
- restart: bob
- restart: { client: bob, resync: false }
```

`resync` defaults to `true`, which requests bidirectional full-state sync for that client after restart.

### `reset`

Ask an adapter client to clear local state:

```yaml
- reset: bob
- reset: { client: bob, resync: false }
```

`resync` defaults to `true`. Recovery depends on peers and adapter anti-entropy semantics; the harness does not restore `initial` directly after reset.

### `clock`

Set one client's adapter-clock skew in milliseconds:

```yaml
- clock: { client: alice, skewMs: 30000 }
```

Skew may be negative. It changes `AdapterContext.now` for that client; it does not change virtual network time. The built-in reference adapter uses this timestamp for operation ordering. The Yjs and Automerge adapters do not currently use it.

### `checkpoint`

Emit a named trace event:

```yaml
- checkpoint: after-heal
```

With API option `traceValues: true` or CLI flag `--trace-values`, the checkpoint also contains every current client result. Otherwise it contains only the name and virtual timestamp.

### `repeat`

Run a non-empty nested step list 1-10,000 times:

```yaml
- repeat:
    times: 3
    steps:
      - action:
          client: alice
          operation: { type: increment, path: [count] }
```

Nested repeats are valid and remain subject to run resource limits.

### `assert`

Evaluate one assertion. A failed assertion marks the run `fail`, records a failure signature, and execution continues to later steps.

## Assertions

Every assertion accepts an optional string `id`. Without one, SyncLab derives an ID from the step position.

| Type | Fields | Pass condition |
| --- | --- | --- |
| `converged` | Optional `clients`, optional `compareMetadata` | Selected canonical snapshots match and, by default, metadata hashes match. `compareMetadata` defaults to `true`. |
| `equals` | `client`, optional `path`, `value` | Selected value equals expected canonical JSON. Omit `path` for the whole snapshot. |
| `not-equals` | `client`, optional `path`, `value` | Selected value does not equal expected canonical JSON. |
| `all-equal` | `path`, `value`, optional `clients` | Every selected client has the given expected value at the path. |
| `contains` | `client`, `path`, `value` | A string contains a string, an array contains an equal value, or an object contains every expected object property/value. |
| `length` | `client`, `path`, non-negative integer `value` | String/array length or object key count equals `value`. |
| `no-pending` | None | Network queue plus every adapter client's `pending()` count is zero. |

`clients`, when present, must be a non-empty list of configured IDs. `no-pending` checks adapter-reported internal work but cannot detect work an adapter does not report.

## Status behavior

Validation failures and invalid supported operations produce `invalid`. Resource-limit failures produce `inconclusive`. Assertion failures produce `fail`. Unexpected adapter or harness errors produce `harness-error`. See [CLI exit codes](cli.md#exit-codes) and [Architecture](architecture.md#status-and-error-model).
