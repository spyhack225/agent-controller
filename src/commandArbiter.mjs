import { reconcileCommandStatus } from "./t3Harness.mjs";

// `dispatched` means T3 accepted the command, not that the agent replied. Two things now close
// that gap and they run concurrently: the snapshot poller (polled evidence, every few seconds)
// and the live thread stream (event evidence, immediately). Both read the same command row and
// both would write it.
//
// The store has no compare-and-set, so "check status, then update" is a read-modify-write with an
// await in the middle — and an await is exactly where the other one gets to run. Left alone that
// produces two writes, two `command.reconciled` events, and, if the stream saw a failure while the
// poller saw a stale reply, two DIFFERENT terminal statuses for one command.
//
// So neither of them decides anything directly. They both hand their evidence to one arbiter and
// it decides once. The rules it enforces are the ones CLAUDE.md already states, made unavoidable
// rather than repeated:
//
//   - a command that is not `dispatched` is never re-decided (terminal stays terminal);
//   - the decision itself is still `reconcileCommandStatus()`, unchanged, so the "evidence must be
//     newer than the dispatch" guard applies identically to polled and to live evidence;
//   - a command already decided in this process is never decided again, even if a later poll
//     re-reads a row the store has not yet caught up on;
//   - a command being written right now is not decided again while that write is in flight.
//
// In-process only, and that is honest about what it buys: one gateway process cannot fight itself.
// Two gateway processes against one T3 would still both decide, and both would write the same
// terminal status from the same T3 evidence — idempotent, which is why this is not a distributed
// lock.
const DEFAULT_HISTORY_LIMIT = 5000;

export function createCommandArbiter({
  historyLimit = DEFAULT_HISTORY_LIMIT,
  decide: decideStatus = reconcileCommandStatus,
  now = () => Date.now(),
} = {}) {
  // Insertion-ordered, so trimming the oldest entry is just the first key.
  const decided = new Map();
  const inFlight = new Set();

  /**
   * Decides a single command, or refuses and says nothing happened.
   *
   * `apply` performs the actual write and any notification. It is called at most once per command
   * for the lifetime of this process, and it is only called when there is a decision to apply.
   *
   * Returns the applied update (plus its source) or null.
   */
  async function reconcile({ command, outcome, apply, source = "unknown" }) {
    const commandId = command?.id;
    if (!commandId) return null;
    if (command.status !== "dispatched") return null;
    if (decided.has(commandId) || inFlight.has(commandId)) return null;

    const update = decideStatus(command, outcome);
    if (!update) return null;

    inFlight.add(commandId);
    try {
      await apply(update);
    } finally {
      inFlight.delete(commandId);
    }

    decided.set(commandId, { status: update.status, source, at: now() });
    while (decided.size > historyLimit) {
      const oldest = decided.keys().next();
      if (oldest.done) break;
      decided.delete(oldest.value);
    }
    return { ...update, source };
  }

  function decisionFor(commandId) {
    return decided.get(commandId) ?? null;
  }

  return { reconcile, decisionFor, get size() { return decided.size; } };
}
