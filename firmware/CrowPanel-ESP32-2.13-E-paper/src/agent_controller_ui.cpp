#if defined(CONTROLLER_CONFIG_PLACEHOLDER_BUILD)
#include "controller_config.example.h"
#elif __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#include "agent_controller_ui.h"

#if ENABLE_EINK
#include "EPD.h"
#include "EPD_Init.h"
#include <cstring>

namespace acui {
namespace {

extern "C" uint8_t ImageBW[ALLSCREEN_BYTES];

constexpr uint16_t kCanvasWidth = 250;
constexpr uint16_t kCanvasHeight = 122;
constexpr uint16_t kControlRailRight = 43;
constexpr uint16_t kContentLeft = 47;
constexpr uint16_t kHeaderBottom = 22;
constexpr uint16_t kFooterTop = 102;
constexpr uint8_t kFontSmall = 12;
constexpr uint8_t kFontBody = 16;

// EPD_DrawPoint's color convention is inverted in the vendor driver when the
// landscape transform is active. WHITE clears a framebuffer bit and therefore
// paints visible black ink on the physical panel.
void ink(uint16_t x, uint16_t y) {
  if (x < kCanvasWidth && y < kCanvasHeight) EPD_DrawPoint(x, y, WHITE);
}

void inkLine(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1) {
  if (x0 == x1) {
    for (uint16_t y = y0; y <= y1 && y < kCanvasHeight; y += 1) ink(x0, y);
    return;
  }
  if (y0 == y1) {
    for (uint16_t x = x0; x <= x1 && x < kCanvasWidth; x += 1) ink(x, y0);
    return;
  }
  EPD_DrawLine(x0, y0, x1, y1, WHITE);
}

void inkRect(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1) {
  inkLine(x0, y0, x1, y0);
  inkLine(x0, y1, x1, y1);
  inkLine(x0, y0, x0, y1);
  inkLine(x1, y0, x1, y1);
}

// Original Agent Controller glyph set. Each icon is a purpose-built 12 x 12
// monochrome bitmap: no vendor/product artwork or external assets are copied.
constexpr uint8_t kIconAgent[] = {
  0x3f,0xc0, 0x40,0x20, 0x9f,0x10, 0xa0,0x50,
  0xa4,0x50, 0xa0,0x50, 0x91,0x10, 0x8e,0x10,
  0x80,0x10, 0x5f,0x20, 0x20,0x40, 0x1f,0x80,
};
constexpr uint8_t kIconHome[] = {
  0x06,0x00, 0x0f,0x00, 0x19,0x80, 0x30,0xc0,
  0x60,0x60, 0xc0,0x30, 0x9f,0x90, 0x90,0x90,
  0x90,0x90, 0x97,0x90, 0x94,0x90, 0xff,0xf0,
};
constexpr uint8_t kIconAction[] = {
  0x00,0x00, 0x30,0x00, 0x18,0x00, 0x0c,0x00,
  0xfe,0x00, 0x03,0x00, 0x01,0x80, 0x03,0x00,
  0x06,0x00, 0x0c,0x00, 0x18,0x00, 0x00,0x00,
};
constexpr uint8_t kIconThread[] = {
  0x00,0x00, 0x70,0x00, 0x88,0x00, 0x88,0x00,
  0x70,0x00, 0x20,0x00, 0x20,0x00, 0x27,0x00,
  0x28,0x80, 0x28,0x80, 0x27,0x00, 0x00,0x00,
};
constexpr uint8_t kIconGateway[] = {
  0x00,0x00, 0x10,0x00, 0x38,0x00, 0x54,0x00,
  0x92,0x00, 0x10,0x00, 0x7c,0x00, 0x10,0x00,
  0x10,0x00, 0x38,0x00, 0x44,0x00, 0x82,0x00,
};
constexpr uint8_t kIconFirmware[] = {
  0x0f,0x00, 0x10,0x80, 0x20,0x40, 0x44,0x20,
  0x44,0x20, 0x7f,0xe0, 0x04,0x00, 0x04,0x00,
  0x15,0x00, 0x0e,0x00, 0x04,0x00, 0x00,0x00,
};
constexpr uint8_t kIconStatus[] = {
  0x00,0x00, 0x00,0x00, 0x81,0x00, 0x82,0x00,
  0x44,0x00, 0x28,0x00, 0x10,0x00, 0x28,0x00,
  0x44,0x00, 0x82,0x00, 0x81,0x00, 0x00,0x00,
};
constexpr uint8_t kIconStop[] = {
  0x1f,0x80, 0x20,0x40, 0x40,0x20, 0x8f,0x10,
  0x9f,0x90, 0x9f,0x90, 0x9f,0x90, 0x9f,0x90,
  0x8f,0x10, 0x40,0x20, 0x20,0x40, 0x1f,0x80,
};
constexpr uint8_t kIconWarning[] = {
  0x06,0x00, 0x06,0x00, 0x0f,0x00, 0x09,0x00,
  0x19,0x80, 0x31,0xc0, 0x21,0x40, 0x61,0x60,
  0xc0,0x30, 0xc1,0x30, 0x7f,0xe0, 0x00,0x00,
};
constexpr uint8_t kIconSuccess[] = {
  0x00,0x00, 0x00,0x10, 0x00,0x30, 0x00,0x60,
  0x80,0xc0, 0xc1,0x80, 0x63,0x00, 0x36,0x00,
  0x1c,0x00, 0x08,0x00, 0x00,0x00, 0x00,0x00,
};
constexpr uint8_t kIconError[] = {
  0x00,0x00, 0x80,0x10, 0x40,0x20, 0x20,0x40,
  0x10,0x80, 0x09,0x00, 0x09,0x00, 0x10,0x80,
  0x20,0x40, 0x40,0x20, 0x80,0x10, 0x00,0x00,
};

const uint8_t* bitmapFor(Icon icon) {
  switch (icon) {
    case Icon::Home: return kIconHome;
    case Icon::Action: return kIconAction;
    case Icon::Thread: return kIconThread;
    case Icon::Gateway: return kIconGateway;
    case Icon::Firmware: return kIconFirmware;
    case Icon::Status: return kIconStatus;
    case Icon::Stop: return kIconStop;
    case Icon::Warning: return kIconWarning;
    case Icon::Success: return kIconSuccess;
    case Icon::Error: return kIconError;
    default: return kIconAgent;
  }
}

void drawIcon(uint16_t x, uint16_t y, Icon icon) {
  const uint8_t* bitmap = bitmapFor(icon);
  for (uint8_t row = 0; row < 12; row += 1) {
    const uint16_t bits = static_cast<uint16_t>(bitmap[row * 2]) << 8 | bitmap[row * 2 + 1];
    for (uint8_t col = 0; col < 12; col += 1) {
      if ((bits & (0x8000 >> col)) != 0) ink(x + col, y + row);
    }
  }
}

void text(uint16_t x, uint16_t y, const String& value, uint8_t size) {
  EPD_ShowString(x, y, value.c_str(), BLACK, size);
}

String upperState(const String& input) {
  String state = safeLabel(input, 9);
  state.toUpperCase();
  if (state.length() == 0) state = "IDLE";
  return state;
}

void renderHeader(const Frame& frame) {
  drawIcon(49, 5, frame.icon);
  const String state = upperState(frame.state);
  const uint16_t stateWidth = state.length() * 6;
  const uint16_t stateX = 247 - stateWidth - 3;
  inkRect(stateX - 3, 3, 247, 19);
  text(stateX, 5, state, kFontSmall);

  const uint16_t titleX = 67;
  const size_t titleChars = stateX > titleX + 4 ? (stateX - titleX - 4) / 6 : 10;
  text(titleX, 5, safeLabel(frame.title, titleChars), kFontSmall);
  inkLine(kContentLeft, kHeaderBottom, 247, kHeaderBottom);
  // Two small terminal ticks establish the product's original AC// motif.
  inkLine(47, 2, 53, 2);
  inkLine(47, 2, 47, 8);
}

uint16_t centeredRailTextX(const String& value) {
  const uint16_t width = value.length() * 6;
  return width < kControlRailRight ? (kControlRailRight - width) / 2 : 2;
}

void renderControlRail(const Frame& frame) {
  // In the installed orientation the bezel controls are stacked immediately to the left:
  // MENU at the top, the three rotary switches at center, and EXIT at the bottom.
  // Keeping the labels at those same heights lets the display teach the hardware without a legend.
  inkLine(kControlRailRight, 2, kControlRailRight, 119);
  const String menu = safeLabel(frame.menuLabel, 6);
  const String back = safeLabel(frame.backLabel, 6);
  text(centeredRailTextX(menu), 5, menu, kFontSmall);

  text(centeredRailTextX("^"), 36, "^", kFontSmall);
  text(centeredRailTextX("OK"), 57, "OK", kFontSmall);
  text(centeredRailTextX("v"), 78, "v", kFontSmall);

  text(centeredRailTextX(back), 106, back, kFontSmall);
}

void renderList(const Frame& frame) {
  constexpr uint16_t kRowY[3] = {27, 52, 77};
  for (size_t i = 0; i < frame.rowCount && i < 3; i += 1) {
    const Row& row = frame.rows[i];
    const uint16_t y = kRowY[i];
    if (row.selected) {
      inkLine(kContentLeft, y - 2, 247, y - 2);
      inkLine(kContentLeft, y + 20, 247, y + 20);
      text(48, y + 2, ">", kFontSmall);
    } else {
      text(48, y + 2, row.disabled ? "x" : " ", kFontSmall);
    }
    drawIcon(59, y + 2, row.icon);

    const String meta = safeLabel(row.meta, 8);
    const uint16_t metaWidth = meta.length() * 6;
    const uint16_t metaX = meta.length() > 0 ? 247 - metaWidth - 3 : 247;
    if (meta.length() > 0) text(metaX, y + 2, meta, kFontSmall);
    const uint16_t labelX = 77;
    const size_t labelChars = metaX > labelX + 4 ? (metaX - labelX - 4) / 6 : 12;
    text(labelX, y + 2, safeLabel(row.label, labelChars), kFontSmall);
  }
}

void renderSummary(const Frame& frame) {
  constexpr uint16_t kRowY[3] = {27, 52, 77};
  for (size_t i = 0; i < frame.rowCount && i < 3; i += 1) {
    const Row& row = frame.rows[i];
    const uint16_t y = kRowY[i];
    drawIcon(50, y + 2, row.icon);

    const String meta = safeLabel(row.meta, 8);
    const uint16_t metaWidth = meta.length() * 6;
    const uint16_t metaX = meta.length() > 0 ? 247 - metaWidth - 3 : 247;
    if (meta.length() > 0) text(metaX, y + 2, meta, kFontSmall);
    const uint16_t labelX = 67;
    const size_t labelChars = metaX > labelX + 4 ? (metaX - labelX - 4) / 6 : 14;
    text(labelX, y + 2, safeLabel(row.label, labelChars), kFontSmall);
    if (i + 1 < frame.rowCount) inkLine(kContentLeft, y + 22, 247, y + 22);
  }
}

void renderDetail(const Frame& frame) {
  // A terminal prompt is decoration with meaning: '$' is gateway/system output,
  // while '>' is the currently relevant next fact. It remains ASCII-only.
  text(50, 34, "$", kFontBody);
  text(66, 34, safeLabel(frame.line1, 22), kFontBody);
  text(50, 64, ">", kFontBody);
  text(66, 64, safeLabel(frame.line2, 22), kFontBody);
  inkLine(50, 91, 63, 91);
  inkLine(50, 94, 56, 94);
}

void renderTextPage(const Frame& frame) {
  constexpr uint16_t kLineY[3] = {30, 54, 78};
  for (size_t index = 0; index < frame.textLineCount && index < 3; index += 1) {
    text(50, kLineY[index], safeLabel(frame.textLines[index], 31), kFontSmall);
  }
}

void renderContextFooter(const Frame& frame) {
  inkLine(kContentLeft, kFooterTop, 247, kFooterTop);
  if (frame.footerLabel.length() > 0) text(50, 106, safeLabel(frame.footerLabel, 32), kFontSmall);
  else if (frame.listMode) text(50, 106, "ROTATE:MOVE", kFontSmall);
  else if (frame.summaryMode) text(50, 106, "OK:STATUS MENU:ACTIONS", kFontSmall);
}

}  // namespace

String safeLabel(const String& value, size_t maxChars) {
  String output;
  output.reserve(value.length() < maxChars ? value.length() : maxChars);
  for (size_t i = 0; i < value.length() && output.length() < maxChars; i += 1) {
    const char c = value.charAt(i);
    output += (c >= ' ' && c <= '~') ? c : '?';
  }
  if (value.length() > maxChars && maxChars >= 2) {
    output.remove(maxChars - 1);
    output += '~';
  }
  return output;
}

void render(const Frame& frame) {
  memset(ImageBW, 0xFF, ALLSCREEN_BYTES);
  renderControlRail(frame);
  renderHeader(frame);
  if (frame.listMode) renderList(frame);
  else if (frame.summaryMode) renderSummary(frame);
  else if (frame.textPageMode) renderTextPage(frame);
  else renderDetail(frame);
  renderContextFooter(frame);
  EPD_DisplayImage(ImageBW);
  EPD_Update();
}

}  // namespace acui
#else
namespace acui {
String safeLabel(const String& value, size_t maxChars) {
  return value.substring(0, value.length() < maxChars ? value.length() : maxChars);
}
}  // namespace acui
#endif
