# Connector resilience gate

This local gate exercises the real connector package protocol and the Cloudflare Worker/Durable
Object implementation without contacting a deployed Cloudflare account or a live T3 environment.
It is a deterministic regression gate for the locally provable parts of roadmap gaps CG-03 and
CG-12; it is not staging, WAN, live-T3, or physical-controller evidence.

Run it from the repository root:

```bash
npm run test:resilience
```

The connector half uses Node's test runner. The cloud half uses the Cloudflare Vitest Workers pool
and local Durable Object storage/WebSockets. The ordinary `npm test` path also runs both halves:
connector resilience tests are included by `test:connector`, and the Worker resilience suite is
included by `test:cloud`.

## Enforced budgets

| Boundary | Local gate threshold | Production contract |
| --- | ---: | ---: |
| Connector frame | at most 1 MiB | at most 1 MiB |
| Cloud pending requests per environment | 32 | 32 |
| Connector local in-flight effects | 32 | 32 |
| Durable subscription leases per environment | 16 | 16 |
| Durable items retained per subscription | 256 | 256 |
| Durable bytes retained per subscription | 1 MiB | 1 MiB |
| Subscription lease duration | 10 seconds to 5 minutes | 10 seconds to 5 minutes |
| Idle private result/subscription read | one call per bounded wait | at most one call per 25 seconds |
| Long-poll wait | at most 25 seconds | at most 25 seconds |
| Local router dispatch receipt p95 | at most 2 seconds | online acknowledgement p95 at most 2 seconds |
| Warm local status request p95 | at most 500 ms | cloud API p95, excluding connector/T3, at most 500 ms |
| Managed connector log line | at most 16 KiB | at most 16 KiB |
| Managed connector log file | bounded and rotated; test uses 18 KiB | 1 MiB default plus one rotation |
| Managed connector log permissions | `0600` | `0600` |

The latency checks are generous fail-fast regression ceilings. Local Miniflare passing them does
not prove the production latency SLO because it excludes WAN, Cloudflare scheduling, Service
Bindings, Container cold starts, Convex/R2/Queue latency, and T3/provider work.

## Scenarios covered

The Worker/Durable Object suite covers:

- Durable Object eviction and reconstruction with two pending requests completed out of order.
- Stale-connection terminal rejection followed by stable-id request replay on a new connection.
- Cancellation winning over late and duplicate connector results.
- Twelve rapid connector replacements with exactly one authoritative final socket and one replayed
  request identity.
- Lease expiry using a fake wall clock rather than sleeping.
- The exact 32-pending-request saturation boundary and the 33rd request's retryable `429` response.
- Oversized HTTP request and WebSocket frame rejection at 1 MiB.
- Subscription-buffer eviction by byte size, in addition to the ordinary suite's item-count test.
- Register-then-recheck result and subscription waits that wake on state changes, time out bounded,
  preserve cancellation, and replay every delivery sequence without a setup-race gap.
- Container-side call-rate measurements: one result wait per ordinary operation, one outstanding
  private read for an idle subscription, deadline cancellation, and fast terminal wake-up.
- Redacted quarantine envelopes for malformed, terminal, and sixth-attempt exhausted Queue work;
  quarantine publication failure retries the source rather than acknowledging it.
- Warm local status latency and online dispatch-receipt latency measurements.

The connector package suite covers:

- The exact 32-local-effect saturation boundary and stable backpressure failure.
- Cancellation and idempotent replay without re-running a late local effect.
- Twenty consecutive deployment-style WebSocket closes, fresh ticket acquisition, serial reconnect,
  and bounded exponential backoff.
- Bounded, rotated, credential-redacted, owner-only managed logs.

The ordinary cloud runtime suite supplies complementary coverage for ticket single use, request
idempotency after completion, request deadline alarms, subscription cursor resume and count bounds,
duplicate hello rejection, live revocation, and filtering expired/cancelled work during reconnect.

The console has a separate deterministic gate:

```bash
npm run test:browser-performance
```

It enforces production bundle/chunk budgets, a 512-row live transcript projection, truthful
truncation state, and animation-frame coalescing for SSE event bursts. The measured local-browser
observation and the remaining perceptual/hosted evidence are recorded in
[`frontend-performance-gate.md`](frontend-performance-gate.md).

## Evidence this gate cannot provide

The following remain staging or physical release gates and must not be inferred from a local pass:

- Packet loss, DNS failure, WAN latency, real machine sleep/wake, NAT or Tailscale network changes.
- Cloudflare deploy rollover, isolate scheduling, Container cold start/saturation, Durable Object
  regional movement, Queue lag/retries/dead-letter delivery or retention, and Service Binding
  long-poll behavior in an account.
- Live T3 authentication, agent execution, provider latency, streaming first-event latency, and
  connector launchd/systemd-user/Windows Task Scheduler behavior on clean supported machines.
- Browser animation CPU/GPU cost on representative mobile/desktop hardware and real-stream
  long-session heap behavior. The local bundle/projection/coalescing gate does not prove these.
- Firmware frame/refresh responsiveness, certificate refusal, OTA trust rotation, and physical
  controller operation.

Record those separately in the implementation ledger when they are actually observed. Do not use
this local gate to mark CG-03 or CG-12 fully proven.
