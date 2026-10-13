# Contributing

[简体中文](CONTRIBUTING.zh-CN.md) · [FAQ](docs/FAQ.md) · [Interface compatibility](docs/COMPATIBILITY.md)

Start with a small, reproducible issue. Security vulnerabilities belong in the [private reporting channel](SECURITY.md). Public issues should contain a minimal disposable fixture, exact commit/package identifier, OS, expected behavior, and a redacted diagnostic summary. Never include credentials or a complete Session.

For source development, install Node **22.19+**, Git, and **pnpm 10.30.3**. Consumer package installation is a separate delivery gate; see [installation status](docs/INSTALLATION.md).

```sh
git clone https://github.com/VinceTree/Everpeace.git
cd Everpeace
pnpm install --frozen-lockfile
pnpm install:verify
node --import tsx --test tests/unit/cli/args.test.ts
```

Find the relevant module before expanding your change:

| Directory | Responsibility |
| --- | --- |
| `src/cli`, `src/sdk`, `contracts` | Public entry points, JSONL and error identifiers |
| `src/runtime`, `src/agent`, `src/workflow` | Lifecycle, model loop and host verification |
| `src/projects` | Read-only project recognition and check discovery |
| `src/tui`, `src/localization`, `src/status` | Interaction, host copy and status projections |
| `src/storage`, `src/memory` | Persistence, privacy and experience |
| `src/tools`, `src/permissions`, `src/team` | Protected operations and resource ownership |
| `tests/unit`, `tests/fixtures` | Targeted regressions and independent consumer fixtures |
| `scripts/release`, `scripts/security` | Artifact and safety gates |

A small fix might correct a display label in the two localization catalogs, run `pnpm ui:verify`, and run the corresponding TUI test. A behavioral fix should reproduce the trigger with a meaningful regression, preserve unrelated files and user edits, and describe the resulting behavior in its PR. Tests involving processes, files or Session data must use owned disposable directories; paid model calls are never part of ordinary tests.

Before submitting, run these commands in order, stopping on failure:

```sh
pnpm typecheck
pnpm lint
pnpm ui:verify
pnpm docs:verify
pnpm test
pnpm build
pnpm install:smoke
git diff --check
```

Both Windows and Linux hosted checks must pass. Skips remain uncovered; hosted checks do not replace the dedicated Windows native gate. Public consumer fixtures are frozen: do not update them together with implementation to hide a compatibility break. New host messages belong in both catalogs with matching interpolation parameters. See [terminal acceptance](docs/TERMINAL_ACCEPTANCE.md) for manual coverage that automation cannot establish.

PR descriptions should state the concrete trigger, resulting behavior, validation and remaining limits. Keep machine-specific paths and raw logs in ignored `.cache/private-evidence/`; public documentation uses relative paths, reproducible commands, commits and digest summaries. Historical commits and tags are not rewritten by current-document cleanup.
