// The operate half of GatewayClient: runtime context, saved actions, threads, dispatch, response
// paging, and the approval queue.
//
// Split from GatewayClient.cpp because that file owns one thing — getting a unit onto an account —
// and this one owns what it does afterwards. Same class, two translation units.
//
// Ported from the CrowPanel firmware, which is the only build verified end to end against a live
// gateway and a live T3 Code. Where a shape here looks arbitrary it is because the wire format is,
// and the comments say which constraint produced it.

#include "GatewayClient.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "MediaUpload.h"

namespace {

// Percent-encoding for a path segment. Action ids and ISO timestamps both land in a URL, and a
// timestamp's colons are not path-safe.
String encodePathSegment(const String& value) {
  static const char* digits = "0123456789ABCDEF";
  String encoded;
  encoded.reserve(value.length());
  for (size_t i = 0; i < value.length(); i += 1) {
    const uint8_t c = static_cast<uint8_t>(value[i]);
    const bool safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
      || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~';
    if (safe) {
      encoded += static_cast<char>(c);
    } else {
      encoded += '%';
      encoded += digits[(c >> 4) & 0x0F];
      encoded += digits[c & 0x0F];
    }
  }
  return encoded;
}

bool ok(int code) { return code >= 200 && code < 300; }

// Minimal JSON string escaping for the three fields that go in the upload prefix. Only the file
// name is caller-controlled and it is generated, not typed, but a raw quote in it would produce a
// body the gateway rejects with no clue as to why.
String jsonEscape(const String& value) {
  String out;
  out.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); i += 1) {
    const char c = value[i];
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<uint8_t>(c) < 0x20) continue;
        out += c;
    }
  }
  return out;
}

// Turns a gateway status into something the person holding the device can act on. The full
// diagnostic stays in the console; this is the one line that tells them what fixes it.
String remedyFor(int code) {
  switch (code) {
    case 401: return "Re-pair T3 in dashboard";
    case 403: return "Re-pair T3 in dashboard";
    case 409: return "No environment set";
    case 429: return "Rate limited; wait";
    case 500:
    case 502: return "Start T3 Code";
    default:  return code > 0 ? String("HTTP ") + code : String("No response");
  }
}

}  // namespace

bool isSupportedControlKind(const String& kind) {
  return kind == "status" || kind == "remote_action" || kind == "capture_audio"
    || kind == "capture_image" || kind == "stop" || kind == "reset";
}

const DeviceControl* GatewayClient::control(size_t index) const {
  return index < controlCount_ ? &controls_[index] : nullptr;
}

const ThreadOption* GatewayClient::thread(size_t index) const {
  return index < threadCount_ ? &threads_[index] : nullptr;
}

const SavedMacro* GatewayClient::macro(size_t index) const {
  return index < macroCount_ ? &macros_[index] : nullptr;
}

const PendingApproval* GatewayClient::approval(size_t index) const {
  return index < approvalCount_ ? &approvals_[index] : nullptr;
}

// ---------------------------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------------------------

// Held by the touch-driven entry points below. Each mutates client state and then blocks in
// request(), which hands the lock back for the socket wait on its own — so the renderer is never
// queued behind a gesture, only behind the microseconds of parsing on either side of it.
namespace {
struct StateLock {
  explicit StateLock(GatewayClient* client) : client_(client) { if (client_) client_->lockState(); }
  ~StateLock() { if (client_) client_->unlockState(); }
  StateLock(const StateLock&) = delete;
  StateLock& operator=(const StateLock&) = delete;
  GatewayClient* client_;
};
}  // namespace

