# CI and release gates

`.github/workflows/ci.yml` is the repository's credential-free pull-request and push gate. It runs
on GitHub-hosted Ubuntu with read-only repository permission, does not persist the checkout token,
and pins the two GitHub-maintained actions by full commit SHA.

The jobs are deliberately split at the repository's runtime boundaries:

| Job | Locked input | Command evidence |
| --- | --- | --- |
| Repository integrity gates | Git tracked files plus maintained first-party Markdown | `npm run security:repo` and the Git-independent `npm run check:docs` relative-link check |
| Firmware contracts | `firmware/build-matrix.json` plus board manifests/examples/source | complete 15-environment manifest, one pinned toolchain, secure release selection, placeholder-only isolated-build inputs, and shared TLS boundary tests |
| Console | root `package-lock.json` | production build, explicit manifest-based bundle/chunk budget, TypeScript check, and frontend Vitest suite |
| Node gateway, Convex, and workflow contracts | root `package-lock.json` | Convex TypeScript, `npm run test:server`, and the explicit `npm run test:workflow` CI/release/staging-qualification safety suite |
| Cloudflare edge | `cloudflare/package-lock.json` | Worker/DO typecheck plus contract, runtime, and resilience suites |
| Private control plane | `cloudflare-control-plane/package-lock.json` | Worker/Container boundary typecheck and tests |
| Connector | dependency-free package source | connector lifecycle/resilience tests plus tarball pack/install smoke |
| Private Container | digest-pinned Docker base and runtime lockfile | `linux/amd64` build, release-policy checks, non-root runtime, public/private route separation, health, and graceful stop |

Each dependency-bearing job uses `npm ci` against its own lockfile. npm's download cache is shared
only through `actions/setup-node`; `node_modules` is never restored from a cache. The connector has
no runtime or development dependencies, so its tests and package smoke run directly from source.
The documentation gate covers first-party root docs, `docs/`, `roadmap/`, the connector and cloud
READMEs, and the shallow board/shared READMEs. It deliberately excludes downloaded firmware vendor
documentation and dependency trees. It verifies local file targets without network requests or a
Git-index dependency; external URL availability and heading-fragment spelling remain review-time
checks.

The workflow-contract command intentionally overlaps the full server glob: its separate invocation
makes the release and staging qualification safety boundary visible as a named required step instead
of relying on an incidental test-file count.

## What CI does not prove

The workflow never deploys, publishes, reads repository or environment secrets, calls a live T3
environment, or operates hardware. It also does not run the local capacity harness as a merge gate:
latency and resource ceilings on a contended GitHub-hosted runner would not prove the beta SLO and
could produce noisy failures. Run `npm run test:capacity` on a controlled machine, then run the
staging matrix in [capacity-slo.md](capacity-slo.md).

These remain explicit release evidence outside this workflow:

- Cloudflare/Convex/R2/Queue deployment, migration, rollback, and hosted capacity evidence.
- A clean external `npm exec` installation and signed/provenance-backed connector publication.
- Live browser/controller -> cloud -> connector -> T3/provider journeys, including WAN loss and
  sleep/wake recovery.
- PlatformIO compilation, production-certificate refusal tests, and physical hardware behavior. CI
  statically validates the complete matrix and release security; `npm run build:firmware:all` is
  the separate local compile gate.
- Browser GPU/render profiling, real-stream long-session heap behavior, and on-device frame or
  refresh measurements. CI does enforce the deterministic bundle/list/coalescing contracts in
  [frontend-performance-gate.md](frontend-performance-gate.md).

The Container job is included because its existing smoke is credential-free and self-cleaning on a
GitHub-hosted Linux Docker daemon. It is still local image evidence, not proof that a Cloudflare
Container deployed or received a private Service Binding request.

## Required-check policy

Protect the release branch with every named job in `Hermetic CI`; do not use a passing subset as a
release signal. The repository-secret job is expected to fail while a forbidden tracked file or
high-confidence credential signature remains. Do not bypass it to publish an artifact.

External deploy and publication workflows should remain separate, environment-protected workflows
with explicit operator authorization. They must consume a commit that passed this workflow rather
than combining untrusted pull-request execution with production credentials.
Their credential-free candidate jobs repeat both `npm run security:repo` and `npm run check:docs`
against the exact release checkout before any protected environment is entered.

The manual-only [`npm connector release`](npm-connector-release.md) workflow implements the npm
boundary. Its credential-free job binds an annotated connector tag, exact version, exact commit,
package identity, clean-installed tarball, and npm dry-run. Only its `npm-release` environment job
receives `id-token: write`; it uses npm trusted publishing without a long-lived token, refuses an
already published immutable version, and is designed to verify the published digest plus a clean
external exact-version `npm exec`. The workflow has not been executed and does not count as npm or
clean-host evidence until that protected run succeeds.

The manual-only [`Staging bootstrap`](staging-bootstrap.md) and
[`Staging release`](staging-release.md) workflows implement that separation with different protected
environments and authority. Bootstrap creates the exact first-time resources, provisions named
secrets over standard input, and resolves reciprocal bindings through a non-public fail-closed stub.
Release re-runs the pinned candidate gates before the protected `staging` environment exposes any
credential, requires exact current Worker versions to prevent a stale overwrite, deploys Convex ->
private Container -> edge, and supports an explicit compatible rollback in edge -> private-Container
order. Neither runs on push/PR or constitutes hosted proof until an authorized run succeeds and its
redacted evidence is reviewed.

The manual-only [`Production promotion`](production-promotion.md) workflow is a further, separate
boundary. It consumes one exact staging-qualified commit plus a hash-locked, at-most-72-hour bundle
of release, qualification, hosted-capacity, and security evidence. Four independent `production`
environment approvals surround read-only preflight, Convex/private-Container promotion, public-edge
promotion, and postflight. Current Cloudflare configuration has a single Container with an immediate
100% rollout, so the workflow truthfully uses operator checkpoints instead of claiming a canary. It
does not bootstrap production, mutate secrets, delete resources, or auto-rollback. It has not run,
and therefore supplies automation policy rather than production evidence.
