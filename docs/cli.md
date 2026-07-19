# CLI reference

The npm package exposes the `synclab` executable. After installing or building the package, use `synclab`, `npx synclab`, or `node dist/cli.js` as appropriate for the environment.

```text
synclab init [file] [--adapter reference|yjs|automerge]
synclab validate <scenario> [--json]
synclab run <scenario> [options]
synclab replay <artifact> [options]
synclab minimize <artifact> [--output file]
synclab doctor [--json]
synclab adapter test <reference|yjs|automerge|module>
synclab adapters
```

Use `synclab help`, `synclab --help`, or `synclab -h` for the built-in summary. Use `synclab version`, `synclab --version`, or `synclab -v` for the package version.

## `init`

Create a starter YAML scenario.

```sh
synclab init
synclab init scenarios/offline.yml --adapter automerge
```

- The default target is `synclab.yml` in the current directory.
- The default adapter is `yjs`.
- The target's parent directories are created.
- The command refuses to overwrite an existing file.

The generated scenario uses three clients, a partition, independent edits, healing, settlement, convergence, and no-pending assertions.

## `validate`

Load and strictly validate a scenario without running it.

```sh
synclab validate synclab.yml
synclab validate synclab.yml --json
```

Pretty output reports the scenario name and counts of clients and steps. JSON output contains `valid`, absolute `path`, `name`, `clients`, and `steps` fields. See [Scenario reference](scenario-reference.md).

## `run`

Execute a scenario.

```sh
synclab run synclab.yml
synclab run synclab.yml --seed ci-184 --format json
synclab run synclab.yml --format junit --output reports/synclab.xml
```

Options:

| Option | Behavior |
| --- | --- |
| `--seed <value>` | Override the scenario seed. |
| `--format pretty\|json\|junit` | Select report output; default `pretty`. |
| `--artifact <file>` | Write the complete format-1 artifact to this path. |
| `--output <file>` | Write the rendered report to a file instead of stdout. Parent directories are created. |
| `--trace-values` | Include complete operation values and checkpoint client results in trace events. |

If a run is not `pass` and `--artifact` was not supplied, the CLI automatically writes an artifact under `.synclab/` using sanitized scenario-name and seed components. Passing runs only write an artifact when requested.

When pretty output is sent to stdout, the artifact path is printed to stdout. With another format or `--output`, the artifact note is written to stderr so it does not corrupt machine-readable output.

`--trace-values` is not a privacy switch for final state: all artifacts include final client snapshots and adapter metadata in their report.

## `replay`

Rerun a stored artifact with its scenario and seed, then compare the new trace fingerprint with the recorded fingerprint.

```sh
synclab replay .synclab/offline-ci-184.synclab.json
synclab replay artifact.json --format json
synclab replay artifact.json --allow-version-drift
```

Options:

| Option | Behavior |
| --- | --- |
| `--format pretty\|json\|junit` | Select replay report output; default `pretty`. |
| `--allow-version-drift` | Permit execution when the artifact's SyncLab version differs from the current version. |

Without version drift permission, a version mismatch is a harness error. With or without it, a different fingerprint prints `TRACE_DIVERGENCE` and exits 3.

A faithfully reproduced assertion failure exits 1 because its run status remains `fail`. In pretty mode, `replay: fingerprint matched` confirms that the failure was reproduced exactly.

Relative custom-adapter paths are resolved from the artifact's directory during replay.

## `minimize`

Remove top-level scenario steps while preserving the same first assertion-failure signature.

```sh
synclab minimize failure.synclab.json
synclab minimize failure.synclab.json --output failure.min.json
```

Only artifacts with report status `fail` and a failure signature can be minimized. Invalid, inconclusive, harness-error, and passing artifacts are rejected.

Without `--output`, the CLI inserts `.min` before the input extension. It writes a new artifact containing the original scenario, minimized scenario, and the minimized rerun. The current minimizer does not shrink nested repeated steps, operation values, initial data, clients, or fault settings.

## `doctor`

Run the implemented adapter conformance suite against all three built-ins.

```sh
synclab doctor
synclab doctor --json
```

Pretty output shows SyncLab, Node.js, platform, and a line for each adapter. JSON includes adapter versions and the three conformance scenario statuses. The command exits 3 if any built-in adapter fails.

## `adapter test`

Run the conformance suite against one built-in or custom module.

```sh
synclab adapter test reference
synclab adapter test ./dist/my-adapter.js
```

Custom module paths are resolved from the current working directory. The module must export an adapter factory as its default export or named `adapter` export. See [Adapter authoring](adapter-authoring.md).

The command exits 0 when all conformance scenarios pass and 3 otherwise.

## `adapters`

List built-in adapter names and versions as tab-separated lines:

```sh
synclab adapters
```

The current built-ins are `automerge` 3.3.2, `reference` 1, and `yjs` 13.6.31.

## Report formats

### Pretty

Human-readable status, scenario, seed, adapter, virtual time, processed events, queued messages, assertion lines, optional error/failure signature, and trace fingerprint.

### JSON

The complete `RunReport` with status, scenario, seed, timing and queue counters, assertion results, final client snapshots and hashes, optional failure/error fields, fingerprint, and environment versions.

### JUnit

One test case per reached assertion. Failed assertions become `<failure>` elements. An `invalid`, `inconclusive`, or `harness-error` run adds a harness test case with an `<error>` element. JUnit `time` is currently reported as `0` because SyncLab tracks virtual time separately.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Pass or successful informational command. |
| 1 | At least one scenario assertion failed. |
| 2 | Invalid input, invalid scenario, unknown command/option, or an artifact that cannot be minimized. |
| 3 | Harness, adapter, doctor, replay-version, or trace-divergence error. |
| 4 | A resource limit made the run inconclusive. |

Shell pipelines should use the exit code rather than parse pretty output. JSON and JUnit are intended for machine consumers.

## Sensitive output

JavaScript scenarios and adapter modules execute as trusted code. Reports and artifacts can include application state, metadata, errors, paths, and operation data. Review generated files before uploading them to CI artifacts or public issues. See [Security policy](../SECURITY.md).
