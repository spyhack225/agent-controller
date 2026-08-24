/**
 * What the console is allowed to animate, and what each animation means.
 *
 * Every orb in this app resolves through here rather than being chosen at the call site, because
 * motion is a claim: an animation says *work is happening right now*. Getting that wrong is worse
 * than showing nothing — a spinning console while the gateway is actually blocked on the owner's
 * approval reads as "it is thinking", and the owner waits instead of deciding.
 *
 * Three rules hold across every mapping below:
 *
 *   1. Finished is `null`. No orb survives a terminal state; the status badge carries it.
 *   2. Blocked on a person is `paused`. The orb is held on one frame — present, visibly not
 *      progressing — so "waiting for you" never wears the same motion as "working".
 *   3. The state names the *kind* of work, not its urgency. `listening` is only ever real audio,
 *      `shaping` is only ever a transform that preserves content, `connecting` is only ever a hop
 *      to another machine. That is what makes a glance informative rather than decorative.
 */

import type { OrbState } from "thinking-orbs";

import type { ConnectionState } from "./types";

export interface Activity {
  state: OrbState;
  /** Announced to assistive tech and used as the visible tooltip. Say what is happening, plainly. */
  label: string;
  /** Held on one frame: the work is real but stalled on a human decision. */
  paused?: boolean;
  /** Multiplier over the preset's baked speed. Only used to signal urgency, never for flourish. */
  speed?: number;
}

/**
 * A command's own progress. `dispatched` is the important one: it means T3 accepted the command,
 * not that the agent replied, and before this there was nothing on screen that distinguished
 * "still running" from "stuck" while the poller reconciled it.
 */
export function commandActivity(
  status: string | undefined,
  intentType?: string | null,
): Activity | null {
  switch (status) {
    case "queued":
    case "pending":
      return { state: "breathing", label: "Queued for dispatch" };
    case "approval_required":
      return { state: "breathing", label: "Waiting for your decision", paused: true };
    case "approved":
      return { state: "connecting", label: "Sending to the agent" };
    case "dispatched":
    case "running":
      // A shell command is a different kind of work from a prompt, and the console already treats
      // it as a separate mode everywhere else. Keep that distinction visible while it runs.
      return intentType === "shell_input" || intentType === "terminal_input"
        ? { state: "solving", label: "Running the shell command" }
        : { state: "working", label: "Agent is working" };
    default:
      return null;
  }
}

/**
 * A transcription job's stage. The stage machine is `queued → transcribing → normalizing →
 * review_required|ready → dispatching → dispatched`, and two of those stages are waiting on a
 * person rather than on a worker.
 */
export function mediaJobActivity(stage: string | undefined): Activity | null {
  switch (stage) {
    case "queued":
      return { state: "breathing", label: "Queued for transcription" };
    case "transcribing":
      return { state: "listening", label: "Transcribing audio" };
    case "normalizing":
      // Normalisation may move spacing, punctuation and case — never letters. `shaping` is the one
      // state that reads as "same thing, new form", which is exactly the guarantee being made.
      return { state: "shaping", label: "Cleaning up punctuation" };
    case "review_required":
      return { state: "breathing", label: "Waiting for your review", paused: true };
    case "ready":
      return { state: "breathing", label: "Transcript ready to send", paused: true };
    case "dispatching":
      return { state: "connecting", label: "Sending the transcript" };
    default:
      return null;
  }
}

/**
 * The event stream. `live` and `connected` animate nothing on purpose — a permanently moving piece
 * of chrome stops being read within a day, and the badge already says the stream is open. Only the
 * transitions are work.
 */
export function connectionActivity(connection: ConnectionState): Activity | null {
  switch (connection) {
    case "connecting":
      return { state: "connecting", label: "Opening the event stream" };
    case "reconnecting":
      return { state: "connecting", label: "Reconnecting to the gateway", speed: 1.5 };
    default:
      return null;
  }
}

/**
 * Pulling projects and threads out of a paired T3 instance. This is a read across someone else's
 * machine, which is what `searching` depicts — not local work.
 */
export function workspaceSyncActivity(
  status: "loading" | "loaded" | "failed" | null | undefined,
): Activity | null {
  return status === "loading"
    ? { state: "searching", label: "Reading projects and threads from T3 Code" }
    : null;
}

/** An assistant turn arriving token by token. */
export function streamingActivity(streaming: boolean | undefined): Activity | null {
  return streaming ? { state: "composing", label: "Agent is replying" } : null;
}

/**
 * A full refresh: devices, environments, media, commands and approvals are four independent
 * fetches braided back into one view, which is the one thing in this console that `weaving`
 * actually describes.
 */
export function refreshActivity(refreshing: boolean): Activity | null {
  return refreshing ? { state: "weaving", label: "Refreshing every workspace" } : null;
}

/** Live microphone capture, before any of it has been uploaded or transcribed. */
export function recordingActivity(recording: boolean): Activity | null {
  return recording ? { state: "listening", label: "Recording" } : null;
}
