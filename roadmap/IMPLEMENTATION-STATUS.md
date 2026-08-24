# Implementation status

Live progress ledger for
[open-input-media-voice-environments-roadmap.md](open-input-media-voice-environments-roadmap.md).
Updated as work lands, not at the end. Anything not listed as **done** is not done.

Last updated: 2026-08-24.

## Legend

| Mark | Meaning |
|---|---|
| done | Implemented, tested, and committed |
| wip | Being worked now |
| blocked | Cannot proceed; the blocker is named |
| todo | Scheduled, not started |

## Hardware

| Item | State | Notes |
|---|---|---|
| CrowPanel e-ink board | done | Only complete firmware. Never validated on silicon |
| Waveshare AMOLED 1.75C scaffold | done | Compiles. Pin map unverified against a 1.75C schematic |
| Hosyond ES3C28P board folder | done | Compiles. Pin map vendor-verified |
| Hosyond on-board capture path | done | Record to PSRAM, peak/RMS, speaker playback — all offline |
| Toolchain on ESP-IDF 5.5 / Arduino 3.3 | done | pioarduino fork. All 9 environments across 4 boards build |
| Hosyond flashed and run on hardware | wip | Board is connected at `/dev/cu.usbmodem1101` |
| Device UI redesign (orb aesthetic) | wip | See "Device UI" below |
| Gateway client extracted to `firmware/shared` | todo | **The blocker for any second board doing real work** |

## Milestone 0.5 — independent repairs

Depend on none of the new infrastructure.

| Item | State | Notes |
|---|---|---|
| Remove environment + dependency repair | todo | Orphans actions, macros, onboarding today |
| Reason-specific recovery dialog | todo | Widen the existing 3-status classification and stop discarding it |
| First-turn attachments | todo | `buildT3ProjectLaunchCommands` hardcodes `attachments: []` |
| Multi-attachment end to end | todo | Intent schema is scalar-only; array path is dead code |

## Milestone 0 — contracts and diagnostics

| Item | State | Notes |
|---|---|---|
| Request envelope + state model | todo | Open question: extend `/v1/intents` vs add `/v1/requests` |
| Typed T3 errors + capability manifest | todo | |
| Store methods across memory/file/Convex | todo | |
| T3 contract fixtures | todo | |

## Milestone 1 — composer and connection

| Item | State | Notes |
|---|---|---|
| Unified Operate composer | todo | |
| QuickPage composer | todo | Phone surface currently cannot send anything |
| First-run connection flow | todo | |
| Re-pair in place from recovery | todo | |

## Milestone 2 — voice pipeline

| Item | State | Notes |
|---|---|---|
| Raw upload / finalize path | todo | |
| Durable processing jobs | todo | Transcription is synchronous in-request today |
| Parakeet adapter | todo | Providers are `disabled`/`mock`/`openai` only |
| Transcript versions + review | todo | |
| Device audio auto-transcribe | todo | `POST /v1/device/media` never calls the transcriber |

## Milestones 3–4

| Item | State | Notes |
|---|---|---|
| PWA companion deep link | todo | |
| Controller voice paths | wip | Hosyond capture works; upload blocked on the shared client |
| T3 adapter consolidation | todo | |
| Feature flags and staged rollout | todo | |

## Device UI

Redesign of the controller's on-screen interface, taking the visual language of
[Thinking Orbs](https://orbs.jakubantalik.com) (MIT, Jakub Antalik) — a canvas point-cloud sphere
on near-black, with a shimmer-swept label.

| Item | State | Notes |
|---|---|---|
| Orb spec vendored | todo | `spec/orbs-spec.json` defines 9 modes and their parameters |
| Orb renderer in C++ | todo | Point-cloud sphere, 3D rotate + depth-faded projection |
| Agent-state to orb-mode mapping | todo | The library already maps 9 states to 9 modes |
| Screen layout on 240x320 | todo | |
| Web console parity | todo | Same orb for agent thinking states |

## Known blockers

1. **The gateway client is not shared.** Heartbeat, display state, intent submission, OTA, and
   media upload live inside the CrowPanel's 3652-line `main.cpp`. Until they move into
   `firmware/shared/AgentControllerCore`, the Hosyond board can record a clip and do nothing
   with it. This gates most of Milestone 3.
2. **No hardware validation on any board.** Everything compiles; nothing has been confirmed on
   silicon except what the connected Hosyond unit now proves.
