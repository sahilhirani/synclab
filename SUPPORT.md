# Support

SyncLab is maintained as an open-source project. Support is provided on a best-effort basis.

## Ask a usage question

Use [GitHub Discussions](https://github.com/sahilhirani/synclab/discussions) for setup questions, scenario design, adapter usage, and general ideas. Include the SyncLab version, Node.js version, operating system, adapter name and version, and a minimal scenario when relevant.

## Report a bug

Search the [issue tracker](https://github.com/sahilhirani/synclab/issues) before opening a report. A useful bug report includes:

- `synclab --version` and `node --version`;
- the operating system and architecture;
- the adapter and dependency version;
- the smallest scenario that reproduces the problem;
- the exact seed and command;
- expected and actual behavior; and
- sanitized pretty, JSON, or artifact output.

Artifacts contain final client state and metadata even without `--trace-values`. Do not attach an artifact until you have inspected it for secrets, personal data, and proprietary content.

## Request a feature or adapter

Open an issue describing the underlying synchronization problem, the proposed behavior, alternatives considered, compatibility impact, and a real example. New adapters should also explain their update format, durability model, restart/reset semantics, and how full-state anti-entropy works.

## Report a vulnerability or abuse

Vulnerabilities must follow [SECURITY.md](SECURITY.md). Community conduct reports must follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Do not disclose either category in a public support thread.
