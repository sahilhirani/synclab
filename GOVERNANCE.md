# Governance

SyncLab uses a maintainer-led, contribution-friendly governance model. The project is small today; this document makes decision rights explicit as the community grows.

## Roles

### Contributors

Anyone who reports an issue, participates in design discussion, improves documentation, adds tests, or submits code is a contributor.

### Maintainers

Maintainers triage issues, review and merge changes, moderate community spaces, manage releases, and handle security reports. Sahil Hirani is the initial maintainer and release owner.

## Decisions

Routine fixes and documentation changes are decided through pull-request review. Material changes to the public TypeScript API, CLI behavior, scenario or artifact formats, deterministic scheduling, adapter contract, licensing, or governance should begin with a public issue unless disclosure would create a security risk.

Maintainers seek rough consensus, weighing correctness, reproducibility, compatibility, maintainability, and the needs of current users. Consensus does not require unanimity. When discussion does not converge, the maintainers make and document the decision. The release owner has the final decision while there is only one maintainer.

Security and conduct matters are handled privately under [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Becoming a maintainer

A contributor may be invited to become a maintainer after a sustained record of constructive participation, technically sound reviews or contributions, respect for the project's deterministic and compatibility contracts, and reliable adherence to the Code of Conduct. Existing maintainers decide invitations. The decision and the new maintainer's areas of responsibility are announced publicly.

Maintainers may step down at any time. Access may be removed for prolonged inactivity, security reasons, or Code of Conduct violations after an appropriate review.

## Releases

Releases follow semantic versioning as far as a `0.x` project permits. Maintainers review the diff, tests, package contents, changelog, and compatibility impact before publication. Only designated release maintainers may publish the npm package or create release tags.

The scenario schema, artifact schema, exported TypeScript API, adapter interface, CLI commands and exit codes, and machine-readable report fields are public contracts. Breaking changes to those contracts require explicit release notes and an appropriate version change.

## Changes to governance

Governance changes use the same public issue and pull-request process as other material changes. A change must explain the problem, expected community impact, and transition plan.
