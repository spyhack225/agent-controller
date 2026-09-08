# Frontend performance gate

This gate covers the browser-performance properties that are deterministic in a local build:
initial transfer shape, route chunking, bounded live-thread projection, and render-frame coalescing.
It does not claim hosted latency, mobile smoothness, GPU cost, or long-session behavior with a real
T3/provider stream.

Run it from the repository root:

```bash
npm run test:browser-performance
```

The ordinary `npm test` gate also builds the production console and runs the bundle assertion. It
does not assert machine-dependent wall-clock timings.

## Enforced production-build budgets

| Boundary | Budget | Current local build |
| --- | ---: | ---: |
| Initial static JavaScript | at most 560 KiB raw | 489.06 KiB |
| Initial static JavaScript | at most 160 KiB gzip | 138.29 KiB |
| Initial static JavaScript requests | at most 4 | 3 |
| Initial CSS | at most 40 KiB gzip | 33.36 KiB |
| Any lazy feature chunk | at most 28 KiB gzip | 21.31 KiB (`DevicesPage`) |
| Any feature route plus its non-initial static dependencies | at most 36 KiB gzip / 20 requests | 28.05 KiB / 18 requests (`OnboardingPage`) |
| Required lazy workspaces | 14 named feature chunks | 14 |
| Live transcript projection | at most 512 rendered entries | 512 |
| T3 work projection | at most 64 task nodes | 64 |
| Per-task activity projection | at most 16 latest rows | 16 |
| Live-event rendering | at most one state transition per animation-frame batch | one for a 100-event test burst |

The build gate reads Vite's manifest and follows the entry's static import graph. Dynamic feature
chunks are not charged to first load, but every named workspace must remain dynamic. Both its own
chunk and its complete incremental static dependency graph are bounded, preventing a large shared
chunk from bypassing the route budget. Sizes are calculated from built bytes with deterministic
level-9 gzip, not source-file estimates.

Before route splitting, the console emitted one 819,585-byte JavaScript entry (218,741 bytes gzip)
plus the already-lazy navigation effect. The current entry graph totals 489.06 KiB raw and
138.29 KiB gzip. Devices, Environments, Operations, onboarding, settings, media, activity,
actions, quick control, claim/recovery, and the three landing surfaces now load on demand.

## Streaming and long-session bounds

- `t3.thread.event` frames are retained in arrival order but coalesced until the next animation
  frame. The entire batch is reduced through one React state update; an authoritative snapshot
  flushes older queued events first so replacement semantics remain intact.
- The deduplication ring remains capped at 512 event identities.
- The live transcript projection now retains the newest 512 entries. When a snapshot or ongoing
  stream exceeds that limit, `historyTruncated` becomes true and the Operations view explicitly
  says that older history is not loaded.
- The T3-native work projection retains at most 64 task nodes and 16 activity rows per node.
  Stable T3 progress/usage IDs replace in place. When a 65th distinct task arrives, active tasks
  are retained ahead of the oldest terminal task; the inspector reports the omitted count. This
  caps the reducer at 1,024 per-task activity rows and the DOM stays collapsed until the operator
  opens the inspector/node disclosures.
- Agent-owned task/tool rows render in the work inspector instead of appearing a second time in the
  parent transcript. The device fold is separately capped at 64 task IDs and returns counts only.
- Unit tests exercise a 100-event frame burst, an 80-delta single-message batch, an oversized
  snapshot, a live stream longer than the transcript limit, a 73-task work window, and more than 16
  per-task tool rows. These are deterministic structure and memory-growth proofs; they are not a
  browser heap soak.

## Local browser observation — 2026-08-27

A cold-profile Google Chrome run loaded the production build from a loopback Vite preview with no
live T3 or user data. Browser `PerformanceResourceTiming`, DOM, animation, and heap APIs reported:

| Observation | Result |
| --- | ---: |
| Asset requests for the default landing route | 20, including five local font files |
| Transferred asset bytes | 186,379 |
| DOMContentLoaded / load | 179.3 ms / 179.3 ms |
| Slowest local asset request | 51.5 ms |
| DOM nodes after idle | 357 |
| Used JavaScript heap after idle | 3,407,982 bytes |
| Running infinite animations after idle | 0 |

These values demonstrate one local production-build observation and are intentionally not CI
thresholds. Loopback timing and a desktop Chrome heap cannot predict Cloudflare/WAN latency or a
mobile GPU.

## Evidence still required

- A deployed authenticated console journey with real Cloudflare cache/compression headers and a
  live connector/T3/provider stream.
- Chrome/Safari profiling on representative desktop and mobile hardware, including paint,
  compositor/GPU activity, input latency, hidden-tab behavior, and reduced motion.
- A multi-hour browser soak with real streaming output, approvals, reconnects, route changes, and
  before/after heap snapshots proving that retained DOM/listener/object graphs stabilize.
- Slow/lossy WAN measurements and hosted per-hop latency. Local route size and event batching do
  not establish either.
