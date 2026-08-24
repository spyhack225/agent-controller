# Implementation status

Live progress ledger for
[open-input-media-voice-environments-roadmap.md](open-input-media-voice-environments-roadmap.md).
Updated as work lands, not at the end. Anything not listed as **done** is not done.

Last updated: 2026-08-24. **Milestone 0.5 is complete.** Gate: 166 frontend tests, 341 server tests, exit 0.

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
| Hosyond flashed and run on hardware | done | PSRAM 8MB, flash 16MB, battery 4116mV, codec ACK, SoftAP portal — all confirmed on silicon |
| Hosyond microphone proven | done | Boot self-test: peak 779 / rms 284 / dc 12 at 30 dB gain, quiet room |
| Hosyond ILI9341 display | done | Up on hardware. Root cause was ESP-IDF's two I2C driver generations linked together, aborting from a constructor at 210 ms. IPS inversion (`0x21`) applied per the vendor init |
| Device UI redesign (orb aesthetic) | wip | Orb layout running on the panel; needs visual confirmation and the agent-state wiring |
| Gateway client extracted to `firmware/shared` | todo | **The blocker for any second board doing real work** |

## Milestone 0.5 — independent repairs

Depend on none of the new infrastructure.

| Item | State | Notes |
|---|---|---|
| Remove environment + dependency repair | done | `GET /v1/t3/environments/:id/dependencies` preview; cascade repair for actions, macros, onboarding across memory + Convex |
| Reason-specific recovery dialog | done | Eight-reason enum; dialog branches per reason; polling stops for the three that need owner action and resumes on a credential epoch |
| First-turn attachments | done | Launch resolves media through the same ownership/kind checks as submitIntent; attachments land on the bootstrap turn |
| Multi-attachment end to end | done | Ordered list, per-item validation, scalar kept as a protocol-v1 alias; Operate has add/remove/reorder chips |

## Milestone 0 — contracts and diagnostics

Next up. The open design question below has to be settled before the first item starts.

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
| Orb spec vendored | done | 9 modes + parameters extracted from the MIT library's own spec |
| Orb renderer in C++ | done | `ThinkingOrb.{h,cpp}` in `firmware/shared`. Five modes, painter-sorted, depth-scaled radius and ink. Compiles; unseen because the panel is down |
| Orb painting + shimmer label | done | `displayDrawOrb` / `displayDrawStatus` in the Hosyond display adapter. Erases per-dot rather than clearing the box, which is ~10x less SPI traffic |
| Agent-state to orb-mode mapping | done | `orbModeForAgentState()` |
| Agent-state to orb-mode mapping | todo | The library already maps 9 states to 9 modes |
| Screen layout on 240x320 | done | Orb, verb, context line on near-black. Static chrome drawn once; orb ticks at ~30 ms |
| Web console parity | todo | Same orb for agent thinking states |

## Known blockers

0. **Resolved.** The display crash was ESP-IDF 5.x aborting from a constructor because both I2C
   driver generations were linked — the vendored ES8311 on the legacy driver, Adafruit BusIO on
   the new one. Both are on `Wire` now. Two earlier hypotheses (backlight inrush, GPIO45
   strapping) were wrong; the fixes they produced are kept because they are correct on their own
   terms.
1. **The gateway client is not shared.** Heartbeat, display state, intent submission, OTA, and
   media upload live inside the CrowPanel's 3652-line `main.cpp`. Until they move into
   `firmware/shared/AgentControllerCore`, the Hosyond board can record a clip and do nothing
   with it. This gates most of Milestone 3.
2. **No hardware validation on any board.** Everything compiles; nothing has been confirmed on
   silicon except what the connected Hosyond unit now proves.