bool GatewayClient::applyConfigJson(const String& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;

  JsonObject config = doc["config"];
  if (config.isNull()) return false;

  // Empty values are meaningful and are applied verbatim. Clearing the selected thread in the
  // console has to disable every requiresThread control immediately; retaining a stale id would
  // leave the device offering actions the gateway will refuse.
  context_.environmentId = config["environmentId"] | "";
  context_.threadId = config["threadId"] | "";

  // Prompt and shell text are different: an empty string there means "not configured", not
  // "cleared", so a blank never overwrites a usable default.
  const char* prompt = config["defaultPrompt"] | "";
  const char* shell = config["shellCommand"] | "";
  if (strlen(prompt) > 0) context_.defaultPrompt = prompt;
  if (strlen(shell) > 0) context_.shellCommand = shell;

  // config.gatewayUrl is deliberately ignored here. Persisting an endpoint that has not been
  // authenticated against strands the unit until a physical reset, and the probe-then-commit dance
  // that makes it safe belongs with the gateway-profile switch protocol, which this class does not
  // implement yet.

  // A v1 gateway ships the menu as bare strings. Under v2 the controls layout is authoritative and
  // this is ignored, permanently — a later config poll must not overwrite it.
  JsonArray menu = config["menu"].as<JsonArray>();
  if (!controlsV2_ && !menu.isNull() && menu.size() > 0) {
    controlCount_ = 0;
    for (JsonVariant item : menu) {
      if (controlCount_ >= kMaxDeviceControls) break;
      const char* word = item | "";
      if (strlen(word) == 0) continue;
      DeviceControl& row = controls_[controlCount_++];
      row = DeviceControl();
      row.id = word;
      row.label = word;
      row.kind = "legacy";
    }
  }
  touch();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------

void GatewayClient::applyDisplayJson(const String& payload) {
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    display_.state = "error";
    display_.line1 = "Bad display JSON";
    display_.line2 = err.c_str();
    touch();
    return;
  }

  // Staged and compared rather than assigned in place. revision() is documented as moving only when
  // a model actually changes, and a renderer that repaints on it takes that literally: bumping it
  // on every poll of an idle account made the display screen clear and redraw itself once per
  // display interval, which on a board with a continuous animation is a visible flash of the orb
  // every few seconds for no reason at all.
  DisplayModel next;
  JsonObject view = doc["display"];
  next.title = view["title"] | "Controller";
  next.state = view["state"] | "unknown";
  next.line1 = view["line1"] | "";
  next.line2 = view["line2"] | "";

  // The only structured view of the account the device protocol offers. There is no device-facing
  // list of environments or projects — the owner binds one environment and the hardware works
  // inside it.
  JsonObject counts = view["counts"];
  next.counts.environments = counts["environments"] | 0;
  next.counts.devices = counts["devices"] | 0;
  next.counts.media = counts["media"] | 0;
  next.counts.macros = counts["macros"] | 0;
  next.counts.commands = counts["commands"] | 0;
  next.counts.onlineDevices = counts["onlineDevices"] | 0;

  const bool changed =
    next.title != display_.title || next.state != display_.state
    || next.line1 != display_.line1 || next.line2 != display_.line2
    || next.counts.environments != display_.counts.environments
    || next.counts.devices != display_.counts.devices
    || next.counts.media != display_.counts.media
    || next.counts.macros != display_.counts.macros
    || next.counts.commands != display_.counts.commands
    || next.counts.onlineDevices != display_.counts.onlineDevices;
  if (changed) display_ = next;

  JsonArray menu = view["menu"].as<JsonArray>();
  const bool legacyMenu = !controlsV2_ && !menu.isNull() && menu.size() > 0;
  if (legacyMenu) {
    controlCount_ = 0;
    for (JsonVariant item : menu) {
      if (controlCount_ >= kMaxDeviceControls) break;
      const char* word = item | "";
      if (strlen(word) == 0) continue;
      DeviceControl& row = controls_[controlCount_++];
      row = DeviceControl();
      row.id = word;
      row.label = word;
      row.kind = "legacy";
    }
  }
  // A v1 menu is rebuilt from scratch every poll, so it is always "new" and always announced. Only
  // a v2 gateway — where the controls layout is authoritative and this block never runs — gets the
  // quiet idle poll.
  if (changed || legacyMenu) touch();
}

