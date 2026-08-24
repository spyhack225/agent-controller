#include "ThinkingOrb.h"

#include <algorithm>
#include <math.h>

// Ported from Thinking Orbs by Jakub Antalik.
//   https://orbs.jakubantalik.com  ·  https://github.com/Jakubantalik/Libraries
//   MIT License, Copyright (c) 2026 Jakub Antalik.
//
// The numbers below are that library's own machine-readable spec (spec/orbs-spec.json), not values
// eyeballed from the demo. Its paint model is deliberately plain — source-over fills, no blur, no
// blend modes, painter-sorted far to near — which is exactly why it survives the trip to a panel
// that has none of those.
//
// Divergences from the web original, and why:
//   * Density is scaled to a dot budget as well as to size. A browser can afford 750 dots per
//     frame at 60 fps; a 240 MHz Xtensa pushing SPI cannot, and a half-drawn frame looks worse
//     than a sparser complete one.
//   * No device-pixel-ratio handling. There is exactly one pixel ratio here.
//   * Integer output. The adapter draws whole pixels, so rounding happens once, here, rather than
//     separately in every board's paint path.

namespace {

// Per-mode geometry, from baseProfiles in the spec.
struct Profile {
  uint8_t latRings;
  uint8_t lonDensity;
  float rBase;
  float rDepth;
  float inkFar;
  float inkSpan;
  float speed;      // the 64px preset speed
  float count;      // the 64px preset density multiplier
  float size;       // the 64px preset radius multiplier
};

// rsPow and rMin are 0.6 and 0.3 for every mode in the spec, so they are constants rather than
// nine copies of the same number.
constexpr float kRsPow = 0.6f;
constexpr float kRMin = 0.3f;
constexpr float kCullInk = 0.02f;

const Profile kProfiles[] = {
  // Orbits — working. Particles riding inclined rings.
  { 0,  0,   1.2f, 1.6f, 0.55f, 0.45f, 1.885f, 1.00f, 1.00f },
  // Globe — searching. The flagship lat/lon dot sphere.
  { 17, 44,  0.6f, 1.7f, 0.62f, 0.54f, 2.015f, 0.42f, 1.15f },
  // Wave — listening. Sphere whose rings breathe with amplitude.
  { 15, 40,  0.6f, 1.7f, 0.62f, 0.54f, 4.388f, 0.341f, 1.00f },
  // Ring — breathing. Face-on lanes; the calm state.
  { 5,  88,  1.1f, 1.7f, 0.60f, 0.50f, 1.200f, 0.30f, 1.00f },
  // Web — connecting. Sparse nodes, sparser than a globe on purpose.
  { 9,  22,  0.9f, 1.5f, 0.55f, 0.50f, 2.400f, 0.30f, 1.20f },
};

const Profile& profileFor(OrbMode m) { return kProfiles[static_cast<uint8_t>(m)]; }

struct Scratch {
  OrbDot dot;
  float z;
};

Scratch* scratch = nullptr;

inline uint8_t inkToGrey(float ink) {
  if (ink < 0.0f) ink = 0.0f;
  if (ink > 1.0f) ink = 1.0f;
  return (uint8_t)lroundf(ink * 255.0f);
}

}  // namespace

bool ThinkingOrb::begin(uint16_t diameter, uint16_t capacity) {
  end();
  if (diameter < 8 || capacity < 16) return false;

  diameter_ = diameter;
  radiusPx_ = diameter * 0.5f;
  capacity_ = capacity;

  dots_ = (OrbDot*)malloc(sizeof(OrbDot) * capacity_);
  scratch = (Scratch*)malloc(sizeof(Scratch) * capacity_);
  if (!dots_ || !scratch) {
    end();
    return false;
  }

  buildGeometry();
  return true;
}

void ThinkingOrb::end() {
  free(dots_);
  dots_ = nullptr;
  free(scratch);
  scratch = nullptr;
  capacity_ = 0;
}

void ThinkingOrb::setMode(OrbMode mode) {
  if (mode == mode_) return;
  mode_ = mode;
  buildGeometry();
}

// The spec scales a lat/lon pair by sqrt(count): halving the density multiplier takes roughly a
// third off each axis rather than off the product, which keeps the sphere looking like a sphere
// instead of a set of stripes. The dot budget is then applied the same way, so a tight capacity
// thins both axes evenly.
void ThinkingOrb::buildGeometry() {
  const Profile& p = profileFor(mode_);
  if (p.latRings == 0) {  // Orbits builds its points procedurally.
    latRings_ = 0;
    lonDensity_ = 0;
    return;
  }

  const float countScale = sqrtf(p.count);
  float lat = fmaxf(2.0f, roundf(p.latRings * countScale));
  float lon = fmaxf(2.0f, roundf(p.lonDensity * countScale));

  if (capacity_ > 0 && lat * lon > capacity_) {
    const float fit = sqrtf((float)capacity_ / (lat * lon));
    lat = fmaxf(2.0f, floorf(lat * fit));
    lon = fmaxf(2.0f, floorf(lon * fit));
  }

  latRings_ = (uint8_t)lat;
  lonDensity_ = (uint8_t)lon;
}

