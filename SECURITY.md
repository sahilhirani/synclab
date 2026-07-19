# Security policy

## Supported versions

SyncLab is currently in the `0.x` development series. Security fixes are made on the latest released minor line.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Earlier versions | No |

Once a newer minor is released, this table will be updated to state which prior line, if any, remains supported.

## Report a vulnerability privately

Please do not open a public issue, discussion, or pull request for a suspected vulnerability.

Use GitHub's [private vulnerability-reporting page](https://github.com/sahilhirani/synclab/security/advisories/new). Include:

- the affected SyncLab and Node.js versions;
- the affected command, API, adapter, or artifact path;
- a minimal reproduction or proof of concept;
- the security impact and required preconditions; and
- any suggested mitigation.

Remove credentials and personal data from reproductions. If GitHub private vulnerability reporting is unavailable, use [GitHub's private abuse and security contact form](https://support.github.com/contact/report-abuse), identify `sahilhirani/synclab`, and request private maintainer coordination.

Maintainers will acknowledge actionable reports on a best-effort basis, investigate privately, and coordinate disclosure and a release when a fix is available. Please allow time for a patch before publishing details.

## Security model and trust boundaries

SyncLab is a developer test harness, not a sandbox.

- JavaScript scenario modules (`.js`, `.mjs`, and `.cjs`) execute in the SyncLab Node.js process with the current user's permissions.
- Custom adapter modules execute arbitrary code with the same permissions.
- Only run scenarios and adapters from sources you trust.
- The simulated network is in-memory. The built-in harness does not isolate adapters or prevent them from using real network, file-system, or process APIs.
- YAML and JSON scenarios are treated as data, but their configured custom adapter modules still execute code.
- Failure artifacts always contain final client snapshots and adapter metadata. `--trace-values` additionally records complete operation values and checkpoint states. Treat artifacts as potentially sensitive and sanitize them before sharing.
- Replay verifies a deterministic trace fingerprint; it is not a signature and does not establish that an artifact came from a trusted author.
- Resource limits bound processed events, queued messages, payload size, and virtual time. They do not impose an operating-system memory, CPU, file, or network sandbox.

Supply-chain compromises, unsafe scenario or artifact parsing, path handling that escapes the user's intended files, denial-of-service behavior that bypasses configured limits, and unintended disclosure of scenario data are in scope for private security reports.

Questions about expected public behavior that have no security impact belong in the normal [support channels](SUPPORT.md).
