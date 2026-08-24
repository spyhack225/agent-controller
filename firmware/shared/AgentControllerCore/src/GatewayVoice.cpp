#include "GatewayVoice.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "MediaUpload.h"
#include "OperateModel.h"

namespace {

bool ok2xx(int code) { return code >= 200 && code < 300; }

// A finished job is asked about roughly once a second. Transcription of a short clip takes a few
// seconds on a GPU and minutes on the CPU default, so this is a cadence that shows movement without
// spending the device's read budget: 60 requests a minute against a device-read limit of 120.
constexpr uint32_t kPollIntervalMs = 1000;

// Each blocking poll costs the render loop one frame, so the timeout is the shortest that a local
// gateway comfortably answers within rather than the 2 s the browse calls get. A poll that times
// out is not worth a second of frozen animation.
constexpr uint16_t kTimeoutMs = 800;

// Consecutive failures back off hard and then give up, because the alternative is a board that
// freezes for the timeout once a second forever against a gateway that has gone away.
constexpr uint8_t kMaxFailures = 4;

// Nothing in this pipeline legitimately takes longer than this. A job still unresolved afterwards
// is one the owner has to look at in the console, and the device stops asking.
constexpr uint32_t kGiveUpAfterMs = 180000;

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

// Percent-encoding for a path segment: a job id is generated and safe, but it lands in a URL and
// assuming that is how a 404 becomes unexplainable.
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

// The gateway's own milestone words, mapped onto the enum. An unknown word is NOT optimistically
// promoted: it stays wherever the device already was, because claiming a stage that was never
// observed is the one thing this class must not do.
bool milestoneToStage(const String& milestone, VoiceStage& out) {
  if (milestone == "transcribing") { out = VoiceStage::Transcribing; return true; }
  if (milestone == "review")       { out = VoiceStage::Review; return true; }
  if (milestone == "ready")        { out = VoiceStage::Ready; return true; }
  if (milestone == "sent")         { out = VoiceStage::Sent; return true; }
  if (milestone == "failed")       { out = VoiceStage::Failed; return true; }
  if (milestone == "recorded")     { out = VoiceStage::Recorded; return true; }
  if (milestone == "uploading")    { out = VoiceStage::Uploading; return true; }
  return false;
}

}  // namespace

const char* voiceStageName(VoiceStage stage) {
  switch (stage) {
    case VoiceStage::Recorded:     return "recorded";
    case VoiceStage::Uploading:    return "uploading";
    case VoiceStage::Transcribing: return "transcribing";
    case VoiceStage::Review:       return "review";
    case VoiceStage::Ready:        return "ready";
    case VoiceStage::Sent:         return "sent";
    case VoiceStage::Failed:       return "failed";
    default:                       return "idle";
  }
}

void GatewayVoice::begin(DeviceStore& store) { store_ = &store; }

void GatewayVoice::publish(VoiceStage stage, const String& detail) {
  if (stage == stage_ && detail == detail_) return;
  stage_ = stage;
  detail_ = detail;
  revision_ += 1;
}

void GatewayVoice::reset() {
  jobId_ = "";
  transcript_ = "";
  ok_ = true;
  failures_ = 0;
  nextPollAt_ = 0;
  giveUpAt_ = 0;
  publish(VoiceStage::Idle, String());
}

void GatewayVoice::setLocalStage(VoiceStage stage) {
  switch (stage) {
    case VoiceStage::Recorded:  publish(stage, String("Ready to send")); return;
    case VoiceStage::Uploading: publish(stage, String("Sending the recording")); return;
    default:                    publish(stage, String()); return;
  }
}

bool GatewayVoice::tracking() const {
  if (jobId_.length() == 0) return false;
  return stage_ != VoiceStage::Ready && stage_ != VoiceStage::Sent
    && stage_ != VoiceStage::Failed && stage_ != VoiceStage::Idle;
}

bool GatewayVoice::pollDue(uint32_t now) const {
  if (!tracking()) return false;
  if (failures_ >= kMaxFailures) return false;
  return (int32_t)(now - nextPollAt_) >= 0;
}

