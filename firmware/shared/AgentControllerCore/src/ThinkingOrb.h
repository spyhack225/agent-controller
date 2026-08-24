#pragma once

// A rotating point-cloud sphere: the agent-state indicator for boards with a real display.
//
// Ported from Thinking Orbs by Jakub Antalik (MIT), https://orbs.jakubantalik.com — specifically
// `spec/orbs-spec.json`, which is the library's own machine-readable definition of each mode and
// its parameters. Attribution and licence in ThinkingOrb.cpp.
//
// The component computes; it does not draw. It emits a depth-sorted list of screen-space dots with
// a radius and an ink level, and the board's display adapter paints them however it can. That
// keeps one implementation working across an e-ink panel, an IPS TFT, and an AMOLED, which
// otherwise share nothing.
//
// Why this and not an animated GIF or a sprite sheet: the orb has to represent *which* thing the
// agent is doing, and it has to keep moving during a multi-minute turn without burning flash on
// frames. A parametric sphere is a few hundred floats and reads as alive at 12 fps.

#include <Arduino.h>

// The nine states the upstream library defines, each with its own render mode. The names are the
// library's; the mapping from an Agent Controller thread state is in orbModeForAgentState().
enum class OrbMode : uint8_t {
  Orbits,   // working    — particles on inclined orbits
  Globe,    // searching  — lat/lon dot sphere with a scanning band
  Wave,     // listening  — sphere whose rings breathe with amplitude
  Ring,     // breathing  — face-on concentric lanes, the calm/idle state
  Web,      // connecting — sparse nodes with linking chords
};

struct OrbDot {
  int16_t x;      // screen space, relative to the centre passed to render()
  int16_t y;
  uint8_t radius; // in pixels, already floored at the mode's rMin
  uint8_t ink;    // 0..255 grey; the adapter maps this to its own colour space
};

struct OrbFrame {
  const OrbDot* dots;
  uint16_t count;
};

class ThinkingOrb {
 public:
  // `diameter` is the drawing box in pixels. `capacity` bounds the dot budget — the sphere's
  // point count is scaled down to fit, so a small screen or a tight RAM budget degrades density
  // rather than overflowing.
  bool begin(uint16_t diameter, uint16_t capacity = 420);
  void end();

  void setMode(OrbMode mode);
  OrbMode mode() const { return mode_; }

  // Speed multiplier over the mode's own preset speed. 1.0 is the library default.
  void setSpeed(float speed) { speed_ = speed; }

  // Advance to `elapsedMs` and produce the frame. Time is absolute rather than a delta so a
  // dropped frame shows up as a jump instead of the animation silently running slow.
  OrbFrame render(uint32_t elapsedMs);

  uint16_t diameter() const { return diameter_; }

 private:
  void buildGeometry();
  uint16_t emitGlobe(float t);
  uint16_t emitOrbits(float t);
  uint16_t emitWave(float t);
  uint16_t emitRing(float t);
  uint16_t emitWeb(float t);

  // Projects a unit-sphere point through the current rotation and writes it as a dot.
  // `depth01` out-parameter is the normalised nearness used for sorting and ink.
  void project(float x, float y, float z, float cosA, float sinA, float cosB, float sinB,
               float rBase, float rDepth, float inkFar, float inkSpan, uint16_t& n);

  OrbDot* dots_ = nullptr;
  uint16_t capacity_ = 0;
  uint16_t diameter_ = 0;
  float radiusPx_ = 0.0f;
  OrbMode mode_ = OrbMode::Ring;
  float speed_ = 1.0f;

  // Density, scaled to fit both the capacity and the physical size. The upstream spec scales a
  // lat/lon pair by sqrt(count); the same rule is applied here.
  uint8_t latRings_ = 0;
  uint8_t lonDensity_ = 0;
};

// Maps an Agent Controller thread/session state string to an orb mode. Unknown states fall back to
// Ring, the calm one, because an unrecognised state is not a reason to look busy.
OrbMode orbModeForAgentState(const String& state);

// The verb shown under the orb. Matches the upstream labels where a state corresponds.
const char* orbLabelForMode(OrbMode mode);
