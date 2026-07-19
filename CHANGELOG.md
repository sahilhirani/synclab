# Changelog

All notable changes to SyncLab are documented in this file. The project follows [Semantic Versioning](https://semver.org/) while recognizing that the public API may evolve during the `0.x` series.

## Unreleased

No unreleased changes are documented yet.

## 0.1.0 - 2026-07-19

### Added

- Format-1 scenarios loaded from YAML, JSON, or JavaScript modules with strict validation.
- Deterministic virtual network simulation with latency, drops, duplication, reordering, partitions, per-link overrides, ticks, and settlement.
- Scenario actions, parallel mutation batches, anti-entropy sync, restart, reset, clock skew, checkpoints, repeats, and six assertion types.
- Built-in reference, Yjs 13.6.31, and Automerge 3.3.2 adapters.
- A public adapter contract and three-scenario conformance command.
- Seeded decision streams, canonical JSON hashing, trace fingerprints, format-1 failure artifacts, replay, and top-level step minimization.
- Pretty, JSON, and JUnit reports with stable command exit-code categories.
- CLI commands for initialization, validation, execution, replay, minimization, diagnostics, and adapter discovery/testing.
- TypeScript API exports for scenarios, execution, artifacts, reports, canonicalization, conformance, adapters, and errors.
