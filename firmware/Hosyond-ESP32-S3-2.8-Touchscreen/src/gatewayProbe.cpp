#include "gatewayProbe.h"

#include <DeviceStore.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

extern DeviceStore& deviceStore();

namespace {

// Written by the probe task, read by the render loop. A single aligned byte, so a torn read is not
// possible; nothing here needs a mutex and taking one on the render path would be worse than the
// problem it solves.
volatile GatewayStatus status = GatewayStatus::Unknown;
volatile bool probeNow = false;

constexpr uint32_t kIntervalMs = 20000;
constexpr uint16_t kTimeoutMs = 4000;

GatewayStatus probeOnce(const String& base) {
  if (base.length() == 0) return GatewayStatus::Unknown;

  const String url = base + "/health";
  HTTPClient http;
  http.setTimeout(kTimeoutMs);
  http.setConnectTimeout(kTimeoutMs);
  // A gateway that redirects is a gateway that is up; following the redirect only slows the answer.
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);

  bool began = false;
  WiFiClientSecure secure;
  WiFiClient plain;
  if (url.startsWith("https://")) {
#if INSECURE_SKIP_TLS_VERIFY
    secure.setInsecure();
#endif
    began = http.begin(secure, url);
  } else {
    began = http.begin(plain, url);
  }
  if (!began) return GatewayStatus::Unreachable;

  const int code = http.GET();
  http.end();

  if (code <= 0) return GatewayStatus::Unreachable;     // negative codes are transport failures
  if (code >= 200 && code < 400) return GatewayStatus::Reachable;
  // 4xx/5xx means something is listening and talking HTTP, just not a gateway — a different
  // problem from a wrong host, and worth saying differently.
  return GatewayStatus::BadResponse;
}

void probeTask(void*) {
  // Its own task on purpose. HTTPClient blocks for the whole connect-and-read, up to four seconds
  // here, and doing that on the render loop would stall the animation exactly like the blocking
  // serial writes did.
  uint32_t nextAt = 0;
  for (;;) {
    const uint32_t now = millis();
    if (probeNow || (int32_t)(now - nextAt) >= 0) {
      probeNow = false;
      nextAt = now + kIntervalMs;

      if (WiFi.status() != WL_CONNECTED) {
        status = GatewayStatus::Unknown;
      } else {
        const GatewayStatus s = probeOnce(deviceStore().gatewayUrl());
        if (s != status) {
          Serial.printf("[gateway] %s -> %s\n", deviceStore().gatewayUrl().c_str(),
                        gatewayStatusText(s));
        }
        status = s;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

}  // namespace

void gatewayProbeBegin() {
  // 4 KB is comfortable for HTTPClient without TLS; TLS needs more, hence 8.
  xTaskCreatePinnedToCore(probeTask, "gwprobe", 8192, nullptr, 1, nullptr, 0);
}

GatewayStatus gatewayStatus() { return status; }

void gatewayProbeNow() { probeNow = true; }

const char* gatewayStatusText(GatewayStatus s) {
  switch (s) {
    case GatewayStatus::Reachable:   return "reachable";
    case GatewayStatus::Unreachable: return "unreachable";
    case GatewayStatus::BadResponse: return "answered, not a gateway";
    default: return "unknown";
  }
}
