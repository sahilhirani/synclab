# Roadmap

SyncLab's roadmap is problem-led rather than date-led. Items below are intentions, not promises. Released behavior is documented in the code, [scenario reference](docs/scenario-reference.md), and [changelog](CHANGELOG.md).

## Current foundation: 0.1

The current implementation provides:

- a deterministic, in-process virtual network and clock;
- format-1 YAML, JSON, and JavaScript scenarios;
- reference, Yjs, and Automerge adapters;
- explicit operations, faults, lifecycle events, and invariants;
- failure artifacts, exact-version replay, and top-level step minimization; and
- pretty, JSON, and JUnit reporting through a CLI and TypeScript API.

## Near-term priorities

1. Expand regression coverage across Node.js versions and operating systems.
2. Exercise the built-in adapters with larger and more adversarial scenarios, including list and text conflicts.
3. Stabilize report and artifact compatibility rules and publish migration guidance before changing format 1.
4. Improve minimization beyond top-level step removal, while preserving the same failure signature.
5. Add more reusable, sanitized scenario examples based on real synchronization bugs.
6. Improve diagnostics for adapter failures and invalid paths without weakening strict validation.

## Toward 1.0

A 1.0 release should have:

- a documented compatibility policy for scenarios, artifacts, reports, and adapters;
- sustained cross-platform determinism tests;
- stable CLI commands and exit codes;
- confidence in built-in adapter restart, reset, duplicate-delivery, and anti-entropy behavior;
- a clear security and release process; and
- evidence from real projects that failure artifacts and replay are useful in CI and debugging.

## Ideas requiring design work

The following are candidates, not implemented features:

- recursive shrinking of repeated blocks, operations, and values;
- generated scenario/property exploration;
- additional adapter packages maintained with their upstream communities;
- browser-hosted execution or visualization; and
- richer machine-readable schemas and report integrations.

Open an issue before implementing a roadmap item so its scope, compatibility effect, and success criteria can be agreed first.