void ThinkingOrb::project(float x, float y, float z, float cosA, float sinA, float cosB,
                          float sinB, float rBase, float rDepth, float inkFar, float inkSpan,
                          uint16_t& n) {
  if (n >= capacity_) return;

  // Yaw then pitch. Two axes is enough to read as a rotating solid; a third only adds cost.
  const float x1 = x * cosA + z * sinA;
  const float z1 = -x * sinA + z * cosA;
  const float y2 = y * cosB - z1 * sinB;
  const float z2 = y * sinB + z1 * cosB;

  // Nearness in 0..1. Everything visual keys off this: dots grow and brighten as they come round.
  const float depth = (z2 + 1.0f) * 0.5f;
  const float shaped = powf(depth, kRsPow);

  const float ink = inkFar * depth + inkSpan * shaped;
  if (ink < kCullInk) return;

  float r = (rBase + rDepth * shaped) * (radiusPx_ / 32.0f);
  if (r < kRMin) r = kRMin;

  Scratch& s = scratch[n++];
  s.z = z2;
  s.dot.x = (int16_t)lroundf(x1 * radiusPx_ * 0.86f);
  s.dot.y = (int16_t)lroundf(y2 * radiusPx_ * 0.86f);
  s.dot.radius = (uint8_t)std::min(255L, lroundf(r) < 1 ? 1L : lroundf(r));
  s.dot.ink = inkToGrey(ink);
}

uint16_t ThinkingOrb::emitGlobe(float t) {
  const Profile& p = profileFor(mode_);
  const float cosA = cosf(t), sinA = sinf(t);
  const float cosB = cosf(0.42f), sinB = sinf(0.42f);   // fixed tilt, so the poles never face us

  uint16_t n = 0;
  for (uint8_t i = 0; i < latRings_; ++i) {
    // Offset by half a step so no ring sits exactly on the equator, which would read as a seam.
    const float phi = ((i + 0.5f) / latRings_) * (float)M_PI;
    const float sinPhi = sinf(phi), cosPhi = cosf(phi);
    // Fewer points near the poles, in proportion to the ring's circumference. Without this the
    // poles turn into bright clots.
    const uint8_t ringPoints = (uint8_t)fmaxf(3.0f, roundf(lonDensity_ * sinPhi));
    for (uint8_t j = 0; j < ringPoints; ++j) {
      const float theta = (j / (float)ringPoints) * 2.0f * (float)M_PI;
      project(sinPhi * cosf(theta), cosPhi, sinPhi * sinf(theta),
              cosA, sinA, cosB, sinB, p.rBase * p.size, p.rDepth * p.size, p.inkFar, p.inkSpan, n);
    }
  }
  return n;
}

uint16_t ThinkingOrb::emitWave(float t) {
  const Profile& p = profileFor(mode_);
  const float cosA = cosf(t * 0.5f), sinA = sinf(t * 0.5f);
  const float cosB = cosf(0.36f), sinB = sinf(0.36f);

  uint16_t n = 0;
  for (uint8_t i = 0; i < latRings_; ++i) {
    const float u = (i + 0.5f) / latRings_;
    const float phi = u * (float)M_PI;
    // The listening state: each ring swells on its own phase, so the sphere looks like it is
    // reacting to something rather than simply spinning.
    const float swell = 1.0f + 0.10f * sinf(t * 2.2f - u * 6.0f);
    const float sinPhi = sinf(phi) * swell, cosPhi = cosf(phi) * swell;
    const uint8_t ringPoints = (uint8_t)fmaxf(3.0f, roundf(lonDensity_ * sinf(phi)));
    for (uint8_t j = 0; j < ringPoints; ++j) {
      const float theta = (j / (float)ringPoints) * 2.0f * (float)M_PI;
      project(sinPhi * cosf(theta), cosPhi, sinPhi * sinf(theta),
              cosA, sinA, cosB, sinB, p.rBase * p.size, p.rDepth * p.size, p.inkFar, p.inkSpan, n);
    }
  }
  return n;
}

uint16_t ThinkingOrb::emitRing(float t) {
  const Profile& p = profileFor(mode_);
  // Face-on: no yaw, so the lanes read as concentric rather than as a tilted sphere. This is the
  // idle state and should look like it is waiting, not working.
  const float cosA = 1.0f, sinA = 0.0f;
  const float cosB = 1.0f, sinB = 0.0f;

  uint16_t n = 0;
  const uint8_t lanes = latRings_;
  for (uint8_t i = 0; i < lanes; ++i) {
    const float laneR = 0.35f + 0.62f * ((i + 1) / (float)lanes);
    const float breathe = 1.0f + 0.045f * sinf(t * 1.1f - i * 0.55f);
    const uint8_t segs = lonDensity_;
    for (uint8_t j = 0; j < segs; ++j) {
      const float theta = (j / (float)segs) * 2.0f * (float)M_PI + t * (0.18f + i * 0.05f);
      project(cosf(theta) * laneR * breathe, sinf(theta) * laneR * breathe, 0.15f * sinf(theta * 2.0f),
              cosA, sinA, cosB, sinB, p.rBase * p.size, p.rDepth * p.size, p.inkFar, p.inkSpan, n);
    }
  }
  return n;
}

