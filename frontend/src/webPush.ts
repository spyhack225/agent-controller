export interface WebPushConfig {
  supported: boolean;
  reason: string | null;
  keyId: string | null;
  publicKey: string | null;
}

export function webPushSupported(): boolean {
  return typeof window !== "undefined"
    && window.isSecureContext
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export async function currentWebPushSubscription(): Promise<PushSubscription | null> {
  if (!webPushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return await registration.pushManager.getSubscription();
}

export async function subscribeWebPush(publicKey: string): Promise<PushSubscription> {
  if (!webPushSupported()) throw new Error("Web Push is not supported in this browser context.");
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const registration = await navigator.serviceWorker.ready;
  const expectedKey = decodeBase64Url(publicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing && !sameBytes(existing.options.applicationServerKey, expectedKey)) {
    await existing.unsubscribe();
  } else if (existing) {
    return existing;
  }
  return await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expectedKey });
}

export function serializeWebPushSubscription(subscription: PushSubscription) {
  const value = subscription.toJSON();
  if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function sameBytes(left: ArrayBuffer | null, right: Uint8Array): boolean {
  if (!left) return false;
  const bytes = new Uint8Array(left);
  return bytes.byteLength === right.byteLength && bytes.every((value, index) => value === right[index]);
}