void GatewayClient::fetchDisplay() {
  String response;
  const int code = request("GET", "/v1/device/display", "", response);
  if (ok(code)) {
    applyDisplayJson(response);
    return;
  }
  if (code == 403) {
    // Ownership changed under us. Claim state lives in exactly one place, so re-derive it there
    // rather than guessing from an operate route's status.
    nextConfigAt_ = millis();
    return;
  }
  display_.state = "error";
  display_.line1 = "Display poll failed";
  display_.line2 = remedyFor(code);
  touch();
}

// ---------------------------------------------------------------------------------------------
// Controls (saved actions)
// ---------------------------------------------------------------------------------------------

bool GatewayClient::applyControlsJson(const String& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;

  // `layout` is a harmless envelope from early gateway builds; the documented v2 response puts
  // revision and controls at the top level.
  JsonObject root = doc["layout"].as<JsonObject>();
  if (root.isNull()) root = doc.as<JsonObject>();
  JsonArray items = root["controls"].as<JsonArray>();
  if (items.isNull()) return false;

  // Revision 0 is the gateway saying it has no layout, not a layout numbered zero. Accepting it
  // would latch v2 on and permanently discard the legacy menu.
  const uint32_t revision = root["revision"] | 0U;
  if (revision == 0) return false;

  const size_t received = items.size();
  size_t parsed = 0;
  DeviceControl staged[kMaxDeviceControls];
  for (JsonObject item : items) {
    if (parsed >= kMaxDeviceControls) break;
    const char* id = item["id"] | "";
    const char* label = item["label"] | "";
    const char* kind = item["kind"] | "";
    if (strlen(id) == 0 || strlen(label) == 0 || strlen(kind) == 0) continue;

    DeviceControl& row = staged[parsed];
    row.id = id;
    const char* actionId = item["actionId"] | "";
    row.actionId = strlen(actionId) > 0 ? String(actionId) : row.id;
    row.label = label;
    row.kind = kind;
    row.mediaKind = item["mediaKind"] | "";
    row.reason = item["reason"] | "";
    row.enabled = item["enabled"] | true;
    row.requiresThread = item["requiresThread"] | false;
    row.requiresConfirmation = item["requiresConfirmation"] | false;
    // Fail closed. A kind this firmware does not understand is shown but not runnable, so a
    // gateway that adds one cannot make an old device dispatch something it cannot reason about.
    if (!isSupportedControlKind(row.kind)) {
      row.enabled = false;
      row.reason = "Unsupported control";
    }
    parsed += 1;
  }

  for (size_t i = 0; i < parsed; i += 1) controls_[i] = staged[i];
  for (size_t i = parsed; i < kMaxDeviceControls; i += 1) controls_[i] = DeviceControl();
  controlCount_ = parsed;
  controlsV2_ = true;
  controlsRevision_ = revision;
  if (received > kMaxDeviceControls) {
    Serial.printf("[gateway] controls truncated received=%u cap=%u\n",
                  (unsigned)received, (unsigned)kMaxDeviceControls);
  }
  touch();
  return true;
}

void GatewayClient::acknowledgeControls() {
  if (!controlsV2_ || acknowledgedControlsRevision_ == controlsRevision_) return;
  JsonDocument doc;
  doc["revision"] = controlsRevision_;
  doc["protocolVersion"] = 2;
  doc["appliedCount"] = controlCount_;
  String body;
  serializeJson(doc, body);

  String response;
  const int code = request("POST", "/v1/device/controls/ack", body, response);
  if (ok(code)) acknowledgedControlsRevision_ = controlsRevision_;
}

void GatewayClient::fetchControls() {
  String response;
  const int code = request("GET", "/v1/device/controls", "", response);
  if (ok(code)) {
    if (applyControlsJson(response)) acknowledgeControls();
    return;
  }
  // 404/501 is a gateway that predates the controls layout; the legacy menu already in memory stays
  // authoritative. Any other failure is transient and must never clear a good cache — a controller
  // that loses its buttons because of one dropped poll is worse than one showing a stale label.
  if (code == 403) nextConfigAt_ = millis();
}

// ---------------------------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------------------------

