#include "ui.h"

#include <GatewayBrowse.h>
#include <MediaUpload.h>
#include <ThinkingOrb.h>

#include "audio.h"
#include "display.h"
#include "gatewayProbe.h"
#include "ui_paint.h"

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#ifndef ORB_BENCH
#define ORB_BENCH 0
#endif
#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "ips28-esp32-s3r8"
#endif
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif

// The visual language is the orb's, not a dashboard's.
//
// The orb is an anti-aliased point cloud with no straight edge anywhere in it. Everything that used
// to be drawn beside it was a hard-cornered fill and a one-pixel rule, which is two products on one
// piece of glass. Every shape below now goes through uip::/displaySoft*, which composite a distance
// field: rounded, feathered, and curved where there used to be a rule. Clearing a band is still a
// rectangle, because that is invisible.
//
// Layout, 240x320:
//
//   0        header: device name, back, and the handle that pulls the status drawer down
//   52       (curved divider, with the pull grabber sitting above its low point)
//   56       content
//   262      action bar, WHEN there is something to press — otherwise content runs to 320
//   320
//
// Two things move and nothing else does: the status drawer slides down out of the header, and the
// action bar rises out of the bottom edge. Both are eased. The content underneath is repainted on
// change, which is what keeps a list screen inside the frame budget.

