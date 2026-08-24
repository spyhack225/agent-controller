#include "ThinkingOrb.h"

#include <algorithm>
#include <math.h>

// Ported from Thinking Orbs by Jakub Antalik.
//   https://orbs.jakubantalik.com  ·  https://github.com/Jakubantalik/Libraries
//   MIT License, Copyright (c) 2026 Jakub Antalik.
//
// Ported from the engine sources (src/engine/{core,lattice,web}.ts), not from the spec JSON alone.
// The spec gives the tuning constants; the engine gives what they mean, and an earlier pass here
// guessed wrong about three of them:
//
//   * rsPow is the exponent of radiusScale(size) = (size/300)^pow — a sub-linear correction so a
//     small orb keeps legible dots — NOT an exponent applied to depth.
//   * radius is LINEAR in depth: (rBase + rDepth * depth) * radiusScale.
//   * ink is `white = inkFar - inkSpan * depth`, where `white` is ink-on-paper and a dark ground
//     mirrors it to (1 - white). Near dots end bright, far dots genuinely dim.
//
// The motion detail matters as much as the geometry. Globe's tilt breathes rather than sitting
// still, and a scan meridian sweeps the sphere swelling dots as it passes. Web's nodes wander under
// value noise instead of sitting on a fixed lattice. Those are what make it read as alive rather
// than as a spinning model, and they are cheap.
//
// Divergences from the web original, all forced by the target:
//   * Density scales to a dot budget as well as size: a browser affords 750 dots at 60fps, a
//     240 MHz Xtensa pushing SPI does not.
//   * Output is fixed-point (sixteenths of a pixel) rather than float, so the painter can
//     anti-alias without the geometry step rounding first.
//   * No per-dot alpha blending against arbitrary content — the ground is uniform, so alpha folds
//     into coverage in the painter.