String GatewayClient::selectedThreadLabel() const {
  if (context_.threadId.length() == 0) return String("Select a thread");
  for (size_t i = 0; i < threadCount_; i += 1) {
    if ((threads_[i].selected || threads_[i].id == context_.threadId)
        && threads_[i].title.length() > 0) {
      return threads_[i].title;
    }
  }
  // The list has not been fetched this boot. A truncated id is still a stable handle the owner can
  // match against the console.
  const String& id = context_.threadId;
  if (id.length() <= 12) return id;
  return String("~") + id.substring(id.length() - 11);
}

bool GatewayClient::refreshThreads() {
  StateLock guard(this);
  threadCount_ = 0;
  selectedThreadIndex_ = 0;
  threadsDetail_ = "";

  String response;
  const int code = request("GET", "/v1/device/threads", "", response);
  if (!ok(code)) {
    threadsDetail_ = remedyFor(code);
    touch();
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    threadsDetail_ = "Bad thread JSON";
    touch();
    return false;
  }

  // The device never invents a current thread: the gateway names it, and the per-row `selected`
  // flag duplicates it for simple renderers.
  const String current = String(doc["threadId"] | context_.threadId.c_str());
  JsonArray threads = doc["threads"].as<JsonArray>();
  for (JsonObject input : threads) {
    if (threadCount_ >= kMaxThreadOptions) break;
    const String id = String(input["id"] | "");
    if (id.length() == 0) continue;
    ThreadOption& row = threads_[threadCount_];
    row.id = id;
    row.title = String(input["title"] | "Untitled thread");
    row.status = String(input["status"] | "");
    row.status.toUpperCase();
    row.selected = (input["selected"] | false) || id == current;
    if (row.selected) selectedThreadIndex_ = (int)threadCount_;
    threadCount_ += 1;
  }

  if (threadCount_ == 0) threadsDetail_ = "No threads; start one";
  touch();
  return threadCount_ > 0;
}