namespace {

using uip::Rect;
using uip::kBg;
using uip::kBright;
using uip::kHair;
using uip::kMuted;
using uip::kSurface;
using uip::kSurfaceHi;
using uip::kText;
using uip::kCols1;
using uip::kCols2;

constexpr int16_t kW = uip::kW;
constexpr int16_t kH = uip::kH;

constexpr int16_t kHeaderH = 52;
constexpr int16_t kContentTop = 56;

// The action bar's full height when it is all the way out. It overlays the content rather than
// resizing it every frame: the content region is recomputed only when the bar's presence changes,
// which is twice per appearance rather than once per frame.
constexpr int16_t kBarH = 58;

// ~30 fps. The orb maths and the panel blit together measure ~27 ms on this board, so this is the
// cadence the hardware can actually hold rather than an aspiration.
constexpr uint32_t kFrameMs = 33;

// Slide durations. Both are deliberately shorter than a beat and longer than a frame: under about
// 120 ms an eased slide is indistinguishable from a jump, and over about 300 ms the device feels
// like it is thinking about it.
constexpr uint32_t kDrawerSlideMs = 220;
constexpr uint32_t kBarSlideMs = 170;

// The home orb, and the one that keeps a list screen from looking frozen. 148 px is the measured
// budget; 44 px costs about a twentieth of it, which is what makes "keep animating during a list"
// affordable rather than a trade against the list itself.
constexpr uint16_t kOrbPx = 148;
constexpr uint16_t kMiniOrbPx = 44;

constexpr int16_t kOrbCx = kW / 2;
constexpr int16_t kOrbCy = 132;
constexpr int16_t kLabelY = 210;
constexpr int16_t kHomeThreadY = 234;
constexpr int16_t kHomeDetailY = 252;

// Deliberately not tighter to the right edge: the blit is 44 px wide and centred, so a smaller cx
// would push setAddrWindow past the panel, and a smaller cy would push it negative.
constexpr int16_t kMiniOrbCx = kW - 32;
constexpr int16_t kMiniOrbCy = 22;

enum class Screen : uint8_t {
  Status, Home, Threads, Send, Response, Approvals, Environments, Projects, Device, Gateway
};
enum class Modal : uint8_t { None, ConfirmControl, ConfirmApproval, ConfirmReprovision };

// What the action bar can offer. Every one of these is something the person can do RIGHT NOW on
// the screen they are looking at; there is no entry here that navigates for its own sake, because
// that is what the drawer is for.
enum class Act : uint8_t {
  None, Review, Retry, Talk, PickThread, Reload, PrevPage, NextPage, Refresh,
  Approve, Reject, NextApproval, SendClip, DiscardClip, Portal, Reprovision,
  ConfirmYes, ConfirmNo, OpenReply
};

struct Action {
  Act id = Act::None;
  const char* label = "";
  bool primary = false;
  bool enabled = true;
};

// Three is what fits at 240 px with a capsule each and still leaves a label readable at arm's
// length. A fourth belongs in the drawer or on the screen itself.
constexpr uint8_t kMaxActions = 3;

// The drawer's categories. Each one is a fact about the device AND the way to the screen that acts
// on it — the two were previously separate ideas, one in a tab and one nowhere.
enum class Row : uint8_t { Device, Gateway, Thread, Activity };

constexpr uint8_t kMaxDrawerRows = 4;
constexpr int16_t kDrawerRowH = 46;

GatewayClient* gw = nullptr;
Provisioning* prov = nullptr;
DeviceStore* store = nullptr;

// Its own translation unit's state, deliberately: GatewayClient is shared with three other boards
// and is not the place to grow a browser while it is being worked on elsewhere.
GatewayBrowse browse;

ThinkingOrb orb;
ThinkingOrb miniOrb;
bool orbReady = false;
bool miniReady = false;
uint32_t orbStartedAt = 0;
OrbMode currentMode = OrbMode::Ring;

Screen screen = Screen::Status;
Modal modal = Modal::None;

DeviceControl pendingControl;
String pendingApprovalId;
String pendingApprovalSummary;
size_t approvalIndex = 0;

int16_t threadScroll = 0;
int16_t actionScroll = 0;
int16_t envScroll = 0;
int16_t projectScroll = 0;

// One line of feedback for whatever the person just did. Deliberately not the display payload's
// line2 — that is the account's last command, which is a different fact and arrives up to 5 s late.
String message;

String statusLabel = "Starting";
String shownLabel;
bool chromeDirty = true;
bool contentDirty = true;

uint32_t lastRevision = 0;
uint32_t lastBrowseRevision = 0;
Screen lastScreen = Screen::Status;
Modal lastModal = Modal::None;
GatewayLink lastLink = GatewayLink::Idle;
ProvisioningState lastProvState = ProvisioningState::Unprovisioned;
size_t lastApprovalCount = 0;

// Push-to-talk state. `recordArmed` is the press that landed on the microphone button; the
// recording itself runs in uiTick() so the loop keeps polling touch and can see the finger lift.
bool recordArmed = false;
uint32_t recordPaintedAt = 0;

// A finished clip is HELD, not sent.
//
// The old behaviour uploaded and dispatched the moment the finger lifted, which means the only way
// to cancel a voice note recorded by accident was to let it reach the agent and then stop the turn.
// Holding it is what gives the action bar something to be: SEND and DISCARD, on a clip whose length
// is on screen.
bool clipHeld = false;
uint32_t clipHeldMs = 0;

// The status drawer. `drawerT` is the eased 0..1 position and `drawerShownPx` is how much of it is
// currently ON the glass, which is what makes the slide incremental rather than a full repaint per
// frame.
bool drawerOpen = false;
float drawerT = 0.0f;
int16_t drawerShownPx = 0;
bool drawerDirty = false;
uint8_t drawerRowCount = 0;
Row drawerRows[kMaxDrawerRows];

// The action bar. `barT` eases; `barReserved` is whether the content region currently stops short
// of the bottom, and only that second flag costs a content repaint.
Action actions[kMaxActions];
uint8_t actionCount = 0;
uint32_t actionSignature = 0;
float barT = 0.0f;
bool barReserved = false;
bool barDirty = false;

// A finger that came down in the header is pulling the drawer, wherever it ends up. Decided on the
// press rather than on each drag, because a drag that starts in a list and wanders into the header
// is a scroll, not a pull.
bool dragFromHeader = false;

// Frame statistics. Draw time alone was not enough to explain a visible hitch — it stayed at 27 ms
// while the animation still stumbled — so the interval BETWEEN frames is measured as well as the
// work inside one, and anything that blocks (a gateway call, the captive portal, DNS) shows up as a
// gap even though it never touches the renderer.
struct FrameStats {
  uint32_t frames = 0;
  uint32_t worstDrawMs = 0;
  uint32_t worstGapMs = 0;
  uint32_t hitches = 0;
  float fps = 0.0f;
  uint32_t worstGapEverMs = 0;
  uint32_t hitchesEver = 0;
};

FrameStats stats;
uint32_t lastFrameAt = 0;
uint32_t nextFrameAt = 0;

#if ORB_BENCH
uint8_t benchIndex = 0;
uint32_t benchNextAt = 0;
#endif

// ---------------------------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------------------------

Adafruit_ILI9341& g() { return displayPanel(); }

bool operable() {
  return gw != nullptr && gw->link() == GatewayLink::Claimed;
}

bool unclaimed() {
  return gw != nullptr && gw->link() == GatewayLink::Unclaimed;
}

// Where the content stops. Recomputed only when the bar's presence changes, and the change is what
// dirties the content — a bar that is mid-slide does not reflow a list underneath it.
int16_t contentBottom() { return barReserved ? (int16_t)(kH - kBarH) : kH; }

// Clears only as far as the content actually extends. The action bar owns the bottom band while it
// is out, and a content repaint that erased it would fight the bar for the same pixels every time a
// list changed underneath it.
void clearContent() {
  g().fillRect(0, kContentTop, kW, (int16_t)(contentBottom() - kContentTop), panelGrey(kBg));
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

// The device's own name, which is what the owner called it in the console — `device.label`, carried
// to the hardware as the display payload's title. "AGENT CONTROLLER" was the product's name, not
// this unit's, and on a desk with two of them it identified neither.
String deviceName() {
  if (gw) {
    const String& title = gw->display().title;
    // Both of these are the fallback the gateway or the parser substituted, not a name anybody
    // chose, so neither is worth showing over the device's own id.
    if (title.length() > 0 && title != "Controller" && title != "Agent Controller") return title;
  }
  if (store) {
    const String& id = store->deviceId();
    if (id.length() >= 4) return String("Controller ") + id.substring(id.length() - 4);
  }
  return String("Controller");
}

// ---------------------------------------------------------------------------------------------
// Status rows
// ---------------------------------------------------------------------------------------------

const char* rowTitle(Row row) {
  switch (row) {
    case Row::Device:   return "DEVICE";
    case Row::Gateway:  return "GATEWAY";
    case Row::Thread:   return "THREAD";
    default:            return "ACTIVITY";
  }
}

String rowValue(Row row) {
  switch (row) {
    case Row::Device: {
      if (!prov) return String("Unknown");
      switch (prov->status().state) {
        case ProvisioningState::Provisioning: return String("Setup portal open");
        case ProvisioningState::Connecting:   return String("Joining Wi-Fi");
        case ProvisioningState::Failed:       return String("Wi-Fi failed");
        case ProvisioningState::Unprovisioned: return String("No Wi-Fi saved");
        default: break;
      }
      if (!gw) return String("Online");
      switch (gw->link()) {
        case GatewayLink::Claimed:    return String("Claimed and online");
        case GatewayLink::Unclaimed:  return String("Waiting to be claimed");
        case GatewayLink::Revoked:    return String("Access revoked");
        case GatewayLink::NoIdentity: return String("No identity flashed");
        default:                      return String("Online");
      }
    }
    case Row::Gateway: {
      if (!gw) return String("Not configured");
      if (gw->link() == GatewayLink::Unreachable) return String("No answer");
      const GatewayStatus probe = gatewayStatus();
      if (probe == GatewayStatus::Unreachable || probe == GatewayStatus::BadResponse) {
        return String(gatewayStatusText(probe));
      }
      if (!store || store->gatewayUrl().length() == 0) return String("No URL set");
      return String("Reachable");
    }
    case Row::Thread: {
      if (!gw) return String("None");
      if (!gw->hasThread()) return String("None selected");
      return gw->selectedThreadLabel();
    }
    default: {
      if (!gw) return String("Nothing yet");
      const size_t approvals = gw->approvalCount();
      if (approvals > 0) return String(approvals) + " awaiting approval";
      if (gw->responseOpen() && gw->responseInFlight()) return String("Agent is working");
      const String& line = gw->display().line2;
      return line.length() > 0 ? line : String("Nothing yet");
    }
  }
}

// A row's own health, which is the only thing the little dot beside it says. Bright is "needs you",
// muted is fine, hair is "not applicable yet".
uint8_t rowTone(Row row) {
  switch (row) {
    case Row::Device:
      if (!gw) return kHair;
      return (gw->link() == GatewayLink::Claimed) ? kMuted : kBright;
    case Row::Gateway: {
      if (!gw) return kHair;
      if (gw->link() == GatewayLink::Unreachable) return kBright;
      const GatewayStatus probe = gatewayStatus();
      if (probe == GatewayStatus::Unreachable || probe == GatewayStatus::BadResponse) return kBright;
      return kMuted;
    }
    case Row::Thread:
      if (!gw) return kHair;
      return gw->hasThread() ? kMuted : kBright;
    default:
      if (!gw) return kHair;
      return gw->approvalCount() > 0 ? kBright : kMuted;
  }
}

// Only the rows this device's situation justifies.
//
// A unit that has never been claimed has no thread and no activity — every route behind both
// answers 403 — so offering them would be offering two dead ends. The device and the gateway rows
// are always there because they are exactly what is wrong when the other two are missing.
void rebuildDrawerRows() {
  const uint8_t before = drawerRowCount;
  Row previous[kMaxDrawerRows];
  for (uint8_t i = 0; i < before && i < kMaxDrawerRows; ++i) previous[i] = drawerRows[i];

  drawerRowCount = 0;
  drawerRows[drawerRowCount++] = Row::Device;
  drawerRows[drawerRowCount++] = Row::Gateway;
  if (operable()) {
    // Bounds-checked against drawerRows, which is the array being written — not against
    // kMaxDrawerRows-as-a-guess about how many categories exist.
    if (drawerRowCount < kMaxDrawerRows) drawerRows[drawerRowCount++] = Row::Thread;
    if (drawerRowCount < kMaxDrawerRows) drawerRows[drawerRowCount++] = Row::Activity;
  }

  if (drawerRowCount != before) {
    drawerDirty = true;
    return;
  }
  for (uint8_t i = 0; i < drawerRowCount; ++i) {
    if (previous[i] != drawerRows[i]) { drawerDirty = true; return; }
  }
}

int16_t drawerHeight() {
  return (int16_t)(12 + (int16_t)drawerRowCount * kDrawerRowH + 14);
}

// ---------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------

bool canGoBack() {
  return screen != Screen::Home && screen != Screen::Status;
}

// DEVICE and GATEWAY are reachable — and useful — on a controller that has no owner yet. They are
// what somebody opens when the claim screen is not working, so neither the action bar nor the touch
// router may gate them on being claimed the way every thread-shaped screen is.
bool configScreen() {
  return screen == Screen::Device || screen == Screen::Gateway;
}

constexpr Rect kBackHit = {0, 0, 46, kContentTop};
constexpr Rect kHandleHit = {46, 0, kW - 46, kContentTop};

void drawHeader() {
  g().fillRect(0, 0, kW, kContentTop, panelGrey(kBg));

  const bool back = canGoBack();
  if (back) uip::chevron(20, 24, 6.0f, -1, kMuted, 2.2f);

  const int16_t nameX = back ? 40 : 14;
  const size_t nameCols = (size_t)((kW - nameX - 46) / 6);
  uip::text(nameX, 20, 1, kText, uip::fit(deviceName(), nameCols));

  // The divider is a shallow arc that fades out before either bezel, and the pull grabber sits
  // above its low point rather than on it — a rule with a tab welded to it is the shape this UI is
  // trying to stop being.
  displaySoftArcDivider(14, 46, (int16_t)(kW - 28), 3.5f, 1.5f, kBg, kHair);
  uip::capsule({(int16_t)(kW / 2 - 17), 38, 34, 4}, (int16_t)kHair, -1);
}

// The header's right-hand affordance. When the big orb is not on screen the mini orb lives here and
// IS the handle; when it is, a dot stands in so the tap target never disappears.
void drawHeaderStatusDot() {
  uint8_t tone = kMuted;
  for (uint8_t i = 0; i < drawerRowCount; ++i) {
    if (rowTone(drawerRows[i]) == kBright) { tone = kBright; break; }
  }
  uip::dot(kMiniOrbCx, kMiniOrbCy - 4, 5.0f, tone);
  uip::chevron(kMiniOrbCx, kMiniOrbCy + 9, 4.0f, 2, kHair, 1.8f);
}

void drawChrome() {
  // Only the very first paint needs the whole panel cleared. After that the header, the drawer, the
  // content region and the action bar each clear their own band.
  static bool everPainted = false;
  if (!everPainted) {
    g().fillScreen(panelGrey(kBg));
    everPainted = true;
  }
  drawHeader();
  chromeDirty = false;
}

// ---------------------------------------------------------------------------------------------
// Orb mode
// ---------------------------------------------------------------------------------------------

// What the agent is doing, from the best evidence the device protocol actually carries.
//
// The display payload's `state` is an account-level word ("ready" / "setup"), not an agent state,
// so on its own it would leave the orb permanently calm. The signals that do move are, in order of
// authority: a recording in progress, a response still arriving, and the selected thread's status
// from the thread list. Each is mapped through the shared orbModeForAgentState() so every board
// shows the same animation for the same state.
OrbMode modeForState() {
  if (audio::recording()) return orbModeForAgentState("recording");
  if (!gw) return OrbMode::Ring;
  if (!operable()) return OrbMode::Web;
  if (gw->responseOpen() && gw->responseInFlight()) return orbModeForAgentState("running");

  const int index = gw->selectedThreadIndex();
  const ThreadOption* selected = gw->thread((size_t)(index < 0 ? 0 : index));
  if (selected && selected->selected) {
    // The client upper-cases the status for display; the mapper wants the wire value.
    String state = selected->status;
    state.toLowerCase();
    const OrbMode mapped = orbModeForAgentState(state);
    if (mapped != OrbMode::Ring) return mapped;
  }
  return orbModeForAgentState(gw->display().state);
}

void setMode(OrbMode mode) {
  currentMode = mode;
  orb.setMode(mode);
  miniOrb.setMode(mode);
}

// ---------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------

String gatewayLine() {
  if (!gw) return String();
  switch (gw->link()) {
    case GatewayLink::Claimed:     return gw->display().line2;
    case GatewayLink::Unclaimed:   return "Waiting to be claimed";
    case GatewayLink::Revoked:     return "Hold BOOT 10s to reset";
    case GatewayLink::NoIdentity:  return "Factory flash needed";
    case GatewayLink::Unreachable: return store ? store->gatewayUrl() : String();
    default:                       return gatewayStatusText(gatewayStatus());
  }
}

void paintHome() {
  clearContent();
  const String thread = gw ? gw->selectedThreadLabel() : String("No gateway");
  uip::textCentered(kHomeThreadY, 1, kText, uip::fit(thread, kCols1));
  const String detail = message.length() > 0 ? message : gatewayLine();
  uip::textCentered(kHomeDetailY, 1, kMuted, uip::fit(detail, kCols1));
}

// The claim screen. A brand-new controller has one job: tell its owner how to take possession of
// it. There is no printed code — this screen is the only place the code is ever shown — so it
// outranks every other thing the device could say, including the shimmer label, whose strip lands
// exactly here, which is why unclaimed() gates it rather than the two overlapping.
//
// It is also the one screen with no action bar. Rotating the code is a real action, but it is
// destructive of the number the owner may be part-way through typing, so it stays behind a tap on
// the code itself rather than sitting under their thumb.
constexpr int16_t kClaimTop = 210;

void paintStatus() {
  clearContent();

  if (unclaimed()) {
    const String code = gw->claimCode();
    uip::textCentered(kClaimTop, 1, kMuted, "CLAIM THIS CONTROLLER");
    if (code.length() > 0) {
      // The largest thing on the screen: it is read from across a desk and typed by hand into
      // another device.
      const int16_t codeW = (int16_t)(code.length() * 18);
      uip::text((int16_t)((kW - codeW) / 2), kClaimTop + 18, 3, kBright, code);
    } else {
      // Transient: the device asks the gateway to mint one as soon as it knows it is unowned.
      uip::textCentered(kClaimTop + 22, 2, kMuted, "Getting code...");
    }
    const String steps[3] = {
      store && store->gatewayUrl().length() ? store->gatewayUrl() : String("Open the console"),
      String("Devices  >  Claim"),
      String("Tap the code to replace it"),
    };
    int16_t y = kClaimTop + 52;
    for (uint8_t i = 0; i < 3; ++i) {
      uip::dot(22, (int16_t)(y + 3), 2.5f, kHair);
      uip::text(34, y, 1, kMuted, uip::fit(steps[i], 32));
      y += 16;
    }
    return;
  }

  uip::textCentered(kHomeThreadY, 1, kMuted, uip::fit(gatewayLine(), kCols1));
  if (prov && prov->status().state == ProvisioningState::Provisioning) {
    uip::textCentered(kHomeDetailY, 1, kHair,
                      uip::fit(String("Join ") + prov->status().apName, kCols1));
  } else if (message.length() > 0) {
    uip::textCentered(kHomeDetailY, 1, kHair, uip::fit(message, kCols1));
  }
}

// ---------------------------------------------------------------------------------------------
// Threads, and the two levels above it
// ---------------------------------------------------------------------------------------------

constexpr Rect kBreadcrumb = {12, kContentTop + 4, kW - 24, 30};
constexpr int16_t kThreadListTop = kContentTop + 56;
constexpr int16_t kThreadRowH = 48;

// The breadcrumb is the entry to the browser, and it is a capsule rather than a line of text
// because it is a control: it says where the work is going AND opens the list of somewhere else.
void paintBreadcrumb() {
  uip::capsule(kBreadcrumb, (int16_t)kSurface, (int16_t)kHair, 1.2f);
  String where = browse.environmentLabel();
  if (where.length() == 0) {
    const String& env = gw->context().environmentId;
    where = env.length() > 0 ? env : String("No environment");
  }
  const String project = browse.projectLabel();
  if (project.length() > 0) where += String("  /  ") + project;
  uip::text(kBreadcrumb.x + 14, (int16_t)(kBreadcrumb.y + 11), 1, kText, uip::fit(where, 32));
  uip::chevron((int16_t)(kBreadcrumb.x + kBreadcrumb.w - 16),
               (int16_t)(kBreadcrumb.y + kBreadcrumb.h / 2), 5.0f, 1, kMuted, 2.0f, kSurface);
}

// One row of any of the three lists. They are the same shape on purpose: an environment, a folder
// and a thread are the same kind of choice at three depths, and a person should not have to relearn
// the row between them.
void paintChoiceRow(int16_t y, int16_t rowH, const String& title, const String& meta,
                    bool selected, bool last) {
  if (selected) {
    uip::card({8, (int16_t)(y + 2), (int16_t)(kW - 16), (int16_t)(rowH - 10)}, 14.0f,
              (int16_t)kSurface, -1, 0.0f, 1.6f);
    // Composited against the card it sits on, not against the ground: an anti-aliased edge blended
    // towards the wrong colour draws a dark halo, which is the one artefact that makes a soft shape
    // look worse than a hard one.
    uip::marker(14, (int16_t)(y + 10), (int16_t)(rowH - 26), kBright, kSurface);
  }
  uip::text(26, (int16_t)(y + 9), 1, selected ? kBright : kText, uip::fit(title, 33));
  uip::text(26, (int16_t)(y + 25), 1, selected ? kMuted : kHair, uip::fit(meta, 33));
  if (!last && !selected) uip::divider(20, (int16_t)(y + rowH - 5), (int16_t)(kW - 40));
}

void paintThreads() {
  clearContent();
  paintBreadcrumb();

  const size_t count = gw->threadCount();
  uip::text(14, kContentTop + 42, 1, kMuted,
            count > 0 ? String(count) + " THREADS" : String("THREADS"));

  if (count == 0) {
    const String detail = gw->threadsDetail().length() > 0 ? gw->threadsDetail() : message;
    uip::textCentered(kContentTop + 100, 1, kMuted,
                      uip::fit(detail.length() > 0 ? detail : String("Nothing here yet"), kCols1));
    return;
  }

  const int16_t bottom = contentBottom();
  for (size_t i = 0; i < count; ++i) {
    const int16_t y = (int16_t)(kThreadListTop + (int16_t)i * kThreadRowH - threadScroll);
    if (y + kThreadRowH <= kThreadListTop || y >= bottom) continue;
    const ThreadOption* row = gw->thread(i);
    if (!row) continue;
    const String meta = row->selected ? String("ACTIVE  ") + row->status : row->status;
    paintChoiceRow(y, kThreadRowH, row->title, meta, row->selected, i + 1 == count);
  }
}

constexpr int16_t kBrowseListTop = kContentTop + 34;
constexpr int16_t kBrowseRowH = 48;

void paintEnvironments() {
  clearContent();
  uip::text(14, kContentTop + 8, 1, kMuted, "ENVIRONMENT");
  const size_t count = browse.environmentCount();
  if (count == 0) {
    const String detail = browse.environmentsDetail();
    uip::textCentered(kContentTop + 100, 1, kMuted,
                      uip::fit(detail.length() > 0 ? detail : String("Tap RELOAD"), kCols1));
    return;
  }
  const int16_t bottom = contentBottom();
  for (size_t i = 0; i < count; ++i) {
    const int16_t y = (int16_t)(kBrowseListTop + (int16_t)i * kBrowseRowH - envScroll);
    if (y + kBrowseRowH <= kBrowseListTop || y >= bottom) continue;
    const BrowseEnvironment* row = browse.environment(i);
    if (!row) continue;
    // An expired access token is a dead end the owner has to fix at the host, and the listing
    // carries it precisely so the device can say so before they walk over.
    const String meta = row->tokenExpired ? String("TOKEN EXPIRED") : row->status;
    paintChoiceRow(y, kBrowseRowH, row->label, meta, row->selected, i + 1 == count);
  }
}

void paintProjects() {
  clearContent();
  // There is no "all folders" row, and it is not an omission: POST /v1/device/config/project reads
  // `projectId` as a required string, so the device protocol offers no way to clear a folder once
  // one is bound. Widening the scope again is a console operation.
  uip::text(14, kContentTop + 8, 1, kMuted, "FOLDER");
  const size_t count = browse.projectCount();
  if (count == 0) {
    const String detail = browse.projectsDetail();
    uip::textCentered(kContentTop + 100, 1, kMuted,
                      uip::fit(detail.length() > 0 ? detail : String("Tap RELOAD"), kCols1));
    return;
  }
  const int16_t bottom = contentBottom();
  for (size_t i = 0; i < count; ++i) {
    const int16_t y = (int16_t)(kBrowseListTop + (int16_t)i * kBrowseRowH - projectScroll);
    if (y + kBrowseRowH <= kBrowseListTop || y >= bottom) continue;
    const BrowseProject* row = browse.project(i);
    if (!row) continue;
    // The count is what makes this list usable at arm's length: it says which folder has anything
    // in it before somebody pages into an empty one.
    const String meta = row->threadCount == 1 ? String("1 thread")
                                              : String(row->threadCount) + " threads";
    paintChoiceRow(y, kBrowseRowH, row->title, meta, row->selected, i + 1 == count);
  }
}

// ---------------------------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------------------------

constexpr Rect kMicButton = {14, kContentTop + 6, kW - 28, 86};
constexpr int16_t kActionListTop = kContentTop + 116;
constexpr int16_t kActionRowH = 42;

void paintMicButton() {
  const bool have = audio::available();
  const bool live = audio::recording();

  // A capsule, and at this height the radius is 43 px — there is no corner on it at all, which is
  // the point: the one thing on this screen a thumb lands on should not be a box.
  const int16_t fill = live ? (int16_t)kSurfaceHi : (int16_t)kSurface;
  const int16_t stroke = live ? (int16_t)kBright : (have ? (int16_t)kMuted : (int16_t)kHair);
  uip::capsule(kMicButton, fill, stroke, live ? 2.2f : 1.4f, 1.6f);

  if (!have) {
    uip::textCentered(kMicButton.y + 30, 2, kHair, "NO MIC");
    uip::textCentered(kMicButton.y + 56, 1, kHair, "flash the -controller build");
    return;
  }
  if (live) {
    const uint32_t ms = audio::recordedMs();
    uip::textCentered(kMicButton.y + 26, 2, kBright, "RECORDING");
    char buf[24];
    snprintf(buf, sizeof(buf), "%u.%us  release to stop", (unsigned)(ms / 1000),
             (unsigned)((ms % 1000) / 100));
    uip::textCentered(kMicButton.y + 56, 1, kMuted, buf);
    return;
  }
  if (clipHeld) {
    char buf[28];
    snprintf(buf, sizeof(buf), "%u.%us CLIP READY", (unsigned)(clipHeldMs / 1000),
             (unsigned)((clipHeldMs % 1000) / 100));
    uip::textCentered(kMicButton.y + 26, 2, kBright, buf);
    uip::textCentered(kMicButton.y + 56, 1, kMuted, "send it or discard it below");
    return;
  }
  uip::textCentered(kMicButton.y + 26, 2, kText, "HOLD TO TALK");
  uip::textCentered(kMicButton.y + 56, 1, kMuted, "voice note to the selected thread");
}

void paintSend() {
  clearContent();
  paintMicButton();

  uip::text(14, kActionListTop - 18, 1, kMuted, "SAVED ACTIONS");
  const size_t count = gw->controlCount();
  if (count == 0) {
    uip::textCentered(kActionListTop + 20, 1, kHair, "None assigned - add them in the console");
    return;
  }

  const int16_t bottom = contentBottom();
  for (size_t i = 0; i < count; ++i) {
    const int16_t y = (int16_t)(kActionListTop + (int16_t)i * kActionRowH - actionScroll);
    if (y + kActionRowH <= kActionListTop || y >= bottom) continue;
    const DeviceControl* c = gw->control(i);
    if (!c) continue;
    const bool blocked = !c->enabled || (c->requiresThread && !gw->hasThread());
    uip::text(14, (int16_t)(y + 6), 1, blocked ? kHair : kText, uip::fit(c->label, 28));
    // The right-hand word is why the row will or will not do anything, which is the only thing a
    // person needs to read before pressing it.
    String meta = "RUN";
    if (!c->enabled) meta = "LOCK";
    else if (c->requiresThread && !gw->hasThread()) meta = "THREAD";
    else if (c->kind == "capture_audio" || c->mediaKind == "audio") meta = "HOLD";
    else if (c->kind == "status") meta = "VIEW";
    else if (c->requiresConfirmation || c->kind == "stop" || c->kind == "reset") meta = "CONFIRM";
    uip::textRight((int16_t)(kW - 14), (int16_t)(y + 6), 1, kHair, meta);
    const String sub = blocked && c->reason.length() > 0 ? c->reason : String();
    if (sub.length() > 0) uip::text(14, (int16_t)(y + 20), 1, kHair, uip::fit(sub, 34));
    if (i + 1 < count) uip::divider(20, (int16_t)(y + kActionRowH - 6), (int16_t)(kW - 40));
  }
}

// ---------------------------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------------------------

constexpr int16_t kReplyTextTop = kContentTop + 8;
constexpr int16_t kReplyLineH = 20;
// Six lines of 19 characters is 114, against the 93 a full gateway page can hold (3 lines of 31),
// so a page always fits. A seventh line would run into the state row below it.
constexpr size_t kReplyMaxLines = 6;
constexpr Rect kFollowLeft = {12, kContentTop + 160, 106, 34};
constexpr Rect kFollowRight = {122, kContentTop + 160, 106, 34};

void paintResponse() {
  clearContent();
  const ThreadResponse& r = gw->response();

  if (!gw->responseOpen()) {
    uip::textCentered(kContentTop + 70, 1, kMuted, "No response open");
    uip::textCentered(kContentTop + 90, 1, kHair, "Load the latest below");
    return;
  }

  // The gateway wraps to 31 characters, which is e-ink geometry, not this panel's. Re-joining and
  // re-wrapping to 19 is what buys size-2 text: 31 columns at size 2 would be 372 px on a 240 px
  // screen. The join is safe because the gateway wraps on word boundaries.
  String joined;
  for (size_t i = 0; i < r.lineCount; ++i) {
    if (r.lines[i].length() == 0) continue;
    if (joined.length() > 0) joined += ' ';
    joined += r.lines[i];
  }

  String lines[kReplyMaxLines];
  const size_t count = uip::wrapText(joined, kCols2, lines, kReplyMaxLines);
  for (size_t i = 0; i < count; ++i) {
    uip::text(10, (int16_t)(kReplyTextTop + (int16_t)i * kReplyLineH), 2, kText, lines[i]);
  }
  if (count == 0) {
    const String waiting = r.state == "waiting" || r.state == "streaming"
      ? String("Waiting for the agent") : String("Nothing to show yet");
    uip::textCentered(kReplyTextTop + 40, 1, kMuted, waiting);
  }

  // State is the turn-completion discriminator and the only honest answer to "is it done".
  String state = r.state;
  state.toUpperCase();
  uip::divider(20, kContentTop + 138, (int16_t)(kW - 40));
  uip::text(14, kContentTop + 146, 1, kMuted, state);
  uip::textRight((int16_t)(kW - 14), kContentTop + 146, 1, kMuted,
                 String(r.page + 1) + "/" + String(r.pageCount));

  for (size_t i = 0; i < r.followUpCount && i < 2; ++i) {
    uip::button(i == 0 ? kFollowLeft : kFollowRight, r.followUps[i].label, false, gw->hasThread());
  }
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

void paintApprovals() {
  clearContent();
  const size_t count = gw->approvalCount();
  if (count == 0) {
    uip::textCentered(kContentTop + 80, 2, kMuted, "All clear");
    uip::textCentered(kContentTop + 112, 1, kHair, "Commands held by policy appear here");
    return;
  }
  if (approvalIndex >= count) approvalIndex = 0;
  const PendingApproval* a = gw->approval(approvalIndex);
  if (!a) return;

  const Rect box = {10, kContentTop + 4, kW - 20, 178};
  uip::card(box, 20.0f, (int16_t)kSurface, (int16_t)kHair, 1.3f, 1.6f);

  String header = String(approvalIndex + 1) + " of " + String(count);
  if (gw->approvalOverflow()) header += "+  (see console)";
  uip::text(24, box.y + 14, 1, kMuted, header);
  if (a->risk.length() > 0) {
    String risk = a->risk;
    risk.toUpperCase();
    uip::textRight((int16_t)(kW - 24), (int16_t)(box.y + 14), 1, kBright, risk);
  }

  uip::text(24, box.y + 36, 2, kText, uip::fit(a->intentType, 17));

  String lines[4];
  const size_t wrapped = uip::wrapText(a->summary, 33, lines, 4);
  for (size_t i = 0; i < wrapped; ++i) {
    uip::text(24, (int16_t)(box.y + 70 + (int16_t)i * 16), 1, kMuted, lines[i]);
  }
  uip::divider(24, (int16_t)(box.y + box.h - 22), (int16_t)(box.w - 28), kHair, kSurface);
  uip::text(24, (int16_t)(box.y + box.h - 14), 1, kHair, "Runs on your own machine");
}

// ---------------------------------------------------------------------------------------------
// Device and gateway configuration
// ---------------------------------------------------------------------------------------------

// One label/value pair. The label is small and quiet, the value is the answer — the opposite of a
// table, which is what this used to want to be.
void paintFact(int16_t y, const char* label, const String& value, uint8_t tone) {
  uip::text(16, y, 1, kHair, label);
  uip::text(16, (int16_t)(y + 13), 1, tone, uip::fit(value, 36));
}

void paintDevice() {
  clearContent();
  uip::text(14, kContentTop + 8, 1, kMuted, "DEVICE");

  int16_t y = kContentTop + 26;
  paintFact(y, "NAME", deviceName(), kText);
  y += 30;
  paintFact(y, "IDENTITY", store && store->deviceId().length() > 0 ? store->deviceId()
                                                                  : String("Not flashed"), kText);
  y += 30;
  paintFact(y, "MODEL", String(HARDWARE_MODEL) + "  fw " + FIRMWARE_VERSION, kMuted);
  y += 30;
  paintFact(y, "WI-FI", store && store->wifiSsid().length() > 0 ? store->wifiSsid()
                                                                : String("Not configured"), kMuted);
  y += 30;
  paintFact(y, "STATE", rowValue(Row::Device), rowTone(Row::Device));
  y += 30;
  uip::divider(20, y, (int16_t)(kW - 40));
  uip::text(16, (int16_t)(y + 8), 1, kHair, "RE-PROVISION clears Wi-Fi only");
}

void paintGateway() {
  clearContent();
  uip::text(14, kContentTop + 8, 1, kMuted, "GATEWAY");

  const String url = store ? store->gatewayUrl() : String();
  uip::text(16, kContentTop + 30, 1, kHair, "URL");
  String lines[2];
  const size_t wrapped = uip::wrapText(url.length() > 0 ? url : String("Not configured"), 36,
                                       lines, 2);
  for (size_t i = 0; i < wrapped; ++i) {
    uip::text(16, (int16_t)(kContentTop + 43 + (int16_t)i * 14), 1, kText, lines[i]);
  }

  int16_t y = kContentTop + 76;
  paintFact(y, "LINK", gw ? String(gatewayLinkName(gw->link())) : String("None"),
            rowTone(Row::Gateway));
  y += 30;
  paintFact(y, "PROBE", String(gatewayStatusText(gatewayStatus())), kMuted);
  y += 30;
  const String detail = gw && gw->detail().length() > 0 ? gw->detail() : gatewayLine();
  paintFact(y, "LAST", detail.length() > 0 ? detail : String("Nothing reported"), kMuted);
  y += 30;
  uip::divider(20, y, (int16_t)(kW - 40));
  uip::text(16, (int16_t)(y + 8), 1, kHair, "PORTAL reopens the setup form");
}

// ---------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------

void paintModal() {
  // The whole content region, not just the box: leaving the screen underneath visible around the
  // edges shows half a list row and reads as a rendering fault rather than as a dialog.
  clearContent();
  const Rect box = {12, 86, kW - 24, 144};
  uip::card(box, 22.0f, (int16_t)kSurface, (int16_t)kMuted, 1.4f, 1.8f);

  const bool approval = modal == Modal::ConfirmApproval;
  const bool reprovision = modal == Modal::ConfirmReprovision;
  uip::textCentered((int16_t)(box.y + 18), 1, kMuted,
                    approval ? "APPROVE COMMAND"
                             : (reprovision ? "RE-PROVISION" : "CONFIRM ACTION"));

  String lines[4];
  const String subject = approval ? pendingApprovalSummary
                                  : (reprovision ? String("Clear Wi-Fi and reopen setup")
                                                 : pendingControl.label);
  const size_t wrapped = uip::wrapText(subject, 30, lines, 4);
  for (size_t i = 0; i < wrapped; ++i) {
    uip::textCentered((int16_t)(box.y + 46 + (int16_t)i * 18), 1, kText, lines[i]);
  }
  // Approving runs it on the owner's own machine — the one thing on this device worth a second
  // deliberate press.
  uip::textCentered((int16_t)(box.y + box.h - 26), 1, kHair,
                    approval ? "Runs on your machine"
                             : (reprovision ? "Identity is kept"
                                            : uip::fit(gw->selectedThreadLabel(), 30)));
}

void paintContent() {
  if (modal != Modal::None) {
    paintModal();
    contentDirty = false;
    return;
  }
  switch (screen) {
    case Screen::Home:         paintHome(); break;
    case Screen::Threads:      paintThreads(); break;
    case Screen::Send:         paintSend(); break;
    case Screen::Response:     paintResponse(); break;
    case Screen::Approvals:    paintApprovals(); break;
    case Screen::Environments: paintEnvironments(); break;
    case Screen::Projects:     paintProjects(); break;
    case Screen::Device:       paintDevice(); break;
    case Screen::Gateway:      paintGateway(); break;
    default:                   paintStatus(); break;
  }
  contentDirty = false;
}

// ---------------------------------------------------------------------------------------------
// The status drawer
// ---------------------------------------------------------------------------------------------

// Anchored at kContentTop, not at kHeaderH: the drawer occupies exactly the region a content
// repaint clears, so putting it away never leaves a sliver of its surface stranded under the
// header's curved divider.
Rect drawerRowRect(uint8_t index) {
  return {0, (int16_t)(kContentTop + 12 + (int16_t)index * kDrawerRowH), kW, kDrawerRowH};
}

// Paints the drawer at its current extension, repainting only the band that changed.
//
// The whole panel is NOT redrawn per frame: `drawerShownPx` remembers how much is already on the
// glass, and each frame paints from the smaller of the two positions to the larger. A full 210 px
// panel is 50 000 pixels, which is most of a frame budget on its own — paying that ten times for
// one slide is how an animation becomes a stutter.
void paintDrawerFrame() {
  const int16_t revealed = (int16_t)(uip::easeOutCubic(drawerT) * drawerHeight());
  const int16_t from = revealed < drawerShownPx ? revealed : drawerShownPx;
  const int16_t to = revealed > drawerShownPx ? revealed : drawerShownPx;
  drawerShownPx = revealed;

  // The band that changed, plus the lip's own thickness at each end.
  int16_t bandTop = (int16_t)(kContentTop + from - 10);
  int16_t bandBottom = (int16_t)(kContentTop + to + 10);
  if (bandTop < kContentTop) bandTop = kContentTop;
  if (bandBottom > kH) bandBottom = kH;
  if (bandBottom > bandTop) {
    g().fillRect(0, bandTop, kW, (int16_t)(bandBottom - bandTop), panelGrey(kBg));
  }
  if (revealed <= 2) return;

  // The surface starts above the header so its top corners are never seen: the drawer reads as
  // something pulled OUT of the header rather than a card that appeared under it.
  displaySoftRoundRect(-8, (int16_t)(kContentTop - 30), (int16_t)(kW + 16),
                       (int16_t)(revealed + 30), 26.0f, kBg, (int16_t)kSurfaceHi, -1, 0.0f, 2.2f);

  for (uint8_t i = 0; i < drawerRowCount; ++i) {
    const Rect r = drawerRowRect(i);
    // A row appears only once there is room for the whole of it. Half a row sliding past the lip
    // is the thing that makes a reveal look like a repaint.
    if (r.y + r.h > kContentTop + revealed - 10) break;
    const Row row = drawerRows[i];
    uip::dot(24, (int16_t)(r.y + 20), 4.0f, rowTone(row), kSurfaceHi);
    uip::text(40, (int16_t)(r.y + 6), 1, kMuted, rowTitle(row));
    uip::text(40, (int16_t)(r.y + 22), 1, kText, uip::fit(rowValue(row), 29));
    uip::chevron((int16_t)(kW - 22), (int16_t)(r.y + 20), 5.0f, 1, kMuted, 2.0f, kSurfaceHi);
    if (i + 1 < drawerRowCount && r.y + r.h + kDrawerRowH <= kContentTop + revealed - 10) {
      displaySoftArcDivider(36, (int16_t)(r.y + r.h - 3), (int16_t)(kW - 72), 2.0f, 1.2f,
                            kSurfaceHi, kHair);
    }
  }

  // The leading edge: a brighter curve at the bottom of the panel, which is the thing the eye
  // follows down and back up again.
  displaySoftArcDivider(18, (int16_t)(kContentTop + revealed - 8), (int16_t)(kW - 36), 3.0f, 1.8f,
                        kSurfaceHi, kMuted);
}

void openDrawer() {
  if (drawerOpen) return;
  drawerOpen = true;
  drawerDirty = true;
  // The drawer covers the content, and a drawer shorter than the content leaves whatever was under
  // it frozen on screen — including a big orb that has stopped being drawn. Clear once, here.
  clearContent();
}

void closeDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  drawerDirty = true;
}

// Immediate, for the paths that are about to paint something else over the whole content region.
void closeDrawerNow() {
  drawerOpen = false;
  drawerT = 0.0f;
  drawerShownPx = 0;
  drawerDirty = false;
  contentDirty = true;
}

// ---------------------------------------------------------------------------------------------
// The action bar
// ---------------------------------------------------------------------------------------------

void addAction(Act id, const char* label, bool primary, bool enabled = true) {
  // Bounds-checked against `actions`, which is the array being written.
  if (actionCount >= kMaxActions) return;
  actions[actionCount].id = id;
  actions[actionCount].label = label;
  actions[actionCount].primary = primary;
  actions[actionCount].enabled = enabled;
  actionCount += 1;
}

// What there is to do, right now, on this screen.
//
// The rule that produces an empty bar is the whole point: if this function adds nothing, the bar is
// not drawn and those 58 pixels belong to the content. A permanent strip of five tabs, four of them
// inert, was the opposite of that.
void buildActions() {
  actionCount = 0;
  if (!gw) return;

  // A modal outranks everything, including a held clip. Both want the same two buttons, and a
  // confirmation that cannot be answered because a recording is queued behind it is a dead end
  // with no way out of it.
  if (modal != Modal::None) {
    addAction(Act::ConfirmNo, "CANCEL", false);
    addAction(Act::ConfirmYes,
              modal == Modal::ConfirmApproval ? "APPROVE"
                                              : (modal == Modal::ConfirmReprovision ? "RESET"
                                                                                    : "RUN"),
              true);
    return;
  }

  // A held clip outranks the screen. It is a recording sitting in RAM that has not been sent
  // anywhere, and there is exactly one pair of things to do with it.
  if (clipHeld) {
    addAction(Act::DiscardClip, "DISCARD", false);
    addAction(Act::SendClip, "SEND", true, gw->hasThread());
    return;
  }

  if (!operable() && !configScreen()) {
    // The claim screen keeps its rotate behind a tap on the code itself; there is nothing else an
    // unowned device can be asked to do.
    return;
  }

  switch (screen) {
    case Screen::Home: {
      if (gw->approvalCount() > 0) {
        addAction(Act::Review, "REVIEW", true);
        return;
      }
      if (!gw->hasThread()) {
        addAction(Act::PickThread, "CHOOSE A THREAD", true);
        return;
      }
      if (gw->responseOpen() && gw->response().state == "error") {
        addAction(Act::Retry, "RETRY", true);
        return;
      }
      if (audio::available()) addAction(Act::Talk, "TALK", true);
      if (gw->responseOpen()) addAction(Act::OpenReply, "REPLY", false);
      return;
    }
    case Screen::Threads:
      if (gw->threadCount() == 0) addAction(Act::Reload, "RELOAD", true);
      return;
    case Screen::Environments:
      if (browse.environmentCount() == 0) addAction(Act::Reload, "RELOAD", true);
      return;
    case Screen::Projects:
      if (browse.projectCount() == 0) addAction(Act::Reload, "RELOAD", true);
      return;
    case Screen::Send:
      return;   // the microphone and the saved actions are the screen; nothing else to press
    case Screen::Response: {
      if (!gw->responseOpen()) {
        addAction(Act::Refresh, "LOAD LATEST", true, gw->hasThread());
        return;
      }
      const ThreadResponse& r = gw->response();
      if (r.pageCount > 1) {
        addAction(Act::PrevPage, "PREV", false);
        addAction(Act::NextPage, "NEXT", false);
        return;
      }
      // A finished single page has nothing to do. Waiting, streaming and error all do.
      if (r.state == "error") addAction(Act::Retry, "RETRY", true);
      else if (gw->responseInFlight()) addAction(Act::Refresh, "REFRESH", false);
      return;
    }
    case Screen::Approvals: {
      if (gw->approvalCount() == 0) return;
      addAction(Act::Reject, "REJECT", false);
      addAction(Act::Approve, "APPROVE", true);
      if (gw->approvalCount() > 1) addAction(Act::NextApproval, "NEXT", false);
      return;
    }
    case Screen::Device:
      addAction(Act::Portal, "PORTAL", false);
      addAction(Act::Reprovision, "RE-PROVISION", false);
      return;
    case Screen::Gateway:
      addAction(Act::Portal, "PORTAL", false);
      addAction(Act::Retry, "RE-PROBE", false);
      return;
    default:
      return;
  }
}

uint32_t signatureOfActions() {
  uint32_t sig = actionCount;
  for (uint8_t i = 0; i < actionCount; ++i) {
    sig = sig * 131u + (uint32_t)actions[i].id * 4u + (actions[i].enabled ? 2u : 0u)
      + (actions[i].primary ? 1u : 0u);
  }
  return sig;
}

Rect actionRect(uint8_t index, int16_t top) {
  constexpr int16_t kSide = 12;
  constexpr int16_t kGap = 8;
  const uint8_t n = actionCount == 0 ? 1 : actionCount;
  const int16_t span = (int16_t)(kW - kSide * 2 - kGap * (n - 1));
  const int16_t w = (int16_t)(span / n);
  return {(int16_t)(kSide + (int16_t)index * (w + kGap)), (int16_t)(top + 11), w, 36};
}

void paintActionBar() {
  const int16_t offset = (int16_t)((1.0f - uip::easeOutCubic(barT)) * kBarH);
  const int16_t top = (int16_t)(kH - kBarH + offset);
  g().fillRect(0, (int16_t)(kH - kBarH), kW, kBarH, panelGrey(kBg));
  barDirty = false;
  if (offset >= kBarH || actionCount == 0) return;

  // The tray is drawn wider and taller than the screen so only its top corners are ever visible:
  // the bar reads as a surface rising out of the bottom edge, not as a card floating on it.
  displaySoftRoundRect(-10, top, (int16_t)(kW + 20), (int16_t)(kBarH + 40), 26.0f, kBg,
                       (int16_t)kSurfaceHi, -1, 0.0f, 2.2f);
  for (uint8_t i = 0; i < actionCount; ++i) {
    uip::button(actionRect(i, top), actions[i].label, actions[i].primary, actions[i].enabled,
                kSurfaceHi);
  }
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

// Paint, THEN call. Every gateway call below blocks the loop for up to its timeout — HTTPClient has
// no async mode — so the screen has to say what is happening before the stall, not after it.
void showBusy(const String& title, const String& detail) {
  if (!displayReady()) return;
  closeDrawerNow();
  drawHeader();
  clearContent();
  uip::textCentered(kContentTop + 70, 2, kBright, uip::fit(title, kCols2));
  uip::textCentered(kContentTop + 102, 1, kMuted, uip::fit(detail, kCols1));
  contentDirty = true;
}

void goTo(Screen next) {
  closeDrawerNow();
  if (screen == next) return;
  screen = next;
  modal = Modal::None;
  chromeDirty = true;
  contentDirty = true;
}

void goBack() {
  switch (screen) {
    case Screen::Projects:     goTo(Screen::Environments); return;
    case Screen::Environments: goTo(Screen::Threads); return;
    // An unclaimed device's home IS the claim screen; sending it to a home it does not have would
    // land on a thread label for a thread it cannot see.
    default:                   goTo(operable() ? Screen::Home : Screen::Status); return;
  }
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

// What to do with a dispatch that was accepted. A turn that produces an assistant reply opens the
// response and switches to it — that is the whole "fire it and watch the answer arrive" gesture —
// while status and stop, which produce no new turn, stay put and just report.
void afterDispatch(const DispatchResult& result, bool expectReply) {
  message = result.detail;
  if (result.hasScreen) {
    message = result.screen.line1 + " " + result.screen.line2;
    contentDirty = true;
    return;
  }
  if (result.accepted && expectReply) {
    showBusy("Sent", "Waiting for the agent");
    gw->openResponse(result.responseAfter);
    goTo(Screen::Response);
    return;
  }
  contentDirty = true;
}

void dispatchControl(const DeviceControl& c) {
  // Local, not a dispatch: wiping Wi-Fi has no gateway side.
  if (c.kind == "reset") {
    message = "Re-entering provisioning";
    contentDirty = true;
    prov->resetToProvisioning();
    return;
  }
  // Status and stop produce no new assistant turn, so there is nothing to open a response for. A
  // v1 row carries its verb in the id rather than the kind, which is why both are consulted.
  const bool quiet = c.kind == "status" || c.kind == "stop"
    || (c.kind == "legacy" && (c.id == "status" || c.id == "stop"));
  const bool expectReply = !quiet;
  showBusy(c.label, "Sending to selected task");
  const DispatchResult result = gw->runControl(c);
  afterDispatch(result, expectReply);
}

void confirmControl(const DeviceControl& c) {
  pendingControl = c;
  modal = Modal::ConfirmControl;
  contentDirty = true;
}

void runControlRow(const DeviceControl& c) {
  if (!c.enabled) {
    message = c.reason.length() > 0 ? c.reason : String("Unavailable");
    contentDirty = true;
    return;
  }
  if (c.requiresThread && !gw->hasThread()) {
    message = "Select a thread first";
    contentDirty = true;
    return;
  }
  // A capture action needs a clip, and the clip comes from the microphone button. Saying so beats
  // dispatching an action with no media id and letting the gateway explain it 5 s later.
  if (c.kind == "capture_audio" || (c.kind == "remote_action" && c.mediaKind == "audio")) {
    message = "Hold the mic button to record";
    contentDirty = true;
    return;
  }
  if (c.kind == "capture_image") {
    message = "No camera on this board";
    contentDirty = true;
    return;
  }
  // Local confirmation is the device's own review step and is a separate gate from gateway
  // approval. Stop and reset are always confirmed regardless of what the layout says: both are
  // destructive and neither can be undone from here.
  if (c.requiresConfirmation || c.kind == "stop" || c.kind == "reset") {
    confirmControl(c);
    return;
  }
  dispatchControl(c);
}

void discardClip() {
  clipHeld = false;
  clipHeldMs = 0;
  audio::discard();
  message = "Clip discarded";
  contentDirty = true;
}

// The upload-and-dispatch half of push-to-talk, now behind a deliberate press rather than behind
// the finger lifting. Blocks for as long as the upload takes and says so on screen the entire time.
void sendHeldClip() {
  if (!clipHeld) return;
  const size_t bytes = audio::recordedBytes();
  const uint32_t ms = clipHeldMs;
  if (bytes == 0) {
    discardClip();
    return;
  }

  showBusy("Uploading", String(ms / 1000) + "s voice note");

  // The WAV header is passed as its own segment so the PCM is never memmoved to make room in front
  // of it — on a megabyte clip that copy is the difference between working and not.
  uint8_t header[media::kWavHeaderBytes];
  media::buildWavHeader(header, (uint32_t)bytes, audio::sampleRateHz());

  int httpStatus = 0;
  const String mediaId = gw->uploadMedia("audio", "audio/wav", "controller.wav", header,
                                         sizeof(header), audio::pcm(), bytes, httpStatus);
  clipHeld = false;
  clipHeldMs = 0;
  audio::discard();
  if (mediaId.length() == 0) {
    message = httpStatus == 413 ? String("Clip too large") : String("Upload failed ") + httpStatus;
    contentDirty = true;
    return;
  }

  // A saved capture action is the owner's configured destination for a voice note; without one the
  // clip becomes a plain audio prompt on the selected thread.
  const DeviceControl* target = nullptr;
  for (size_t i = 0; i < gw->controlCount(); ++i) {
    const DeviceControl* c = gw->control(i);
    if (!c || !c->enabled) continue;
    if (c->kind == "capture_audio" || c->mediaKind == "audio") { target = c; break; }
  }

  showBusy("Sending", target ? target->label : String("Voice note"));
  const DispatchResult result = target
    ? gw->runAction(target->actionId, mediaId)
    : gw->sendAudioPrompt(mediaId, AUDIO_PROMPT_TEXT);
  afterDispatch(result, true);
}

// Ends the recording and HOLDS it. Nothing leaves the device here.
void finishRecording() {
  recordArmed = false;
  audio::stopRecording();
  const uint32_t ms = audio::recordedMs();
  const size_t bytes = audio::recordedBytes();

  const audio::ClipStats st = audio::measureClip();
  audio::printClipVerdict(st);

  if (ms < audio::minimumClipMs() || bytes == 0) {
    audio::discard();
    clipHeld = false;
    clipHeldMs = 0;
    message = "Too short - hold longer";
    contentDirty = true;
    return;
  }

  clipHeld = true;
  clipHeldMs = ms;
  message = "";
  contentDirty = true;
}

void startRecording() {
  if (!audio::available()) {
    message = "This build has no microphone";
    contentDirty = true;
    return;
  }
  if (!gw->hasThread()) {
    message = "Select a thread first";
    contentDirty = true;
    return;
  }
  // startRecording() drops whatever was held, so the flag has to go with it or the bar would offer
  // to send a clip that no longer exists.
  clipHeld = false;
  clipHeldMs = 0;
  recordArmed = true;
  audio::startRecording();
  setMode(modeForState());
  recordPaintedAt = 0;
  paintMicButton();
}

void refreshThreads() {
  showBusy("Threads", "Asking the gateway");
  gw->refreshThreads();
  threadScroll = 0;
  message = gw->threadsDetail();
  contentDirty = true;
}

void selectThreadRow(size_t index) {
  const ThreadOption* row = gw->thread(index);
  if (!row) return;
  showBusy("Selecting", uip::fit(row->title, kCols1));
  if (gw->selectThread(index)) {
    message = "Thread selected";
    goTo(Screen::Send);
  } else {
    message = gw->threadsDetail();
  }
  contentDirty = true;
}

void refreshEnvironments() {
  showBusy("Environments", "Asking the gateway");
  browse.refreshEnvironments();
  envScroll = 0;
  contentDirty = true;
}

void refreshProjects() {
  showBusy("Folders", "Asking the gateway");
  browse.refreshProjects();
  projectScroll = 0;
  contentDirty = true;
}

void selectEnvironmentRow(size_t index) {
  const BrowseEnvironment* row = browse.environment(index);
  if (!row) return;
  showBusy("Binding", uip::fit(row->label, kCols1));
  if (!browse.selectEnvironment(index)) {
    message = browse.environmentsDetail();
    contentDirty = true;
    return;
  }
  // Moving environment clears the project and the thread server-side, so the folder list is the
  // only honest next screen: going straight to threads would show a list that has just been
  // invalidated.
  browse.consumeContextCleared();
  goTo(Screen::Projects);
  refreshProjects();
}

void selectProjectRow(size_t index) {
  const BrowseProject* row = browse.project(index);
  if (!row) return;
  showBusy("Folder", uip::fit(row->title, kCols1));
  if (!browse.selectProject(index)) {
    message = browse.projectsDetail();
    contentDirty = true;
    return;
  }
  browse.consumeContextCleared();
  goTo(Screen::Threads);
  refreshThreads();
}

void answerApproval(const String& commandId, const String& label, bool approve) {
  if (commandId.length() == 0) return;
  showBusy(approve ? "Approving" : "Rejecting", uip::fit(label, kCols1));
  const DispatchResult result = gw->answerApproval(commandId, approve);
  message = result.detail;
  // The list this screen was showing is now stale; the client has already made a refresh due.
  approvalIndex = 0;
  contentDirty = true;
}

// Where a drawer row goes. Each category navigates to the screen that ACTS on it, which is the
// whole reason the drawer is navigation rather than a status panel with an OK button.
void openCategory(Row row) {
  switch (row) {
    case Row::Device:
      goTo(Screen::Device);
      return;
    case Row::Gateway:
      goTo(Screen::Gateway);
      return;
    case Row::Thread:
      goTo(Screen::Threads);
      if (gw->threadCount() == 0) refreshThreads();
      return;
    default:
      // An approval queue is the thing that most needs a person; a reply is what they came for
      // otherwise.
      if (gw->approvalCount() > 0) {
        approvalIndex = 0;
        goTo(Screen::Approvals);
        return;
      }
      goTo(Screen::Response);
      if (!gw->responseOpen() && gw->hasThread()) {
        showBusy("Reply", "Loading the latest");
        gw->openResponse(String());
        contentDirty = true;
      }
      return;
  }
}

void runAction(Act id) {
  switch (id) {
    case Act::Review:
      approvalIndex = 0;
      goTo(Screen::Approvals);
      return;
    case Act::Talk:
      goTo(Screen::Send);
      return;
    case Act::PickThread:
      goTo(Screen::Threads);
      if (gw->threadCount() == 0) refreshThreads();
      return;
    case Act::OpenReply:
      goTo(Screen::Response);
      return;
    case Act::Reload:
      if (screen == Screen::Environments) { refreshEnvironments(); return; }
      if (screen == Screen::Projects) { refreshProjects(); return; }
      refreshThreads();
      return;
    case Act::Retry:
    case Act::Refresh: {
      if (screen == Screen::Gateway) {
        // Non-blocking on purpose: the probe runs on its own task and this only brings its next
        // pass forward, so the render loop never waits on it.
        gatewayProbeNow();
        message = "Probing the gateway";
        contentDirty = true;
        return;
      }
      if (!gw->responseOpen()) {
        showBusy("Reply", "Loading the latest");
        gw->openResponse(String());
        goTo(Screen::Response);
        contentDirty = true;
        return;
      }
      showBusy("Reply", "Refreshing");
      gw->fetchResponsePage(gw->response().page);
      contentDirty = true;
      return;
    }
    case Act::PrevPage: {
      const ThreadResponse& r = gw->response();
      if (r.pageCount <= 1) return;
      showBusy("Reply", "Loading page");
      gw->fetchResponsePage(r.page > 0 ? r.page - 1 : r.pageCount - 1);
      contentDirty = true;
      return;
    }
    case Act::NextPage: {
      const ThreadResponse& r = gw->response();
      if (r.pageCount <= 1) return;
      showBusy("Reply", "Loading page");
      gw->fetchResponsePage((r.page + 1) % r.pageCount);
      contentDirty = true;
      return;
    }
    case Act::Approve: {
      const PendingApproval* a = gw->approval(approvalIndex);
      if (!a) return;
      pendingApprovalId = a->commandId;
      pendingApprovalSummary = a->summary;
      modal = Modal::ConfirmApproval;
      contentDirty = true;
      return;
    }
    case Act::Reject: {
      const PendingApproval* a = gw->approval(approvalIndex);
      if (a) answerApproval(a->commandId, a->intentType, false);
      return;
    }
    case Act::NextApproval:
      if (gw->approvalCount() > 1) {
        approvalIndex = (approvalIndex + 1) % gw->approvalCount();
        contentDirty = true;
      }
      return;
    case Act::SendClip:
      sendHeldClip();
      return;
    case Act::DiscardClip:
      discardClip();
      return;
    case Act::Portal:
      message = "Config portal open";
      contentDirty = true;
      prov->openConfigPortal();
      return;
    case Act::Reprovision:
      modal = Modal::ConfirmReprovision;
      contentDirty = true;
      return;
    case Act::ConfirmNo:
      modal = Modal::None;
      contentDirty = true;
      return;
    case Act::ConfirmYes: {
      const Modal which = modal;
      modal = Modal::None;
      if (which == Modal::ConfirmApproval) {
        answerApproval(pendingApprovalId, pendingApprovalSummary, true);
      } else if (which == Modal::ConfirmReprovision) {
        message = "Re-entering provisioning";
        contentDirty = true;
        prov->resetToProvisioning();
      } else {
        // Re-entered with the confirmation already given, which is why local confirmation lives
        // here and not inside runControl(): the gate must not loop back on itself.
        dispatchControl(pendingControl);
      }
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Touch routing
// ---------------------------------------------------------------------------------------------

int16_t maxScroll(size_t count, int16_t rowH, int16_t top) {
  const int16_t content = (int16_t)count * rowH;
  const int16_t viewport = (int16_t)(contentBottom() - top);
  return content > viewport ? (int16_t)(content - viewport) : 0;
}

bool barVisible() { return barT > 0.9f && actionCount > 0; }

void handleBarTap(int16_t x) {
  const int16_t top = (int16_t)(kH - kBarH);
  for (uint8_t i = 0; i < actionCount; ++i) {
    const Rect r = actionRect(i, top);
    // Vertically generous: the tray is 58 px tall and the capsule inside it is 36, and a thumb
    // that lands on the tray meant the button under it.
    if (x >= r.x - 4 && x < r.x + r.w + 4) {
      if (actions[i].enabled) runAction(actions[i].id);
      return;
    }
  }
}

void handleDrawerTap(int16_t x, int16_t y) {
  if (y < kContentTop) { closeDrawer(); return; }
  for (uint8_t i = 0; i < drawerRowCount; ++i) {
    const Rect r = drawerRowRect(i);
    if (r.y + r.h > kContentTop + drawerShownPx - 10) break;
    if (uip::hit(r, x, y)) {
      const Row row = drawerRows[i];
      closeDrawerNow();
      openCategory(row);
      return;
    }
  }
  // Anywhere below the panel is "put it away", which is the gesture everybody already knows.
  closeDrawer();
}

void handleContentTap(int16_t x, int16_t y) {
  switch (screen) {
    case Screen::Threads: {
      if (uip::hit(kBreadcrumb, x, y)) {
        goTo(Screen::Environments);
        if (browse.environmentCount() == 0) refreshEnvironments();
        return;
      }
      const int16_t local = (int16_t)(y - kThreadListTop + threadScroll);
      if (local < 0) return;
      const size_t index = (size_t)(local / kThreadRowH);
      if (index < gw->threadCount()) selectThreadRow(index);
      return;
    }
    case Screen::Environments: {
      const int16_t local = (int16_t)(y - kBrowseListTop + envScroll);
      if (local < 0) return;
      const size_t index = (size_t)(local / kBrowseRowH);
      if (index < browse.environmentCount()) selectEnvironmentRow(index);
      return;
    }
    case Screen::Projects: {
      const int16_t local = (int16_t)(y - kBrowseListTop + projectScroll);
      if (local < 0) return;
      const size_t index = (size_t)(local / kBrowseRowH);
      if (index < browse.projectCount()) selectProjectRow(index);
      return;
    }
    case Screen::Send: {
      if (uip::hit(kMicButton, x, y)) {
        if (clipHeld) {
          message = "Send or discard the clip below";
        } else {
          // Handled on Press, not Tap: a hold never produces a tap. Landing here means the finger
          // came and went too quickly to be a recording.
          message = "Hold the button while you speak";
        }
        contentDirty = true;
        return;
      }
      const int16_t local = (int16_t)(y - kActionListTop + actionScroll);
      if (local < 0) return;
      const size_t index = (size_t)(local / kActionRowH);
      const DeviceControl* c = gw->control(index);
      if (c) runControlRow(*c);
      return;
    }
    case Screen::Response: {
      if (!gw->responseOpen()) return;
      const ThreadResponse& r = gw->response();
      for (size_t i = 0; i < r.followUpCount && i < 2; ++i) {
        if (uip::hit(i == 0 ? kFollowLeft : kFollowRight, x, y)) {
          // A suggestion gets no shortcut past the local review step.
          confirmControl(r.followUps[i]);
          return;
        }
      }
      return;
    }
    default:
      return;
  }
}

void handleTap(int16_t x, int16_t y) {
  if (drawerT > 0.05f) { handleDrawerTap(x, y); return; }

  if (y < kContentTop) {
    if (canGoBack() && uip::hit(kBackHit, x, y)) { goBack(); return; }
    if (uip::hit(kHandleHit, x, y)) { openDrawer(); return; }
    return;
  }

  if (screen == Screen::Status) {
    // The one thing an unclaimed device can be asked for: a replacement code. Deliberately behind a
    // tap on the code itself rather than anything ambient — rotating invalidates the code the owner
    // may be part-way through typing, which is also why this is not an action-bar button.
    if (unclaimed() && y >= kClaimTop && y < kClaimTop + 46) {
      showBusy("New code", "Asking the gateway");
      gw->requestNewClaimCode();
      contentDirty = true;
    }
    return;
  }

  if (barVisible() && y >= kH - kBarH) { handleBarTap(x); return; }
  // A modal owns the content region; its two answers live in the action bar, and a tap anywhere
  // else inside the dialog does nothing rather than something surprising.
  if (modal != Modal::None) return;
  if (!operable() && !configScreen()) return;
  handleContentTap(x, y);
}

void handleDrag(int16_t y, int16_t dy) {
  if (modal != Modal::None) return;
  // A finger held on the microphone wanders; scrolling the list under it while it records is not
  // what anybody meant by that.
  if (recordArmed) return;

  // The pull-down. Only a finger that STARTED in the header drives the drawer, so a list that
  // scrolls past the top edge never turns into one.
  if (dragFromHeader || drawerT > 0.05f) {
    if (dragFromHeader && dy > 0 && !drawerOpen) { openDrawer(); return; }
    if (drawerOpen && dy < 0) { closeDrawer(); return; }
    return;
  }
  (void)y;

  if (screen == Screen::Threads) {
    const int16_t limit = maxScroll(gw->threadCount(), kThreadRowH, kThreadListTop);
    int16_t next = (int16_t)(threadScroll - dy);
    if (next < 0) next = 0;
    if (next > limit) next = limit;
    if (next != threadScroll) { threadScroll = next; contentDirty = true; }
    return;
  }
  if (screen == Screen::Environments) {
    const int16_t limit = maxScroll(browse.environmentCount(), kBrowseRowH, kBrowseListTop);
    int16_t next = (int16_t)(envScroll - dy);
    if (next < 0) next = 0;
    if (next > limit) next = limit;
    if (next != envScroll) { envScroll = next; contentDirty = true; }
    return;
  }
  if (screen == Screen::Projects) {
    const int16_t limit = maxScroll(browse.projectCount(), kBrowseRowH, kBrowseListTop);
    int16_t next = (int16_t)(projectScroll - dy);
    if (next < 0) next = 0;
    if (next > limit) next = limit;
    if (next != projectScroll) { projectScroll = next; contentDirty = true; }
    return;
  }
  if (screen == Screen::Send) {
    const int16_t limit = maxScroll(gw->controlCount(), kActionRowH, kActionListTop);
    int16_t next = (int16_t)(actionScroll - dy);
    if (next < 0) next = 0;
    if (next > limit) next = limit;
    if (next != actionScroll) { actionScroll = next; contentDirty = true; }
  }
}

}  // namespace

// ---------------------------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------------------------

bool uiBegin(GatewayClient& gateway, Provisioning& provisioning, DeviceStore& deviceStore) {
  gw = &gateway;
  prov = &provisioning;
  store = &deviceStore;
  browse.begin(deviceStore);

  orbReady = orb.begin(kOrbPx - 8, 900);
  // A fifth of the home orb's dot budget. It is 44 px across; a denser cloud at that size reads as
  // a smudge, and the point of it is only to show that something is still happening.
  miniReady = miniOrb.begin(kMiniOrbPx - 4, 180);
  orbStartedAt = millis();
  setMode(OrbMode::Ring);
  rebuildDrawerRows();
  chromeDirty = true;
  contentDirty = true;
  return orbReady && miniReady;
}

void uiHandleTouch(const TouchEvent& event) {
  if (!displayReady() || !gw || !prov) return;

  switch (event.gesture) {
    case TouchGesture::Press:
      dragFromHeader = event.y < kContentTop;
      // Push-to-talk starts on contact, not on release: waiting for the lift would record nothing.
      if (operable() && modal == Modal::None && screen == Screen::Send && !clipHeld
          && drawerT <= 0.05f && uip::hit(kMicButton, event.x, event.y)) {
        startRecording();
      }
      return;

    case TouchGesture::Drag:
      handleDrag(event.y, event.dy);
      return;

    case TouchGesture::Release:
      dragFromHeader = false;
      if (recordArmed) finishRecording();
      return;

    case TouchGesture::Tap:
      dragFromHeader = false;
      if (recordArmed) { finishRecording(); return; }
      handleTap(event.x, event.y);
      return;

    case TouchGesture::SwipeLeft:
    case TouchGesture::SwipeRight: {
      dragFromHeader = false;
      if (recordArmed) { finishRecording(); return; }
      if (drawerT > 0.05f) { closeDrawer(); return; }
      // Paging, and only paging. A swipe that changed screens would fight the list scroll and the
      // response pages for the same gesture.
      if (!operable() || modal != Modal::None || screen != Screen::Response) return;
      if (!gw->responseOpen()) return;
      const ThreadResponse& r = gw->response();
      if (r.pageCount <= 1) return;
      const int next = event.gesture == TouchGesture::SwipeLeft
        ? (r.page + 1) % r.pageCount
        : (r.page + r.pageCount - 1) % r.pageCount;
      showBusy("Reply", "Loading page");
      gw->fetchResponsePage(next);
      contentDirty = true;
      return;
    }

    case TouchGesture::LongPress:
      if (recordArmed) return;   // a long hold on the microphone is the whole point of it
      Serial.println("[provisioning] long press - opening the config portal.");
      message = "Config portal open";
      contentDirty = true;
      prov->openConfigPortal();
      return;

    default:
      return;
  }
}

void uiTick() {
  if (!displayReady()) return;
  // setup() returns early when NVS is unavailable — a wrong partition table — without ever calling
  // uiBegin(). The board is dead at that point, but it must say so on the serial line rather than
  // panicking on a null pointer thirty times a second.
  if (!gw || !prov) return;

  // Recording owns the loop while it runs. The I2S ring holds tens of milliseconds, so the pump
  // has to be tighter than the frame budget; the orb stops for the duration and the button's own
  // timer is the moving thing instead. Redrawn four times a second, because a full frame between
  // reads is how a clip gains a gap.
  if (recordArmed && audio::recording()) {
    const uint32_t until = millis() + 25;
    while ((int32_t)(millis() - until) < 0) {
      if (!audio::pumpRecording()) break;
    }
    // The lift, taken from the held state rather than from a gesture. touchPoll() only decides
    // between a tap, a swipe and a release once the finger is off, and which of those it picks is
    // not this loop's business: a clip ends when the glass stops being touched. Reading it here
    // also means a hold that was already consumed as something else — a long press, say — cannot
    // leave the recording running.
    if (!touchDown()) {
      finishRecording();
      return;
    }

    const uint32_t now = millis();
    if (now - recordPaintedAt >= 250) {
      recordPaintedAt = now;
      paintMicButton();
    }
    // A ceiling was hit while the finger is still down: stop here rather than waiting for a lift
    // that may not come for another twenty seconds.
    if (!audio::recording()) finishRecording();
    nextFrameAt = millis();
    return;
  }

  const uint32_t now = millis();
  if (nextFrameAt == 0) nextFrameAt = now;
  if ((int32_t)(now - nextFrameAt) < 0) return;
  // Paced against a running deadline rather than "33 ms since the last frame finished". The latter
  // adds the draw time to every interval, so a 27 ms draw yields 37 ms frames — 27 fps that also
  // wanders as the draw cost changes.
  nextFrameAt += kFrameMs;
  // If a frame ran long, do not catch up by drawing several back to back — that reads as a stutter
  // followed by a sprint. Drop the missed slots and resync.
  if ((int32_t)(now - nextFrameAt) > (int32_t)kFrameMs) nextFrameAt = now + kFrameMs;

  if (lastFrameAt != 0) {
    const uint32_t gap = now - lastFrameAt;
    if (gap > stats.worstGapMs) stats.worstGapMs = gap;
    if (gap > stats.worstGapEverMs) stats.worstGapEverMs = gap;
    if (gap > kFrameMs * 3 / 2) { stats.hitches++; stats.hitchesEver++; }
  }
  lastFrameAt = now;

  // modeForState() lower-cases a thread status and hands string literals to the shared mapper, so
  // every call is a heap round trip. Running it once a frame is the per-frame allocation this path
  // is meant to be free of — sixty malloc/free pairs a second, fragmenting the internal heap the
  // orb buffers live in. Its answer only moves when the client's revision does, when the link
  // changes, or when the microphone opens, so it is recomputed on those edges instead.
  static bool recordingWas = false;
  const bool recordingNow = audio::recording();
  bool modeDirty = recordingNow != recordingWas;
  recordingWas = recordingNow;

  // Observing the client is guarded, rendering is not.
  //
  // The gateway's network task holds this lock across a request, so waiting for it would put a
  // multi-second socket back in front of the renderer — the exact stall this split removes. A zero
  // timeout means a frame that arrives mid-request simply reuses the previous frame's values and
  // draws on time; text is at most a few frames stale, which is invisible, and the orb never
  // stops.
  static GatewayLink link = GatewayLink::Idle;
  static ProvisioningState provState = ProvisioningState::Unprovisioned;

  const bool observed = gw->tryLockState(0);
  if (observed) {

  // Claim state and link state change asynchronously — the owner is typing a code on another
  // device — so the screen is driven by them rather than only by what the finger did.
  link = gw->link();
  provState = prov->status().state;
  if (link != lastLink || provState != lastProvState) {
    lastLink = link;
    lastProvState = provState;
    if (!operable() && screen != Screen::Status && !configScreen()) {
      screen = Screen::Status;
      message = "";
    }
    if (operable() && screen == Screen::Status) { screen = Screen::Home; message = ""; }
    rebuildDrawerRows();
    chromeDirty = true;
    contentDirty = true;
    modeDirty = true;
  }
  if (gw->revision() != lastRevision) {
    lastRevision = gw->revision();
    contentDirty = true;
    drawerDirty = true;
    modeDirty = true;
  }
  if (browse.revision() != lastBrowseRevision) {
    lastBrowseRevision = browse.revision();
    contentDirty = true;
  }
  if (gw->approvalCount() != lastApprovalCount) {
    lastApprovalCount = gw->approvalCount();
    drawerDirty = true;
  }
  if (screen != lastScreen || modal != lastModal) {
    lastScreen = screen;
    lastModal = modal;
    chromeDirty = true;
    contentDirty = true;
  }

  gw->unlockState();
  }   // observed

#if ORB_BENCH
  // The bench walks the modes on a timer; nothing the gateway says drives them here.
  (void)modeDirty;
  if ((int32_t)(now - benchNextAt) >= 0) {
    benchNextAt = now + 6000;
    benchIndex = (uint8_t)((benchIndex + 1) % (uint8_t)OrbMode::ModeCount);
    setMode(orbModeAt(benchIndex));
    statusLabel = orbLabelForMode(currentMode);
    contentDirty = true;
  }
#else
  if (modeDirty) {
    const OrbMode wanted = modeForState();
    if (wanted != currentMode) setMode(wanted);
  }
  // Assigned from const char*, never through a String temporary: Arduino's String reuses its own
  // buffer for an assignment that fits, so this costs nothing, while wrapping either arm in
  // String(...) would allocate and free once a frame.
  statusLabel = recordingNow ? "Listening" : orbLabelForMode(currentMode);
  if (!operable()) {
    switch (link) {
      case GatewayLink::Unclaimed:   statusLabel = "Claim me"; break;
      case GatewayLink::Revoked:     statusLabel = "Revoked"; break;
      case GatewayLink::NoIdentity:  statusLabel = "Not set up"; break;
      case GatewayLink::Unreachable: statusLabel = "No gateway"; break;
      default:
        statusLabel = provState == ProvisioningState::Provisioning ? "Set up" : "Connecting";
        break;
    }
  }
#endif

  const uint32_t drawStart = millis();

  // The drawer eases open and shut. While it is moving nothing else in the content region is
  // painted: it covers all of it, and repainting underneath would be work nobody can see.
  const float drawerTarget = drawerOpen ? 1.0f : 0.0f;
  const float nextDrawerT = uip::approach(drawerT, drawerTarget, kFrameMs, kDrawerSlideMs);
  const bool drawerMoved = nextDrawerT != drawerT;
  drawerT = nextDrawerT;

  // The bar's contents are decided every frame and its presence follows from them. Hidden entirely
  // while the drawer is out: the drawer's own rows are the navigation, and two competing sets of
  // controls on one screen is what the tab bar used to be.
  buildActions();
  const uint32_t sig = signatureOfActions();
  if (sig != actionSignature) {
    actionSignature = sig;
    barDirty = true;
  }
  const float barTarget = (actionCount > 0 && drawerT <= 0.001f && !drawerOpen) ? 1.0f : 0.0f;
  const float nextBarT = uip::approach(barT, barTarget, kFrameMs, kBarSlideMs);
  const bool barMoved = nextBarT != barT;
  barT = nextBarT;
  const bool reserve = barT > 0.001f;
  if (reserve != barReserved) {
    barReserved = reserve;
    contentDirty = true;
  }

  if (chromeDirty) drawChrome();

  // Order is load-bearing, three times over.
  //
  // The BAR goes first because clearContent() stops at contentBottom(): with the bar out, a content
  // repaint no longer touches the bottom band, and with the bar gone the same repaint reclaims it.
  // Painting the bar afterwards would have it wipe the content it had just been given room beside.
  //
  // The DRAWER goes second because on the frames where both move — the bar retracting as the drawer
  // opens — the drawer is the one arriving and the two overlap by four pixels at full extension.
  //
  // The CONTENT goes last and only when the drawer is fully away, because the drawer covers all of
  // it and repainting underneath is work nobody can see.
  if (barMoved || barDirty) paintActionBar();

  const bool drawerActive = drawerMoved || drawerT > 0.0f || drawerShownPx > 0;
  if (drawerActive && (drawerMoved || drawerDirty)) {
    paintDrawerFrame();
    // Fully retracted: whatever the drawer was covering has to come back.
    if (drawerT <= 0.0f && drawerShownPx <= 0) contentDirty = true;
  }
  drawerDirty = false;

  if (contentDirty && drawerT <= 0.001f) paintContent();

  // Only the orb and its label animate. Everything else is repainted on change, which is what keeps
  // a list screen inside the frame budget: a full list redraw costs several frames' worth of SPI
  // and happens once, when the list actually changed.
  const uint32_t elapsed = now - orbStartedAt;
  const bool bigOrb = (screen == Screen::Home || screen == Screen::Status)
    && modal == Modal::None && drawerT <= 0.001f;
  if (bigOrb && orbReady) {
    displayDrawOrb(orb, kOrbCx, kOrbCy, elapsed);
    // The claim block starts where the label would be, and the label's strip is full width: drawing
    // both means the code is repainted over four times a second by a word.
    if (unclaimed()) {
      shownLabel = "";
    } else if (statusLabel != shownLabel) {
      displayClearStatus(kLabelY);
      shownLabel = statusLabel;
    }
    if (!unclaimed()) displayDrawStatus(statusLabel.c_str(), kLabelY, elapsed);
  } else if (miniReady) {
    displayDrawMiniOrb(miniOrb, kMiniOrbCx, kMiniOrbCy, elapsed);
    shownLabel = "";
  }
  // The header's right-hand affordance never disappears: with the big orb up there is no mini orb
  // to be the handle, so a dot and a chevron stand in for it.
  if (bigOrb && orbReady) drawHeaderStatusDot();

  const uint32_t drawMs = millis() - drawStart;
  if (drawMs > stats.worstDrawMs) stats.worstDrawMs = drawMs;
  stats.frames++;

  static uint32_t lastReport = 0;
  if (lastReport == 0) lastReport = now;
  if (now - lastReport >= 2000) {
    const uint32_t windowMs = now - lastReport;
    stats.fps = stats.frames * 1000.0f / windowMs;
    // The mode is on the line because draw cost varies enormously between them, so a slow frame is
    // only diagnosable if you know what was being drawn.
    Serial.printf("[fps] %-10s %.1f  draw<=%ums  gap<=%ums  hitches=%u  budget=%ums  heap=%u\n",
                  orbStateName(currentMode), stats.fps, (unsigned)stats.worstDrawMs,
                  (unsigned)stats.worstGapMs, (unsigned)stats.hitches, (unsigned)kFrameMs,
                  (unsigned)ESP.getFreeHeap());
    Serial.printf("      since boot: worst gap %u ms, %u hitches, up %u s\n",
                  (unsigned)stats.worstGapEverMs, (unsigned)stats.hitchesEver,
                  (unsigned)(millis() / 1000));
    stats.frames = 0;
    stats.worstDrawMs = 0;
    stats.worstGapMs = 0;
    stats.hitches = 0;
    lastReport = now;
  }
}

void uiSleepUntilNextFrame() {
  // Sleep until the next frame is actually due rather than spinning on delay(1). Polling in 1 ms
  // steps means a frame fires on the first iteration AFTER its deadline, so the interval lands
  // anywhere in 33..36 ms even though the work took 23 ms. That wander is small in absolute terms
  // and very visible in an animation.
  const int32_t waitMs = (int32_t)(nextFrameAt - millis());
  if (waitMs > 1) delay((uint32_t)(waitMs - 1));
  else delay(1);
}
