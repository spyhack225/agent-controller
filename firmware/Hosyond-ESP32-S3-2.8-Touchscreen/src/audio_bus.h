#pragma once

// PRIVATE to src/audio.cpp and src/speaker.cpp. Nothing else may include this header.
//
// The microphone and the speaker are not two devices. They are one ES8311 sitting on one I2S port,
// clocked by one MCLK, with one amplifier enable line — and this header is the only place that
// fact is written down as code rather than assumed.
//
// WHY AN ARBITER AT ALL — and what it is NOT arbitrating.
//
// It is tempting to say "the codec is half-duplex, so the two directions must take turns". That is
// false, and believing it would produce the wrong design. The ES8311 has an independent ADC and
// DAC, ESP-IDF's i2s_new_channel() hands back a tx and an rx handle on the same port precisely so
// both can run at once, and the vendor's own Example_17_echo streams capture straight back out to
// the speaker in real time. Simultaneous playback and capture WORKS on this silicon.
//
// It is refused anyway, for an acoustic reason that is worse than a driver limitation because no
// amount of correct code fixes it: the speaker connector and the downward-facing MEMS microphone
// are centimetres apart on one small board, and unlike the Waveshare AMOLED board there is no
// ES7210 and no echo canceller anywhere in the chain (see the board README, "Against the Waveshare
// AMOLED board"). A confirmation beep played while recording is a confirmation beep transcribed by
// Parakeet and dispatched to somebody's shell as part of their instruction.
//
// So the rule is a product rule, deliberately stricter than the hardware requires:
//
//   RECORDING WINS, ALWAYS, AND A CUE IS DROPPED RATHER THAN DEFERRED.
//
//   1. While captureActive() is true, the speaker task starts nothing and aborts anything already
//      in flight, mid-tone, on its next DMA chunk boundary.
//   2. A cue requested during capture is DISCARDED, not queued. A cue is feedback about something
//      the person just did; playing it eleven seconds later when the clip finally ends is not late
//      feedback, it is a mystery noise. Deferral would also mean the queue is longest exactly when
//      the user is mid-sentence, so the beeps would all arrive in a burst at the release.
//   3. Capture never waits for playback. startRecording() is on the finger-lift path of a 33 ms
//      render loop and may not block on a task running on the other core, so it signals and
//      proceeds. Worst case a few already-queued DMA frames — under 20 ms of a beep's tail —
//      finish draining while the ADC is still settling, and audio.cpp discards its first two
//      frames at startRecording() anyway, which covers exactly that window.
//   4. The amplifier is forced off by capture regardless of what the speaker task believed. An
//      idle class-D amp hisses, and it hisses into the microphone.
//
// captureGeneration() is the piece that makes (1) correct rather than nearly correct. A plain
// captureActive() flag has a race: a recording can start and finish inside one long tone, leaving
// the flag false again by the time the speaker task looks, so the abort is missed and the tail of
// the cue plays into the tail of the clip. The generation counter increments on every start, so a
// task that captured the value before it began playing can tell "no capture happened" apart from
// "a whole capture happened while I was not looking".

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#if ENABLE_AUDIO_CAPTURE

#include <stdint.h>

#include "driver/i2s_std.h"

namespace audio {
namespace bus {

// The transmit half of the shared I2S port, or nullptr before audio::begin() has succeeded.
// Owned by audio.cpp; borrowed by speaker.cpp. Never freed while the firmware is running.
i2s_chan_handle_t txChannel();

// True once I2S and the ES8311 are both up. Distinct from audio::available(), which is the same
// answer phrased for the UI.
bool codecReady();

// The single owner of AUDIO_PA_ENABLE_PIN. Both audio.cpp and the speaker task call this; the
// capture path always wins, because it calls it with `false` at a point where the speaker task is
// already committed to aborting.
void setPaEnabled(bool on);
bool paEnabled();

// The arbitration state. captureActive() is written by audio.cpp only, read by both.
bool captureActive();
uint32_t captureGeneration();

// Called by audio.cpp around a recording. captureBegin() bumps the generation and forces the
// amplifier off before the first sample is read.
void captureBegin();
void captureEnd();

}  // namespace bus
}  // namespace audio

#endif  // ENABLE_AUDIO_CAPTURE
