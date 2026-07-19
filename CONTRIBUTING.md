# Contributing to SyncLab

Thank you for helping improve SyncLab. Contributions can include bug reports, scenario fixtures, adapter work, tests, documentation, and code.

By submitting a contribution, you agree that it is licensed under the [Apache License 2.0](LICENSE), the same license as the project. SyncLab does not currently require a separate contributor license agreement.

## Before opening a change

- Search the [issue tracker](https://github.com/sahilhirani/synclab/issues) for an existing report or proposal.
- Open an issue before substantial API, scenario-format, artifact-format, or adapter-contract changes.
- Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
- Keep unrelated behavior out of the same pull request.

## Development setup

SyncLab requires Node.js 22.14 or newer and uses the npm version recorded in `package.json`.

```sh
git clone https://github.com/sahilhirani/synclab.git
cd synclab
npm ci
npm run check
```

The main commands are:

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type-check source and tests without emitting files. |
| `npm test` | Run the Node test suite through `tsx`. |
| `npm run test:coverage` | Run tests with Node's experimental coverage report. |
| `npm run test:determinism` | Run the focused artifact and runner determinism tests. |
| `npm run test:examples` | Build the package and execute the checked-in examples. |
| `npm run build` | Compile ESM, declarations, declaration maps, and source maps into `dist/`. |
| `npm run check` | Type-check, run all tests, build, and execute the examples. |
| `npm run pack:check` | Show the npm tarball contents without publishing. |

Run `npm run check` before requesting review.

## Project layout

- `src/core/` contains validation, deterministic scheduling, assertions, tracing, artifacts, minimization, and reporters.
- `src/adapters/` contains the reference, Yjs, and Automerge adapters.
- `src/cli.ts` contains the command-line interface.
- `test/` contains automated tests.
- `docs/` contains the architecture and public contracts.

Read [the architecture](docs/architecture.md), [determinism contract](docs/determinism.md), and [adapter guide](docs/adapter-authoring.md) before changing those areas.

## Design rules

Deterministic behavior is part of SyncLab's product contract.

- Use the virtual clock and seeded `AdapterContext.random`; do not introduce `Date.now()`, `Math.random()`, timers, or uncontrolled concurrency into a run.
- Sort identifiers before iterating when insertion order could affect a trace, update, or report.
- Keep scenario and artifact changes backward-compatible unless an issue explicitly approves a format-version change.
- Do not silently accept unknown scenario keys. Validation errors should point to the failing field.
- Include a stable seed in every regression test for scheduler or adapter behavior.
- Avoid storing operation values in traces unless the caller opted into `traceValues`; final snapshots are already part of run reports and artifacts.
- Keep resource limits in place when adding loops, queues, payloads, or recursive scenario behavior.

## Tests

Bug fixes should include a test that fails before the fix. New scenario behavior should cover validation and execution. Adapter changes should cover restart, reset plus anti-entropy sync, duplicate delivery, and convergence where those semantics apply.

Custom adapters can be checked locally with:

```sh
npm run build
node dist/cli.js adapter test ./path/to/adapter.js
```

The conformance command exercises the currently implemented three-scenario suite; it is useful evidence, not a proof that an adapter is correct for every workload.

## Pull requests

Use a focused title such as `fix: preserve queued-message order` or `docs: clarify reset semantics`. In the body:

- describe the problem and chosen approach;
- link the relevant issue;
- identify public API, schema, determinism, or compatibility effects;
- include the commands and seeds used to test the change;
- update documentation when behavior changes; and
- confirm fixtures and artifacts contain no credentials or private application data.

Maintainers may ask for a change to be split, additional tests, or a design discussion before merge. Review decisions follow [GOVERNANCE.md](GOVERNANCE.md).
