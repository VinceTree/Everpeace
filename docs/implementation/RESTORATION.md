# Local source restoration

This checkout arrived without Git metadata, package manifests, lockfile, compiler or lint configuration. `baseline-manifest.json` records SHA-256 digests of the supplied source before restoration. The new Git history identifies a local baseline, not an upstream commit.

Dependency versions were recovered from `node_modules/.pnpm` directory identities and cross-checked against source imports. The root manifest, compiler settings, scripts and lint configuration are reconstructed. The node-pty repository patch is preserved. A newly resolved lockfile records the restored dependency graph; it is not claimed to be the missing original lockfile.

No model credentials or user settings are part of this snapshot.

Missing support files (documentation, benchmark catalogs/instrumentation, workflows, assets and license notices) were recovered without replacing existing local files from upstream commit `dce529cd4a9c9172de60b1f2165879d945d08095`. Their exact paths are recorded in `restored-support-files.json`. This support-file provenance does not assert that the supplied source matches that commit.

The initial restored check found 1 test typing error, 28 failing tests and 3 skipped tests among 1235 tests. Most failures referenced absent support files or the missing evaluator TypeScript alias. Lint passed. These results precede feature implementation.