String GatewayVoice::upload(const char* kind, const char* contentType, const char* originalName,
                            const uint8_t* headerBytes, size_t headerLength,
                            const uint8_t* bodyBytes, size_t bodyLength, uint32_t maxRawBytes,
                            int& httpStatusOut) {
  httpStatusOut = -1;
  jobId_ = "";
  transcript_ = "";
  ok_ = true;
  failures_ = 0;
  if (!store_) return String();
  if (WiFi.status() != WL_CONNECTED) return String();

  const size_t rawBytes = (headerBytes ? headerLength : 0) + (bodyBytes ? bodyLength : 0);
  if (rawBytes == 0) return String();

  // The gateway measures the DECODED size against its own ceiling, so this is the same number it
  // will check. Refusing here turns a wasted upload of 1.33x the clip into an instant local error.
  if (maxRawBytes > 0 && rawBytes > (size_t)maxRawBytes) {
    httpStatusOut = 413;
    return String();
  }

  const String base = store_->gatewayUrl();
  if (base.length() == 0) return String();
  const String url = base + "/v1/device/media";

  String prefix = "{\"kind\":\"";
  prefix += jsonEscape(kind);
  prefix += "\",\"contentType\":\"";
  prefix += jsonEscape(contentType);
  prefix += "\",\"originalName\":\"";
  prefix += jsonEscape(originalName);
  prefix += "\",\"dataBase64\":\"";

  // The body is generated four characters at a time straight into HTTPClient's TCP buffer. This is
  // the delicate part of the upload and it is reused verbatim rather than reimplemented: the
  // capture buffer in PSRAM stays the only full copy of a payload that would be 1.28 MB encoded.
  media::Base64JsonBodyStream stream(prefix, "\"}", headerBytes, headerLength, bodyBytes,
                                     bodyLength);
  const size_t contentLength = stream.contentLength();

  // Declaration order is load-bearing, exactly as in GatewayClient::request(): HTTPClient holds a
  // reference to the client it was handed and C++ destroys locals in reverse, so an HTTPClient
  // declared first would call stop() through a dead vtable. Clients first.
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;

  bool began = false;
  if (url.startsWith("https://")) {
    secure.setInsecure();   // pin the gateway certificate before production
    began = http.begin(secure, url);
  } else {
    began = http.begin(plain, url);
  }
  if (!began) return String();

  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", store_->deviceId());
  http.addHeader("x-device-secret", store_->deviceSecret());
  http.setTimeout(30000);

  const int code = http.sendRequest("POST", &stream, contentLength);
  httpStatusOut = code;
  const String response = code > 0 ? http.getString() : String();
  http.end();

  Serial.printf("[voice] upload raw=%u encoded=%u code=%d\n", (unsigned)rawBytes,
                (unsigned)contentLength, code);
  if (!ok2xx(code)) return String();

  JsonDocument doc;
  if (deserializeJson(doc, response)) return String();

  // Both ids, which is the whole reason this method exists. `job.jobId` is what the poll route
  // takes; `media.id` is what an audio_prompt intent takes. GatewayClient::uploadMedia() returns
  // only the second and discards the first.
  jobId_ = String(doc["job"]["jobId"] | "");
  const String mediaId = String(doc["media"]["id"] | "");

  if (jobId_.length() > 0) {
    const uint32_t now = millis();
    nextPollAt_ = now + kPollIntervalMs;
    giveUpAt_ = now + kGiveUpAfterMs;
    // Uploaded, and the gateway has queued the ASR itself. Transcribing is what it is doing now,
    // and it is an observation rather than a guess: the POST answered with the job.
    publish(VoiceStage::Transcribing, String("Transcribing"));
  }
  return mediaId;
}

bool GatewayVoice::poll() {
  if (!tracking() || !store_) return false;
  const uint32_t now = millis();
  nextPollAt_ = now + kPollIntervalMs;

  if (giveUpAt_ != 0 && (int32_t)(now - giveUpAt_) >= 0) {
    ok_ = false;
    publish(VoiceStage::Failed, String("Timed out; see the console"));
    return true;
  }

  const String base = store_->gatewayUrl();
  if (base.length() == 0 || WiFi.status() != WL_CONNECTED) return false;
  const String url = base + "/v1/device/media/jobs/" + encodePathSegment(jobId_);

  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;

  http.setTimeout(kTimeoutMs);
  http.setConnectTimeout(kTimeoutMs);

  bool began = false;
  if (url.startsWith("https://")) {
    secure.setInsecure();
    began = http.begin(secure, url);
  } else {
    began = http.begin(plain, url);
  }
  if (!began) return false;

  http.addHeader("x-device-id", store_->deviceId());
  http.addHeader("x-device-secret", store_->deviceSecret());

  const int code = http.GET();
  String response;
  if (code > 0) {
    const int length = http.getSize();
    if (length > (int)kMaxResponseBodyBytes) response = "";
    else response = http.getString();
  }
  http.end();

  if (!ok2xx(code)) {
    failures_ += 1;
    // Back off hard rather than freezing the renderer for the timeout once a second.
    nextPollAt_ = now + (uint32_t)(kPollIntervalMs * (1u << failures_));
    if (failures_ >= kMaxFailures) {
      ok_ = false;
      publish(VoiceStage::Failed,
              code > 0 ? String("Status unavailable ") + code : String("No answer"));
      return true;
    }
    // Not a stage change: the device simply did not observe anything this tick, and holding the
    // last known milestone is the whole point.
    return false;
  }
  failures_ = 0;

  JsonDocument doc;
  if (deserializeJson(doc, response)) return false;
  JsonObject job = doc["job"];
  if (job.isNull()) return false;

  const String milestone = String(job["milestone"] | "");
  VoiceStage next = stage_;
  if (!milestoneToStage(milestone, next)) return false;   // never promote on a word we do not know

  const char* transcript = job["transcript"] | "";
  if (strlen(transcript) > 0) transcript_ = transcript;
  const char* error = job["error"] | "";
  ok_ = job["ok"] | true;

  String detail;
  switch (next) {
    case VoiceStage::Transcribing:
      detail = "Transcribing";
      break;
    case VoiceStage::Review:
      // The normaliser changed something a person has to see. This is a stop, and the wording has
      // to say so rather than sounding like one more stage of progress.
      detail = "Check the wording in the console";
      break;
    case VoiceStage::Ready:
    case VoiceStage::Sent:
      detail = transcript_.length() > 0 ? transcript_ : String(job["label"] | "Sent");
      break;
    default:
      detail = strlen(error) > 0 ? String(error) : String("Voice note failed");
      ok_ = false;
      break;
  }
  publish(next, detail);
  return true;
}
