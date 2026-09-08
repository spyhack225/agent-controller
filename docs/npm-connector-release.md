# Protected npm connector release

`.github/workflows/npm-connector-release.yml` is the only repository automation authorized to
publish `@agent-controller/connector`. It is manual-only, publishes one exact stable version from
one annotated `connector-vVERSION` tag, and enters the protected `npm-release` GitHub environment
before receiving `id-token: write`. It never reads an npm token.

The workflow exists, but no publication has been executed or verified from this checkout.

## One-time setup outside the repository

Before the first release:

1. The maintainer must choose the repository/package license. Add the approved license text as the
   root `LICENSE` and `packages/connector/LICENSE`, replace the connector manifest's current
   `"license": "UNLICENSED"` with the corresponding license identifier, and add `LICENSE` to its
   `files` allowlist. The release helper deliberately refuses an unresolved license or a tarball
   without that file; automation must not infer this legal decision.
2. Commit `repository` metadata in `packages/connector/package.json` whose `url` exactly names the
   public GitHub repository and whose `directory` is `packages/connector`. The workflow derives the
   expected URL from `GITHUB_SERVER_URL` and `GITHUB_REPOSITORY`; it will not generate or rewrite
   package metadata after checkout. The current manifest has no authoritative repository URL, so
   validation remains intentionally blocked until the maintainer supplies the real one.
3. In npm package settings, configure a GitHub Actions trusted publisher for the exact repository,
   workflow filename `npm-connector-release.yml`, environment `npm-release`, and the `npm publish`
   action. Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or an npm auth token to GitHub.
4. Configure the GitHub `npm-release` environment with required reviewers, prevent self-review and
   administrator bypass, and restrict deployment to the default branch. Protect
   `connector-v*` tags against update and deletion.
5. After trusted publishing works, disable token-based publishing for the npm package and revoke old
   automation tokens. Keep interactive npm owner recovery separate from Actions.

npm trusted publishing currently requires GitHub-hosted runners, Node 22.14 or newer, and npm
11.5.1 or newer. The workflow pins Node 22.21.1 and npm 11.5.1 and gives OIDC permission only to the
publication job. Trusted publishing automatically creates provenance for a public package in a
public repository; the workflow also passes `--provenance` so disabling it is never accidental. See
the official [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[provenance](https://docs.npmjs.com/generating-provenance-statements/) documentation.

The first package registration and trusted-publisher association are npm account operations. If npm
does not allow the trusted publisher to be attached before the first version exists, an npm owner
must perform a separately reviewed bootstrap under npm's current policy. Do not add a long-lived
token to this workflow as a shortcut.

## Candidate preparation

1. Fix every failing merge and release gate, especially `npm run security:repo`.
2. Set one new stable version in `packages/connector/package.json`. Versions with a prerelease suffix
   are intentionally refused by this workflow.
3. Ensure the candidate is on the default branch, then create an annotated, protected tag that
   matches the version exactly:

   ```bash
   git tag -a connector-v0.1.0 TARGET_COMMIT -m 'Connector 0.1.0'
   git push origin connector-v0.1.0
   ```

   A signed annotated tag is preferable once the repository has an explicit trusted signer policy.
   The current workflow proves that the tag is annotated and resolves to the authorized commit; it
   does not claim signature verification without a configured trusted-key set.
4. Run the local gates without registry mutation:

   ```bash
   npm run security:repo
   npm run test:connector
   npm run pack:connector
   npm run test:npm-connector-release
   ```

The protected helper additionally enforces the exact package name, version, executable, Node engine,
public publish configuration, selected license and packaged `LICENSE`, repository identity,
dependency-free manifest, absence of publication lifecycle scripts, a 64-file/1 MiB compressed/2 MiB
unpacked bound, and the `bin`/`src`/README/LICENSE allowlist. It runs connector tests, packs,
installs with scripts disabled in a clean temporary directory, exercises the installed CLI, and runs
`npm publish --dry-run`.

## Authorization and publication

Dispatch **npm connector release** from the default branch with:

- `version`: exact `X.Y.Z` from the package manifest;
- `release_tag`: exact `connector-vX.Y.Z` annotated tag;
- `target_commit_sha`: exact lowercase 40-character tagged commit;
- `confirmation`: `publish:@agent-controller/connector@X.Y.Z:TAG:COMMIT`.

The credential-free verification job checks the default-branch ancestry, tag object and target,
authorization, repository secret gate, package tests, clean install, contents, and npm dry-run, then
uploads the exact tarball plus its hash-bound evidence for one day. The publication job downloads
and revalidates that artifact after environment approval; it does not execute candidate tests,
install the candidate, or run the candidate CLI while OIDC is available. It then makes one public
registry read: an existing name/version is an immutable refusal; a registry outage or ambiguous
error also fails closed.

The publication command uses the exact tested tarball, public access, the `latest` dist-tag, disabled
package scripts, OIDC trusted publishing, and provenance. It writes a redacted one-day publication
checkpoint. A separate credential-free job—with no `id-token` permission—then performs bounded
registry-propagation retry, digest comparison, and `npm exec` of the exact version from a fresh
directory and cache. This is clean external package evidence, not macOS/Linux/Windows service,
native credential-store, live T3, or sleep/reconnect proof.

The uploaded JSON evidence contains only the package/version, release tag, source and automation
commits, tarball filename and hashes, sizes/count, named check results, and the registry integrity
projection. It deliberately excludes actor details, npm output, registry URLs, maintainer contacts,
tokens, paths, connector state, and provider/user data. If publication succeeds but later
verification fails, inspect npm before doing anything else; never retry the same version blindly.

## Rollback, deprecation, and removal limits

npm versions are immutable. Even an unpublished name/version cannot be reused. This workflow does
not run `npm unpublish`, `npm deprecate`, or `npm dist-tag`, because trusted-publishing OIDC is scoped
to publish and those mutations have different npm authority and incident semantics. See npm's
[publish immutability contract](https://docs.npmjs.com/cli/commands/npm-publish/).

- Correct a bad package by publishing a new version. Do not rebuild the old version.
- Connector hosts can explicitly select a previously published exact version with the existing
  local `update --apply --version VERSION` flow. The cloud never invokes that command remotely.
- Moving `latest`, deprecating a bad version, or an exceptional unpublish is a separately authorized
  npm-owner incident action. Record the actor, reason, affected versions, registry result, and user
  communication outside this workflow without copying tokens or private npm output into the repo.
- npm has no general-purpose reversible “yank” in this workflow. Unpublish eligibility is governed by
  npm's current policy, and removal still does not restore the version for reuse.

Publication is one artifact gate, not rollout completion. Start with an internal connector cohort,
observe exact version and health, and follow [release-rollouts.md](release-rollouts.md).