uint16_t ThinkingOrb::emitOrbits(float t) {
  const Profile& p = profileFor(mode_);
  const float cosB = cosf(0.5f), sinB = sinf(0.5f);

  uint16_t n = 0;
  const uint8_t orbits = 7;
  const uint8_t perOrbit = (uint8_t)std::max(6, std::min(40, capacity_ / (orbits + 1)));
  for (uint8_t o = 0; o < orbits; ++o) {
    const float incl = (o / (float)orbits) * (float)M_PI;
    const float cosI = cosf(incl), sinI = sinf(incl);
    for (uint8_t j = 0; j < perOrbit; ++j) {
      const float a = (j / (float)perOrbit) * 2.0f * (float)M_PI + t * (0.6f + o * 0.09f);
      // A circle in the XZ plane, tipped by the orbit's inclination.
      const float x = cosf(a);
      const float z = sinf(a) * cosI;
      const float y = sinf(a) * sinI;
      project(x, y, z, cosf(t * 0.25f), sinf(t * 0.25f), cosB, sinB,
              p.rBase * p.size, p.rDepth * p.size, p.inkFar, p.inkSpan, n);
    }
  }
  return n;
}

uint16_t ThinkingOrb::emitWeb(float t) {
  const Profile& p = profileFor(mode_);
  const float cosA = cosf(t * 0.7f), sinA = sinf(t * 0.7f);
  const float cosB = cosf(0.4f), sinB = sinf(0.4f);

  uint16_t n = 0;
  // A Fibonacci sphere rather than a lat/lon grid: connecting should look like scattered nodes,
  // and an even grid reads as structure the state does not have.
  const uint16_t nodes = (uint16_t)std::min<uint16_t>(capacity_, 120);
  const float golden = (float)M_PI * (3.0f - sqrtf(5.0f));
  for (uint16_t i = 0; i < nodes; ++i) {
    const float y = 1.0f - (i / (float)(nodes - 1)) * 2.0f;
    const float r = sqrtf(fmaxf(0.0f, 1.0f - y * y));
    const float theta = golden * i;
    // Nodes pulse in and out so the constellation looks like it is establishing links.
    const float pulse = 0.92f + 0.12f * sinf(t * 2.6f + i * 0.7f);
    project(cosf(theta) * r * pulse, y * pulse, sinf(theta) * r * pulse,
            cosA, sinA, cosB, sinB, p.rBase * p.size, p.rDepth * p.size, p.inkFar, p.inkSpan, n);
  }
  return n;
}

OrbFrame ThinkingOrb::render(uint32_t elapsedMs) {
  if (!dots_ || !scratch) return {nullptr, 0};

  const Profile& p = profileFor(mode_);
  const float t = (elapsedMs / 1000.0f) * p.speed * speed_;

  uint16_t n = 0;
  switch (mode_) {
    case OrbMode::Globe:  n = emitGlobe(t);  break;
    case OrbMode::Wave:   n = emitWave(t);   break;
    case OrbMode::Ring:   n = emitRing(t);   break;
    case OrbMode::Orbits: n = emitOrbits(t); break;
    case OrbMode::Web:    n = emitWeb(t);    break;
  }

  // Painter's order: far to near, so a near dot overwrites the one behind it. Without this the
  // sphere loses its solidity and reads as a flat cloud.
  std::sort(scratch, scratch + n, [](const Scratch& a, const Scratch& b) { return a.z < b.z; });
  for (uint16_t i = 0; i < n; ++i) dots_[i] = scratch[i].dot;

  return {dots_, n};
}

OrbMode orbModeForAgentState(const String& state) {
  if (state == "running" || state == "working" || state == "dispatched") return OrbMode::Orbits;
  if (state == "searching" || state == "thinking") return OrbMode::Globe;
  if (state == "listening" || state == "recording") return OrbMode::Wave;
  if (state == "connecting" || state == "pairing") return OrbMode::Web;
  return OrbMode::Ring;
}

const char* orbLabelForMode(OrbMode mode) {
  switch (mode) {
    case OrbMode::Orbits: return "Working";
    case OrbMode::Globe:  return "Thinking";
    case OrbMode::Wave:   return "Listening";
    case OrbMode::Web:    return "Connecting";
    case OrbMode::Ring:   return "Ready";
  }
  return "Ready";
}
