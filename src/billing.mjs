// Subscription plans and the entitlements they grant.
//
// This module is deliberately provider-agnostic: it owns what a tier *means*, while the payment
// provider only tells us which tier a user is on (see the billing webhook in app.mjs). That keeps
// entitlement decisions testable without a live payment integration.

export const SUBSCRIPTION_TIERS = ["free", "starter", "pro", "team", "enterprise"];
export const SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "canceled"];

const PLANS = [
  {
    tier: "free",
    label: "Free",
    description: "Try remote agent control with a single environment and browser-only access.",
    priceUsdMonthly: 0,
    limits: { devices: 0, environments: 1, macros: 3, mediaRetentionDaysMax: 7 },
    features: { shellInput: false, mediaPrompts: false, supportBundle: false },
  },
  {
    tier: "starter",
    label: "Starter",
    description: "One controller, approval-gated shell, and audio prompts.",
    priceUsdMonthly: 12,
    limits: { devices: 1, environments: 2, macros: 10, mediaRetentionDaysMax: 30 },
    features: { shellInput: true, mediaPrompts: true, supportBundle: false },
  },
  {
    tier: "pro",
    label: "Pro",
    description: "Multiple controllers and environments with full media and shell control.",
    priceUsdMonthly: 29,
    limits: { devices: 5, environments: 10, macros: 50, mediaRetentionDaysMax: 90 },
    features: { shellInput: true, mediaPrompts: true, supportBundle: true },
  },
  {
    tier: "team",
    label: "Team",
    description: "Fleet-scale controllers for a working team.",
    priceUsdMonthly: 99,
    limits: { devices: 25, environments: 50, macros: 200, mediaRetentionDaysMax: 180 },
    features: { shellInput: true, mediaPrompts: true, supportBundle: true },
  },
  {
    tier: "enterprise",
    label: "Enterprise",
    description: "Unlimited fleet with retention controls negotiated per contract.",
    priceUsdMonthly: null,
    limits: { devices: null, environments: null, macros: null, mediaRetentionDaysMax: 365 },
    features: { shellInput: true, mediaPrompts: true, supportBundle: true },
  },
];

const PLAN_BY_TIER = new Map(PLANS.map((plan) => [plan.tier, plan]));

// A subscription that is not paid up loses paid entitlements without losing the user's data.
const ENTITLED_STATUSES = new Set(["active", "trialing"]);

export function listPlans() {
  return PLANS.map((plan) => structuredClone(plan));
}

export function defaultSubscription(now = new Date().toISOString()) {
  return {
    tier: "free",
    status: "active",
    provider: null,
    externalId: null,
    currentPeriodEnd: null,
    updatedAt: now,
  };
}

export function normalizeSubscription(value, previous = null, now = new Date().toISOString()) {
  const base = previous ? { ...defaultSubscription(now), ...previous } : defaultSubscription(now);
  const input = value && typeof value === "object" ? value : {};

  return {
    tier: pickEnum(input.tier, SUBSCRIPTION_TIERS) ?? base.tier,
    status: pickEnum(input.status, SUBSCRIPTION_STATUSES) ?? base.status,
    provider: hasOwn(input, "provider") ? nullableString(input.provider) : base.provider,
    externalId: hasOwn(input, "externalId") ? nullableString(input.externalId) : base.externalId,
    currentPeriodEnd: hasOwn(input, "currentPeriodEnd")
      ? nullableIsoString(input.currentPeriodEnd)
      : base.currentPeriodEnd,
    updatedAt: now,
  };
}

/**
 * The effective tier: a lapsed paid subscription falls back to free rather than keeping
 * entitlements it is no longer paying for.
 */
export function effectiveTier(subscription) {
  const resolved = subscription ?? defaultSubscription();
  if (!ENTITLED_STATUSES.has(resolved.status)) return "free";
  return PLAN_BY_TIER.has(resolved.tier) ? resolved.tier : "free";
}

export function entitlementsFor(subscription) {
  const tier = effectiveTier(subscription);
  const plan = PLAN_BY_TIER.get(tier);
  return {
    tier,
    label: plan.label,
    limits: structuredClone(plan.limits),
    features: structuredClone(plan.features),
  };
}

/**
 * @returns {{ allowed: boolean, limit: number|null, current: number, reason?: string }}
 */
export function checkResourceLimit(subscription, resource, currentCount) {
  const { tier, limits } = entitlementsFor(subscription);
  const limit = limits[resource];
  if (limit === null || limit === undefined) {
    return { allowed: true, limit: null, current: currentCount };
  }
  if (currentCount < limit) {
    return { allowed: true, limit, current: currentCount };
  }
  return {
    allowed: false,
    limit,
    current: currentCount,
    reason: `The ${tier} plan allows ${limit} ${resource}. Upgrade to add more.`,
  };
}

export function hasFeature(subscription, feature) {
  return entitlementsFor(subscription).features[feature] === true;
}

/** Clamps a requested retention to what the tier permits. */
export function clampRetentionDays(subscription, requestedDays) {
  const max = entitlementsFor(subscription).limits.mediaRetentionDaysMax;
  if (requestedDays === null || requestedDays === undefined) return max;
  if (max === null) return requestedDays;
  return Math.min(requestedDays, max);
}

function pickEnum(value, allowed) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : null;
}

function nullableString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nullableIsoString(value) {
  const text = nullableString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}
