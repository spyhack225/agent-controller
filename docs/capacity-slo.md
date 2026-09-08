# Beta capacity and SLO gate

This document defines the provisional beta budget and records the deterministic local evidence for
roadmap gap CG-08. It is deliberately **not a hosted-capacity claim**. Local Node, Vitest, workerd,
and Miniflare measurements do not reproduce a Cloudflare `standard-1` Container's CPU share,
memory, regional placement, cold start, Service Binding latency, Durable Object placement, or
billing.

Run the complete local gate from the repository root:

```bash
npm run test:capacity
```

The command emits `CAPACITY_WORKER_RESULT` and `CAPACITY_CONTAINER_PROXY_RESULT` JSON records, then
prints the Node-adapter report as JSON. It makes no network call to a Cloudflare account and writes
no runtime state. The committed measurements below are one observed run, not a portable benchmark.

## Provisional beta decision

Keep the control plane at one `standard-1` Container (`max_instances = 1`) for staging and the first
closed-beta qualification. Do not raise `max_instances`, publish a supported account count, or call
the beta capacity accepted until the staging decision gates below pass.

The local admission workload is:

- 16 simultaneously connected connector environments, each in its own Durable Object.
- 48 concurrent requests through the singleton Container Worker proxy.
- One fully saturated environment at its hard 32 pending requests, 16 subscription leases, and 48
  active long-poll waiters; the next request, lease, or waiter must receive a retryable `429`.

Sixteen environments and 48 Container requests are qualification floors, not global hard limits or
promised hosted capacity. The local gate intentionally does not claim the Cartesian worst case of
16 environments each holding 48 waits. That 768-wait scenario belongs in staging before the
admission profile can be accepted or raised.

## Beta SLO budget

| Boundary | Provisional target | Local evidence | Hosted status |
| --- | ---: | --- | --- |
| Cloud control-plane availability | 99.5% monthly | Not measurable locally | Staging soak required |
| Cloud API, excluding connector/T3 | p95 <= 500 ms; p99 <= 1 s | Local hop ceilings below | Service Binding/Convex/R2 staging required |
| Online command acceptance | p95 <= 2 s; p99 <= 5 s | Local DO dispatch receipt measured | WAN + deployed connector required |
| Container ready after cold allocation | <= configured 20 s startup timeout | Fresh local Node adapter only | Cloudflare cold-start drill required |
| Container response headers | <= configured 30 s timeout | Proxy timeout contract tested | Hosted saturation required |
| Per-environment overload | Explicit retryable `429`, never unbounded queuing | Proven at 33rd request, 17th lease, 49th waiter | Repeat under hosted load |
| Restore after singleton loss | Durable state survives; in-flight callers receive explicit retryable failure | Store/DO recovery tests only | Kill/rollover drill required |

Availability covers the Cloudflare edge, private Container control plane, Durable Object routing,
and configured durable stores. It excludes the user's WAN, sleeping machine, local T3, and provider
execution. Those layers remain visible separately in product health instead of being folded into a
misleading cloud availability number.

## Existing hard bounds

| Resource | Bound | Owner |
| --- | ---: | --- |
| Control-plane Containers | one `standard-1` | Wrangler configuration |
| Container Worker proxy | qualified at 48 concurrent requests; no global application cap yet | Staging admission decision |
| Active connector socket | one per environment | Environment Durable Object |
| Pending connector requests | 32 per environment | Durable Object and connector protocol |
| Subscription leases | 16 per environment | Durable Object |
| Active result/subscription waits | 48 per environment (`32 + 16`) | Durable Object |
| Long-poll duration | 25 seconds | Durable Object |
| Connector JSON frame | 1 MiB | Shared protocol |
| Subscription items | 256 per lease | Durable Object |
| Subscription retained bytes | 1 MiB per lease | Durable Object |

The 48-waiter bound is process-local to one active Durable Object instance. Hibernation or eviction
ends those HTTP waits; callers resume from durable request state or subscription cursor rather than
depending on the in-memory waiter set.

## Local regression ceilings

These intentionally loose ceilings detect accidental serialization, blocking work, or unbounded
growth on a development machine. They are not production SLOs.

| Local measurement | Gate |
| --- | ---: |
| Fresh Node adapter to first `/health`, p95 | <= 2,000 ms |
| Warm Node adapter restart to first `/health`, p95 | <= 1,000 ms |
| Warm public `/health`, p95 / p99 | <= 100 / 250 ms |
| Warm private background capability, p95 / p99 | <= 150 / 300 ms |
| 48-way public saturation, p95 / p99 | <= 500 / 1,000 ms |
| RSS growth during the workload | <= 64 MiB |
| Heap growth during the workload | <= 32 MiB |
| CPU per saturated request | <= 20 ms |

Absolute local RSS is recorded but not compared with `standard-1`: the measurement is the host Node
process with development dependencies, not the release image under Cloudflare's resource controls.
The hosted Container's memory/CPU high-water marks remain a staging metric.

## Rate-limit durability and failure behavior