bool GatewayClient::selectThread(size_t index) {
  StateLock guard(this);
  if (index >= threadCount_) return false;
  ThreadOption& target = threads_[index];

  // Already the active thread. The POST would succeed and change nothing, so skip the round trip
  // but still move the local cursor.
  if (target.selected && target.id == context_.threadId) {
    selectedThreadIndex_ = (int)index;
    return true;
  }

  JsonDocument doc;
  doc["threadId"] = target.id;
  String body;
  serializeJson(doc, body);

  String response;
  const int code = request("POST", "/v1/device/config/thread", body, response);
  if (!ok(code)) {
    // 404 means the id is no longer in the bound environment's live snapshot; the local list is
    // stale, not wrong-headed.
    threadsDetail_ = code == 404 ? String("Refresh thread list") : remedyFor(code);
    touch();
    return false;
  }

  context_.threadId = target.id;
  for (size_t i = 0; i < threadCount_; i += 1) threads_[i].selected = false;
  target.selected = true;
  selectedThreadIndex_ = (int)index;
  threadsDetail_ = "";
  // Availability — Stop especially, and every capture action — belongs to the newly opened thread's
  // state. Without this the previous thread's controls stay on screen until the 30 s poll.
  nextControlsAt_ = millis();
  // A different thread has a different latest response.
  closeResponse();
  touch();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

DispatchResult GatewayClient::readDispatch(int code, const String& response, const String& label) {
  DispatchResult result;
  result.httpStatus = code;
  result.accepted = ok(code);

  JsonDocument doc;
  const bool parsed = deserializeJson(doc, response) == DeserializationError::Ok;
  if (parsed) {
    JsonObject command = doc["command"];
    if (!command.isNull()) {
      result.commandId = String(command["id"] | "");
      result.status = String(command["status"] | "");
    }
    // Three shapes are accepted because three routes answer here: intents nest under `command`,
    // the saved-action route has used `run`, and the earliest builds put status at the top level.
    if (result.status.length() == 0) result.status = String(doc["run"]["status"] | "");
    if (result.status.length() == 0) result.status = String(doc["status"] | "");
    result.responseAfter = String(doc["responseAfter"] | "");

    // A dispatch that resolved synchronously — status, mostly — hands back a rendered screen
    // instead of a turn to wait for.
    JsonObject screen = doc["screen"].as<JsonObject>();
    if (screen.isNull()) screen = doc["command"]["result"].as<JsonObject>();
    if (!screen.isNull()) {
      result.hasScreen = true;
      result.screen.title = screen["title"] | "T3 Code";
      result.screen.state = screen["state"] | "reachable";
      result.screen.line1 = screen["line1"] | label.c_str();
      result.screen.line2 = screen["line2"] | "Updated";
    }
  }

  result.requiresApproval = result.status == "approval_required";
  if (result.requiresApproval) {
    result.detail = "Approval needed";
    // The queue just gained an entry; showing it on the next pass beats waiting out the timer.
    nextApprovalsAt_ = millis();
  } else if (result.status == "completed") {
    result.detail = "Complete";
  } else if (result.status == "dispatched") {
    result.detail = "Dispatched";
  } else if (result.accepted) {
    result.detail = result.status.length() > 0 ? result.status : String("Accepted");
  } else if (code == 403) {
    result.detail = "Action blocked";
  } else if (code == 404) {
    result.detail = "Action unavailable";
  } else if (code == 409) {
    result.detail = "Re-pair T3 in dashboard";
  } else {
    result.detail = remedyFor(code);
  }
  touch();
  return result;
}

DispatchResult GatewayClient::postIntent(const String& intentJson, const String& label) {
  JsonDocument doc;
  // Both ids are omitted rather than sent empty: the gateway falls back to the device's own bound
  // config, and an empty string would be rejected as a malformed field instead.
  if (context_.environmentId.length() > 0) doc["environmentId"] = context_.environmentId;
  if (context_.threadId.length() > 0) doc["threadId"] = context_.threadId;

  JsonDocument intent;
  if (deserializeJson(intent, intentJson)) {
    DispatchResult bad;
    bad.detail = "Malformed intent";
    return bad;
  }
  doc["intent"] = intent.as<JsonObject>();

  String body;
  serializeJson(doc, body);
  String response;
  const int code = request("POST", "/v1/device/intents", body, response);
  return readDispatch(code, response, label);
}

DispatchResult GatewayClient::sendPrompt(const String& text) {
  StateLock guard(this);
  JsonDocument intent;
  intent["type"] = "agent_prompt";
  intent["text"] = text.length() > 0 ? text : context_.defaultPrompt;
  String json;
  serializeJson(intent, json);
  return postIntent(json, "prompt");
}

DispatchResult GatewayClient::sendAudioPrompt(const String& mediaUploadId, const String& prompt) {
  StateLock guard(this);
  if (mediaUploadId.length() == 0) {
    DispatchResult bad;
    bad.detail = "No audio uploaded";
    return bad;
  }
  // No transcript is sent. The device does not transcribe; the gateway uses the upload's own
  // transcript or attaches the clip as context.
  JsonDocument intent;
  intent["type"] = "audio_prompt";
  intent["mediaUploadId"] = mediaUploadId;
  if (prompt.length() > 0) intent["prompt"] = prompt;
  String json;
  serializeJson(intent, json);
  return postIntent(json, "audio");
}

DispatchResult GatewayClient::sendShell(const String& command) {
  StateLock guard(this);
  const String& text = command.length() > 0 ? command : context_.shellCommand;
  if (text.length() == 0) {
    DispatchResult bad;
    bad.detail = "No shell command set";
    return bad;
  }
  JsonDocument intent;
  intent["type"] = "shell_input";
  intent["command"] = text;
  String json;
  serializeJson(intent, json);
  return postIntent(json, "shell");
}

DispatchResult GatewayClient::sendStatus() {
  StateLock guard(this);
  return postIntent("{\"type\":\"status\"}", "status");
}

DispatchResult GatewayClient::sendStop() {
  StateLock guard(this);
  return postIntent("{\"type\":\"session_control\",\"action\":\"stop\"}", "stop");
}

DispatchResult GatewayClient::runAction(const String& actionId, const String& mediaUploadId) {
  StateLock guard(this);
  if (actionId.length() == 0) {
    DispatchResult bad;
    bad.detail = "Action missing id";
    return bad;
  }
  JsonDocument doc;
  if (mediaUploadId.length() > 0) doc["mediaUploadId"] = mediaUploadId;
  String body;
  serializeJson(doc, body);

  const String path = String("/v1/device/actions/") + encodePathSegment(actionId) + "/run";
  String response;
  const int code = request("POST", path.c_str(), body, response);
  return readDispatch(code, response, actionId);
}

// Routes one row of the controls layout to the right call.
//
// It deliberately does NOT enforce `requiresConfirmation`. Local confirmation is the device's own
// review step and is a separate gate from gateway approval — the UI owns it, and keeping it out of
// here is what lets a confirmed action be re-dispatched without looping back into the prompt.
DispatchResult GatewayClient::runControl(const DeviceControl& control, const String& mediaUploadId) {
  StateLock guard(this);
  DispatchResult blocked;
  if (!control.enabled) {
    blocked.detail = control.reason.length() > 0 ? control.reason : String("Unavailable");
    return blocked;
  }
  if (control.requiresThread && context_.threadId.length() == 0) {
    blocked.detail = "Select a thread first";
    return blocked;
  }

  // A v1 row carries no action id: its menu word is the whole instruction.
  if (control.kind == "legacy") {
    if (control.id == "status") return sendStatus();
    if (control.id == "stop") return sendStop();
    if (control.id == "prompt") return sendPrompt(String());
    if (control.id == "shell") return sendShell(String());
    blocked.detail = "Unsupported control";
    return blocked;
  }

  // Wiping Wi-Fi and re-entering provisioning is a local action with no gateway side. Saying so
  // beats silently posting nothing.
  if (control.kind == "reset") {
    blocked.status = "local";
    blocked.detail = "Local action";
    return blocked;
  }

  return runAction(control.actionId, mediaUploadId);
}

// ---------------------------------------------------------------------------------------------
// Macros (protocol v1 only)
// ---------------------------------------------------------------------------------------------

bool GatewayClient::refreshMacros() {
  StateLock guard(this);
  macroCount_ = 0;
  String response;
  const int code = request("GET", "/v1/device/macros", "", response);
  if (!ok(code)) return false;

  JsonDocument doc;
  if (deserializeJson(doc, response)) return false;
  JsonArray macros = doc["macros"].as<JsonArray>();
  for (JsonObject item : macros) {
    if (macroCount_ >= kMaxMacros) break;
    const String id = String(item["id"] | "");
    if (id.length() == 0) continue;
    macros_[macroCount_].id = id;
    macros_[macroCount_].label = String(item["label"] | "Macro");
    macroCount_ += 1;
  }
  touch();
  return macroCount_ > 0;
}

DispatchResult GatewayClient::runMacro(const String& macroId) {
  StateLock guard(this);
  if (macroId.length() == 0) {
    DispatchResult bad;
    bad.detail = "Macro missing id";
    return bad;
  }
  const String path = String("/v1/device/macros/") + encodePathSegment(macroId) + "/run";
  String response;
  const int code = request("POST", path.c_str(), "{}", response);
  return readDispatch(code, response, macroId);
}

// ---------------------------------------------------------------------------------------------
// Response retrieval
// ---------------------------------------------------------------------------------------------

bool GatewayClient::responseInFlight() const {
  return response_.state == "waiting" || response_.state == "streaming";
}

void GatewayClient::openResponse(const String& after) {
  responseOpen_ = true;
  responseAfter_ = after;
  response_ = ThreadResponse();
  // `waiting` versus `loading` is the difference between "an answer is coming" and "show me
  // whatever is already there". Only the first keeps runCycle() polling, and only an `after`
  // justifies it: without one the gateway would hand back the PREVIOUS turn's completed answer
  // immediately and the poll would never start.
  response_.state = after.length() > 0 ? "waiting" : "loading";
  nextDisplayAt_ = millis();
  touch();
  fetchResponsePage(0);
}

void GatewayClient::closeResponse() {
  responseOpen_ = false;
  responseAfter_ = "";
  response_ = ThreadResponse();
  touch();
}

bool GatewayClient::fetchResponsePage(int page) {
  StateLock guard(this);
  String path = String("/v1/device/thread-output?page=") + (page < 0 ? 0 : page);
  if (responseAfter_.length() > 0) path += String("&after=") + encodePathSegment(responseAfter_);

  String response;
  const int code = request("GET", path.c_str(), "", response);
  if (!ok(code)) {
    response_.state = "error";
    response_.page = 0;
    response_.pageCount = 1;
    response_.lineCount = 2;
    response_.lines[0] = "Response fetch failed";
    response_.lines[1] = code == 409 ? String("Select a thread first") : remedyFor(code);
    response_.followUpCount = 0;
    touch();
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    response_.state = "error";
    response_.lineCount = 2;
    response_.lines[0] = "Bad response JSON";
    response_.lines[1] = "Try again";
    response_.followUpCount = 0;
    touch();
    return false;
  }

  JsonObject output = doc["response"];
  response_.state = String(output["state"] | "empty");
  response_.messageId = String(output["messageId"] | "");
  response_.page = output["page"] | 0;
  response_.pageCount = max(1, (int)(output["pageCount"] | 1));

  response_.lineCount = 0;
  JsonArray lines = output["lines"].as<JsonArray>();
  for (JsonVariant line : lines) {
    if (response_.lineCount >= kMaxResponseLines) break;
    response_.lines[response_.lineCount++] = String(line | "");
  }
  // Pad rather than leave the tail alone: a short final page would otherwise show the previous
  // page's text under its own last line.
  while (response_.lineCount < kMaxResponseLines) response_.lines[response_.lineCount++] = "";

  // Follow-ups are a recommendation from the model, never authority — the gateway has already
  // discarded any id that does not resolve to an enabled, assigned, non-system action. They default
  // to requiring confirmation because a suggestion gets no shortcut past the local review step.
  response_.followUpCount = 0;
  JsonArray suggestions = doc["suggestions"].as<JsonArray>();
  for (JsonObject suggestion : suggestions) {
    if (response_.followUpCount >= kMaxFollowUpActions) break;
    const String actionId = String(suggestion["actionId"] | "");
    if (actionId.length() == 0) continue;
    DeviceControl& row = response_.followUps[response_.followUpCount++];
    row = DeviceControl();
    row.id = actionId;
    row.actionId = actionId;
    row.label = String(suggestion["label"] | "Action");
    row.kind = String(suggestion["kind"] | "remote_action");
    row.requiresThread = true;
    row.requiresConfirmation = suggestion["requiresConfirmation"] | true;
  }
  touch();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

bool GatewayClient::refreshApprovals() {
  StateLock guard(this);
  String response;
  const int code = request("GET", "/v1/device/approvals", "", response);
  if (!ok(code)) {
    if (code == 403) nextConfigAt_ = millis();
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) return false;

  const size_t before = approvalCount_;
  approvalCount_ = 0;
  approvalOverflow_ = false;
  JsonArray commands = doc["commands"].as<JsonArray>();
  for (JsonObject command : commands) {
    if (approvalCount_ >= kMaxPendingApprovals) {
      // Deeper than a hardware controller can usefully triage. The console is the answer, and the
      // flag is what lets the UI say so instead of implying the queue is four long.
      approvalOverflow_ = true;
      break;
    }
    const String id = String(command["id"] | "");
    if (id.length() == 0) continue;
    PendingApproval& row = approvals_[approvalCount_++];
    row.commandId = id;
    row.intentType = String(command["intent"]["type"] | "command");
    row.risk = String(command["risk"] | "");
    row.createdAt = String(command["createdAt"] | "");
    // One line describing what is actually being asked for. Which field carries it depends on the
    // intent type, and none of them is always present — a shell command has `command`, a prompt has
    // `text`, and a policy hold explains itself in the result.
    row.summary = String(command["intent"]["text"] | "");
    if (row.summary.length() == 0) row.summary = String(command["intent"]["command"] | "");
    if (row.summary.length() == 0) row.summary = String(command["result"]["reason"] | "");
    if (row.summary.length() == 0) row.summary = row.intentType;
  }
  if (approvalCount_ != before) touch();
  return approvalCount_ > 0;
}

DispatchResult GatewayClient::answerApproval(const String& commandId, bool approve) {
  StateLock guard(this);
  if (commandId.length() == 0) {
    DispatchResult bad;
    bad.detail = "Approval missing id";
    return bad;
  }
  const String path = String("/v1/device/approvals/") + encodePathSegment(commandId)
    + (approve ? "/approve" : "/reject");
  String response;
  const int code = request("POST", path.c_str(), "{}", response);
  DispatchResult result = readDispatch(code, response, approve ? "approve" : "reject");
  // Whatever happened, the queue this device is showing is now stale.
  if (result.accepted) nextApprovalsAt_ = millis();
  return result;
}

// ---------------------------------------------------------------------------------------------
// Media upload
// ---------------------------------------------------------------------------------------------

// Does not go through request(): that helper reads the whole response into a String and posts a
// String body, and this route's body is a stream measured in megabytes. The pieces that matter —
// the local backoff gate, the device credentials, the retry-after handling — are repeated here
// rather than skipped, because skipping any of them is how one 429 becomes a storm.
String GatewayClient::uploadMedia(const char* kind, const char* contentType,
                                  const char* originalName, const uint8_t* headerBytes,
                                  size_t headerLength, const uint8_t* bodyBytes, size_t bodyLength,
                                  int& httpStatusOut) {
  httpStatusOut = -1;
  if (!store_) return String();

  const size_t rawBytes = (headerBytes ? headerLength : 0) + (bodyBytes ? bodyLength : 0);
  if (rawBytes == 0) return String();

  // The gateway measures the DECODED size against its own ceiling, so this is the same number it
  // will check. Refusing here turns a wasted upload of 1.33x the clip into an instant local error.
  if (limits_.mediaUploadBytes > 0 && rawBytes > (size_t)limits_.mediaUploadBytes) {
    httpStatusOut = 413;
    return String();
  }

  if (backoffUntil_ != 0 && (int32_t)(millis() - backoffUntil_) < 0) {
    httpStatusOut = 429;
    return String();
  }

  String base = store_->gatewayUrl();
  if (base.length() == 0) return String();
  const String url = base + "/v1/device/media";

  String prefix = "{\"kind\":\"";
  prefix += jsonEscape(kind);
  prefix += "\",\"contentType\":\"";
  prefix += jsonEscape(contentType);
  prefix += "\",\"originalName\":\"";
  prefix += jsonEscape(originalName);
  prefix += "\",\"dataBase64\":\"";
  media::Base64JsonBodyStream stream(prefix, "\"}", headerBytes, headerLength, bodyBytes,
                                     bodyLength);
  const size_t contentLength = stream.contentLength();

  // Declaration order is load-bearing; see the note in GatewayClient::request().
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;

  bool began = false;
  if (url.startsWith("https://")) {
    secure.setInsecure();
    began = http.begin(secure, url);
  } else {
    began = http.begin(plain, url);
  }
  if (!began) return String();

  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", store_->deviceId());
  http.addHeader("x-device-secret", store_->deviceSecret());
  const char* kCollected[] = {"retry-after"};
  http.collectHeaders(kCollected, 1);
  // A base64 upload over a domestic uplink outlasts the 5 s every other call gets.
  http.setTimeout(30000);

  const int code = http.sendRequest("POST", &stream, contentLength);
  httpStatusOut = code;
  const String response = code > 0 ? http.getString() : String();
  if (code == 401) revoked_ = true;
  if (code == 429) {
    const int retryAfter = http.header("retry-after").toInt();
    backoffUntil_ = millis() + (uint32_t)max(1, retryAfter) * 1000UL;
  }
  http.end();

  Serial.printf("[gateway] media upload kind=%s raw=%u encoded=%u code=%d\n", kind,
                (unsigned)rawBytes, (unsigned)contentLength, code);
  if (!ok(code)) return String();

  JsonDocument doc;
  if (deserializeJson(doc, response)) return String();
  return String(doc["media"]["id"] | "");
}