namespace {

struct Profile {
  uint8_t latRings;
  uint8_t lonDensity;
  float rBase;
  float rDepth;
  float inkFar;
  float inkSpan;
  float speed;     // multiplies elapsed seconds before any mode maths
  float count;     // density multiplier
  float rsPow;     // exponent of radiusScale
  float dimBase;   // layers below the highlight fade to this
};

constexpr float kRMin = 0.3f;
constexpr float kCullAlpha = 0.02f;
constexpr float kPi = 3.14159265358979f;

const Profile kProfiles[] = {
  // Orbits — working
  { 0,  0,   1.20f, 1.60f, 0.55f, 0.45f, 1.885f, 1.00f, 0.6f, 1.00f },
  // Globe — searching/thinking
  { 17, 44,  0.60f, 1.70f, 0.62f, 0.54f, 2.015f, 1.00f, 0.6f, 0.45f },
  // Wave — listening
  { 15, 40,  0.60f, 1.70f, 0.62f, 0.54f, 4.388f, 0.90f, 0.6f, 1.00f },
  // Ring — breathing/idle
  { 5,  88,  1.10f, 1.70f, 0.60f, 0.50f, 1.200f, 0.85f, 0.6f, 1.00f },
  // Web — connecting
  { 0,  0,   1.40f, 1.80f, 0.55f, 0.45f, 2.400f, 1.00f, 0.6f, 1.00f },
};

const Profile& profileFor(OrbMode m) { return kProfiles[static_cast<uint8_t>(m)]; }

struct Scratch {
  OrbDot dot;
  float z;
};

Scratch* scratch = nullptr;

// Deterministic hash in [0,1), and smooth value noise on a 2D lattice. Web's nodes drift under
// this rather than sitting on their lattice positions, which is the difference between a
// constellation that is alive and one that is merely rotating.
float hashD(float a, float b) {
  const float h = sinf(a * 12.9898f + b * 78.233f) * 43758.5453f;
  return h - floorf(h);
}

float vnoise(float x, float y) {
  const float xi = floorf(x), yi = floorf(y);
  float fx = x - xi, fy = y - yi;
  fx = fx * fx * (3.0f - 2.0f * fx);
  fy = fy * fy * (3.0f - 2.0f * fy);
  const float a = hashD(xi, yi);
  const float b = hashD(xi + 1, yi);
  const float c = hashD(xi, yi + 1);
  const float d = hashD(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Shortest signed angular distance, wrapped to (-pi, pi].
float angleDelta(float a, float b) { return atan2f(sinf(a - b), cosf(a - b)); }

void fibDir(int i, int n, float& x, float& y, float& z) {
  const float golden = kPi * (3.0f - sqrtf(5.0f));
  y = 1.0f - (2.0f * (i + 0.5f)) / n;
  const float rad = sqrtf(fmaxf(0.0f, 1.0f - y * y));
  const float a = i * golden;
  x = rad * cosf(a);
  z = rad * sinf(a);
}

inline uint8_t clamp8(float v) {
  if (v <= 0.0f) return 0;
  if (v >= 255.0f) return 255;
  return (uint8_t)lroundf(v);
}

// `white` is ink-on-paper, 0 = darkest. The ground here is dark, so it mirrors.
inline uint8_t inkFromWhite(float white) {
  if (white < 0.0f) white = 0.0f;
  if (white > 1.0f) white = 1.0f;
  return clamp8((1.0f - white) * 255.0f);
}

inline int16_t toFixed(float px) {
  const float v = px * 16.0f;
  if (v < -32000.0f) return -32000;
  if (v > 32000.0f) return 32000;
  return (int16_t)lroundf(v);
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
  lines_ = (OrbLine*)malloc(sizeof(OrbLine) * kMaxLines);
  if (!dots_ || !scratch || !lines_) {
    end();
    return false;
  }

  buildGeometry();
  return true;
}

void ThinkingOrb::end() {
  free(dots_);   dots_ = nullptr;
  free(scratch); scratch = nullptr;
  free(lines_);  lines_ = nullptr;
  capacity_ = 0;
  lineCount_ = 0;
}

void ThinkingOrb::setMode(OrbMode mode) {
  if (mode == mode_) return;
  mode_ = mode;
  buildGeometry();
}

// The reference scales a lat/lon pair by sqrt(count) so both axes thin evenly and the sphere stays
// a sphere. The dot budget is applied the same way.
void ThinkingOrb::buildGeometry() {
  const Profile& p = profileFor(mode_);
  if (p.latRings == 0) {
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

void ThinkingOrb::setProjection(float yaw, float tilt, float scale) {
  cosYaw_ = cosf(yaw);   sinYaw_ = sinf(yaw);
  cosTilt_ = cosf(tilt); sinTilt_ = sinf(tilt);
  scale_ = scale;
}

// Returns screen offset from the centre, plus depth in 0..1. The clamp is load-bearing: modes that
// breathe push points slightly off the unit sphere, and a fractionally negative depth used to reach
// powf() as a NaN and come back as a dot the width of the canvas.
bool ThinkingOrb::projectPoint(float x, float y, float z, float& px, float& py, float& depth) const {
  const float x1 = x * cosYaw_ + z * sinYaw_;
  const float z1 = -x * sinYaw_ + z * cosYaw_;
  const float y1 = y * cosTilt_ - z1 * sinTilt_;
  const float z2 = y * sinTilt_ + z1 * cosTilt_;

  px = x1 * scale_;
  py = -y1 * scale_;          // screen Y grows downward
  depth = (z2 + 1.0f) * 0.5f;
  if (depth < 0.0f) depth = 0.0f;
  if (depth > 1.0f) depth = 1.0f;
  return true;
}

float ThinkingOrb::radiusScale() const {
  // Radii were tuned for a 300 pt frame; sub-linear scaling keeps a small orb legible.
  const Profile& p = profileFor(mode_);
  return powf(diameter_ / 300.0f, p.rsPow);
}

void ThinkingOrb::pushDot(float px, float py, float z01, float radiusPx, float white, float alpha,
                          uint16_t& n) {
  if (n >= capacity_) return;
  if (alpha < kCullAlpha) return;

  float r = radiusPx < kRMin ? kRMin : radiusPx;
  const long r16 = lroundf(r * 16.0f);
  const long bounded = r16 < 5L ? 5L : (r16 > 160L ? 160L : r16);

  Scratch& s = scratch[n++];
  s.z = z01;
  s.dot.x16 = toFixed(px);
  s.dot.y16 = toFixed(py);
  s.dot.r16 = (uint8_t)bounded;
  s.dot.ink = inkFromWhite(white);
  s.dot.alpha = clamp8(alpha * 255.0f);
}

// --- Globe: a lat/long field with a scan meridian sweeping it ---------------------------------
uint16_t ThinkingOrb::emitGlobe(float t) {
  const Profile& p = profileFor(mode_);
  const float spin = 0.5f;
  // The tilt breathes. A fixed tilt reads as a model on a turntable; this reads as something alive.
  const float tilt = 0.4f + 0.06f * sinf(t * 0.35f);
  setProjection(t * spin, tilt, radiusPx_ * 0.82f);

  const float scan = t * (spin + (1.7f - spin) * 4.08f);
  const float rs = radiusScale();

  uint16_t n = 0;
  for (uint8_t li = 0; li <= latRings_; ++li) {
    const float lat = -kPi / 2.0f + ((float)li / latRings_) * kPi;
    const float cosLat = cosf(lat), sinLat = sinf(lat);
    const uint16_t lonCount = (uint16_t)fmaxf(1.0f, roundf(fabsf(cosLat) * lonDensity_));
    for (uint16_t lj = 0; lj < lonCount; ++lj) {
      const float lon = ((float)lj / lonCount) * 2.0f * kPi;
      float px, py, depth;
      projectPoint(cosLat * cosf(lon), sinLat, cosLat * sinf(lon), px, py, depth);

      // The scan reads as a size ripple rather than a shine, so it survives a panel with no
      // gradients at all.
      const float d = angleDelta(lon + t * spin, scan);
      const float zSigned = depth * 2.0f - 1.0f;
      const float boost = expf(-(d * d) / 0.18f) * fmaxf(0.0f, zSigned);

      pushDot(px, py, depth,
              (p.rBase + p.rDepth * depth + boost) * rs,
              p.inkFar - p.inkSpan * depth,
              p.dimBase + (1.0f - p.dimBase) * fminf(1.0f, boost),
              n);
    }
  }
  return n;
}

// --- Wave: the same field, rings breathing with amplitude ------------------------------------
uint16_t ThinkingOrb::emitWave(float t) {
  const Profile& p = profileFor(mode_);
  setProjection(t * 0.4f, 0.36f + 0.05f * sinf(t * 0.3f), radiusPx_ * 0.82f);
  const float rs = radiusScale();

  uint16_t n = 0;
  for (uint8_t li = 0; li <= latRings_; ++li) {
    const float u = (float)li / latRings_;
    const float lat = -kPi / 2.0f + u * kPi;
    const float cosLat = cosf(lat), sinLat = sinf(lat);
    const uint16_t lonCount = (uint16_t)fmaxf(1.0f, roundf(fabsf(cosLat) * lonDensity_));

    // The swell rides the RADIUS, not the position. Displacing points off the unit sphere is what
    // produced out-of-range depths; amplitude belongs in how big a dot is, not where it is.
    const float swell = 1.0f + 0.35f * sinf(t * 2.2f - u * 6.0f);

    for (uint16_t lj = 0; lj < lonCount; ++lj) {
      const float lon = ((float)lj / lonCount) * 2.0f * kPi;
      float px, py, depth;
      projectPoint(cosLat * cosf(lon), sinLat, cosLat * sinf(lon), px, py, depth);
      pushDot(px, py, depth,
              (p.rBase + p.rDepth * depth) * swell * rs,
              p.inkFar - p.inkSpan * depth,
              1.0f, n);
    }
  }
  return n;
}

// --- Ring: face-on concentric lanes, the calm state -------------------------------------------
uint16_t ThinkingOrb::emitRing(float t) {
  const Profile& p = profileFor(mode_);
  setProjection(0.0f, 0.0f, radiusPx_ * 0.82f);
  const float rs = radiusScale();

  uint16_t n = 0;
  const uint8_t lanes = latRings_;
  for (uint8_t i = 0; i < lanes; ++i) {
    const float laneR = 0.34f + 0.60f * ((i + 1) / (float)lanes);
    const float breathe = 1.0f + 0.04f * sinf(t * 0.9f - i * 0.55f);
    const uint16_t segs = lonDensity_;
    for (uint16_t j = 0; j < segs; ++j) {
      const float theta = ((float)j / segs) * 2.0f * kPi + t * (0.14f + i * 0.035f);
      const float rr = laneR * breathe;
      float px, py, depth;
      projectPoint(cosf(theta) * rr, sinf(theta) * rr, 0.0f, px, py, depth);
      // Face-on has no real depth, so brightness travels around each lane instead.
      const float phase = 0.5f + 0.5f * sinf(theta * 2.0f - t * 1.1f);
      pushDot(px, py, depth,
              (p.rBase + p.rDepth * 0.45f) * rs,
              p.inkFar - p.inkSpan * phase,
              0.55f + 0.45f * phase, n);
    }
  }
  return n;
}

// --- Orbits: particles riding inclined rings ---------------------------------------------------
uint16_t ThinkingOrb::emitOrbits(float t) {
  const Profile& p = profileFor(mode_);
  setProjection(t * 0.25f, 0.5f, radiusPx_ * 0.82f);
  const float rs = radiusScale();

  uint16_t n = 0;
  const uint8_t orbits = 7;
  const uint16_t perOrbit = (uint16_t)std::max(8, std::min(44, capacity_ / (orbits + 1)));
  for (uint8_t o = 0; o < orbits; ++o) {
    const float incl = ((float)o / orbits) * kPi;
    const float cosI = cosf(incl), sinI = sinf(incl);
    for (uint16_t j = 0; j < perOrbit; ++j) {
      const float a = ((float)j / perOrbit) * 2.0f * kPi + t * (0.55f + o * 0.08f);
      float px, py, depth;
      projectPoint(cosf(a), sinf(a) * sinI, sinf(a) * cosI, px, py, depth);
      pushDot(px, py, depth,
              (p.rBase + p.rDepth * depth) * rs,
              p.inkFar - p.inkSpan * depth,
              0.35f + 0.65f * depth, n);
    }
  }
  return n;
}

// --- Web: a constellation wiring itself --------------------------------------------------------
uint16_t ThinkingOrb::emitWeb(float t) {
  const Profile& p = profileFor(mode_);
  // Barely turning. "Connecting" is about the links forming, not about rotation.
  setProjection(t * 0.12f, 0.32f, radiusPx_ * 0.80f);
  const float rs = radiusScale();

  constexpr int kNodes = 30;
  constexpr float kThr = 0.72f;
  float nx[kNodes], ny[kNodes], nz[kNodes];

  for (int i = 0; i < kNodes; ++i) {
    float dx, dy, dz;
    fibDir(i, kNodes, dx, dy, dz);
    // Slow noise wander, renormalised back onto the surface. This is the organic part: the lattice
    // gives an even spread, the noise stops it looking manufactured.
    float x = dx + 0.3f * (vnoise(i * 0.31f + 9.0f, t * 0.24f) - 0.5f) * 2.0f;
    float y = dy + 0.3f * (vnoise(i * 0.53f + 27.0f, t * 0.21f) - 0.5f) * 2.0f;
    float z = dz + 0.3f * (vnoise(i * 0.77f + 55.0f, t * 0.27f) - 0.5f) * 2.0f;
    const float l = fmaxf(1e-6f, sqrtf(x * x + y * y + z * z));
    nx[i] = x / l; ny[i] = y / l; nz[i] = z / l;
  }

  // Edges between close neighbours, faded by proximity and depth.
  lineCount_ = 0;
  for (int i = 0; i < kNodes && lineCount_ < kMaxLines; ++i) {
    for (int j = i + 1; j < kNodes && lineCount_ < kMaxLines; ++j) {
      const float dx = nx[i] - nx[j], dy = ny[i] - ny[j], dz = nz[i] - nz[j];
      const float dist = sqrtf(dx * dx + dy * dy + dz * dz);
      if (dist >= kThr) continue;

      float ax, ay, ad, bx, by, bd;
      projectPoint(nx[i], ny[i], nz[i], ax, ay, ad);
      projectPoint(nx[j], ny[j], nz[j], bx, by, bd);
      const float depth = (ad + bd) * 0.5f;
      const float alpha = (1.0f - dist / kThr) * (0.3f + 0.55f * depth);
      if (alpha < kCullAlpha) continue;

      OrbLine& L = lines_[lineCount_++];
      L.x16a = toFixed(ax); L.y16a = toFixed(ay);
      L.x16b = toFixed(bx); L.y16b = toFixed(by);
      L.ink = inkFromWhite(0.42f);
      L.alpha = clamp8(alpha * 255.0f);
      L.w16 = (uint8_t)std::max(10L, lroundf(0.8f * rs * 16.0f));
    }
  }

  uint16_t n = 0;
  for (int i = 0; i < kNodes; ++i) {
    float px, py, depth;
    projectPoint(nx[i], ny[i], nz[i], px, py, depth);
    // Pulse on the radius, never on the position.
    const float pulse = 1.0f + 0.25f * sinf(t * 1.4f + i * 2.7f);
    pushDot(px, py, depth, (p.rBase + p.rDepth * depth) * pulse * rs,
            0.55f - 0.45f * depth, 1.0f, n);
  }

  // Signals: bright packets running between re-picked pairs. Small, but they are what make the
  // constellation look like it is doing something rather than merely existing.
  constexpr int kSignals = 5;
  for (int s = 0; s < kSignals; ++s) {
    const float seg = floorf(t * 0.55f + s * 7.31f);
    const int a = (int)(hashD(seg, s * 3.1f + 1.7f) * kNodes) % kNodes;
    const int b = (int)(hashD(seg, s * 5.7f + 4.2f) * kNodes) % kNodes;
    if (a == b) continue;
    const float f = (t * 0.55f + s * 7.31f) - seg;
    float x = nx[a] + (nx[b] - nx[a]) * f;
    float y = ny[a] + (ny[b] - ny[a]) * f;
    float z = nz[a] + (nz[b] - nz[a]) * f;
    const float l = fmaxf(1e-6f, sqrtf(x * x + y * y + z * z));
    float px, py, depth;
    projectPoint(x / l, y / l, z / l, px, py, depth);
    pushDot(px, py, depth, (p.rBase * 1.5f + p.rDepth * depth) * rs,
            0.05f, 0.5f + 0.5f * depth, n);
  }
  return n;
}

OrbFrame ThinkingOrb::render(uint32_t elapsedMs) {
  if (!dots_ || !scratch) return {nullptr, 0, nullptr, 0};

  const Profile& p = profileFor(mode_);
  const float t = (elapsedMs / 1000.0f) * p.speed * speed_;

  lineCount_ = 0;
  uint16_t n = 0;
  switch (mode_) {
    case OrbMode::Globe:  n = emitGlobe(t);  break;
    case OrbMode::Wave:   n = emitWave(t);   break;
    case OrbMode::Ring:   n = emitRing(t);   break;
    case OrbMode::Orbits: n = emitOrbits(t); break;
    case OrbMode::Web:    n = emitWeb(t);    break;
  }

  // Painter's order: far to near, so a near dot overwrites the one behind it.
  std::sort(scratch, scratch + n, [](const Scratch& a, const Scratch& b) { return a.z < b.z; });
  for (uint16_t i = 0; i < n; ++i) dots_[i] = scratch[i].dot;

  return {dots_, n, lines_, lineCount_};
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