Without `RATE_LIMIT_REDIS_URL`, the Container uses fixed-window process-local counters. The harness
proves both sides of that contract: a limit is enforced inside one process, and process-local
counters reset when a fresh limiter represents a Container restart. A shared backend reused by two
limiter instances preserves the limit.

For the current singleton, a restart therefore creates a brief fresh rate-limit window. Durable
account/device/connector state is unaffected, but abuse counters are not restart-durable. Before
`max_instances` becomes greater than one, a shared backend is mandatory; staging must configure
`RATE_LIMIT_REDIS_URL`, inject restart and backend-outage cases, and decide whether the current
fail-open backend-outage policy is acceptable for every internet-facing realm. A local in-memory
test is not Redis availability evidence.

The singleton is also one availability domain. During allocation, crash, or rollout the Worker
returns bounded `503`/`504` responses. Clients retry only idempotent operations; connector requests
retain request IDs and idempotency keys, while the Durable Object owns socket/replay state and Convex
owns durable control-plane records. No process-local Container state may be treated as authoritative
after restart.

## Recorded local report — 2026-08-27

Environment:

- Integrated root run began `2026-08-27T21:59:10Z`; its Node phase began
  `2026-08-27T21:59:14.426Z` (`America/New_York`).
- macOS `25.5.0`, Apple M3 arm64, 8 logical CPUs, 16 GiB host memory.
- Node `v26.5.0`, npm `11.17.0`.
- Cloud Worker harness: Wrangler `4.127.0`, Vitest `4.1.10`,
  `@cloudflare/vitest-pool-workers` `0.22.0`.
- Container proxy harness: Vitest `4.1.11`.
- No Docker image, Cloudflare account, Service Binding, Convex, R2, Redis, live connector, or live T3
  participated.

Observed Node adapter results:

| Hop/workload | Samples | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh adapter -> first public health | 5 | 1.750 ms | 19.130 ms | 19.130 ms | 19.130 ms |
| Warm adapter restart -> first public health | 5 | 0.844 ms | 2.169 ms | 2.169 ms | 2.169 ms |
| Warm public health | 100 | 1.403 ms | 1.938 ms | 2.468 ms | 3.301 ms |
| Warm private background capability | 100 | 1.594 ms | 2.938 ms | 4.555 ms | 4.588 ms |
| Public health, four batches x 48 concurrent | 192 | 4.226 ms | 6.953 ms | 7.584 ms | 7.654 ms |

The 192-request saturation completed in 26.952 ms with zero non-200 responses. The process recorded
40.275 ms CPU total (0.210 ms per saturated request), RSS 67.266 -> 108.953 MiB (41.688 MiB
growth), and heap used 12.728 -> 28.665 MiB (15.938 MiB growth). Event-loop utilization was `1.0`
during the intentionally continuous short burst; that value is recorded, not interpreted as a
hosted CPU percentage.

Observed Worker/Durable Object results:

| Hop/workload | Samples | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ticket + connector WebSocket handshake across 16 environments | 16 | 76 ms | 78 ms | 78 ms | 78 ms |
| Worker -> environment DO status | 16 | 5 ms | 6 ms | 6 ms | 6 ms |
| Worker -> DO request dispatch receipt at 32-way saturation | 32 | 18 ms | 24 ms | 24 ms | 24 ms |
| Worker -> DO subscription open at 16-way saturation | 16 | 7 ms | 8 ms | 8 ms | 8 ms |
| Container Worker proxy -> held stub after release | 48 | 4.741 ms | 4.746 ms | 4.747 ms | 4.747 ms |

The 33rd pending request, 17th lease, and 49th active waiter each returned `429`; the waiter overflow
response took 3 ms locally. The Container Worker proxy admitted all 48 held request bodies
concurrently (`maxActive = 48`) and completed them 4.749 ms after barrier release. An earlier root
repeat on the same machine observed a 1,842 ms saturated dispatch p95 while later runs were much
faster; Miniflare timing is therefore a regression signal, not hosted SLO proof.

## Staging decision gates

CG-08 cannot be closed as production-proven until one isolated staging report records all of:

1. `standard-1` CPU and memory high-water marks, cold/warm startup, sleep-after wake, crash restore,
   and deployment rollover under the same request mix.
2. p50/p95/p99 for browser/controller -> edge, edge -> Container, Container -> environment DO,
   DO -> connector, connector -> T3 acceptance, and first result/event.
3. At least 16 concurrent environments, 48 concurrent Container requests, one fully saturated DO,
   then the 16 x 48 worst-case wait matrix or a lower enforced admission limit.
4. Redis-backed rate-limit continuity across Container restart and, before any multi-instance test,
   across two instances; explicit observation of backend outage behavior.
5. Availability/error rate during a representative soak, plus Queue/Convex/R2/Service Binding lag.
6. A Cloudflare billing observation for the measured workload. Cost is intentionally not estimated
   here because local request counts do not establish hosted CPU, memory, egress, Queue, DO, R2, or
   Container duration charges.
7. An accepted decision to retain the singleton, partition by tenant/environment, or introduce a
   bounded admission queue, with rollback thresholds and an operator owner.

Until those gates pass, documentation must say “locally qualified at the provisional workload,” not
“supports N users/environments” or “production capacity proven.”
