import { expect, test } from "vitest";

import { readMarketingRoute } from "./marketingRoute";

test("reads the two secondary marketing pages", () => {
  expect(readMarketingRoute("#/developers")).toBe("developers");
  expect(readMarketingRoute("#/early-access")).toBe("early-access");
  expect(readMarketingRoute("#/early-access/")).toBe("early-access");
});

test("treats anything unrecognised as the main landing page", () => {
  expect(readMarketingRoute("")).toBe("home");
  expect(readMarketingRoute("#/")).toBe("home");
  expect(readMarketingRoute("#/operate")).toBe("home");
  expect(readMarketingRoute("#/nope")).toBe("home");
});

// The main landing page's nav uses `#hardware` to scroll to its hardware section. Without the
// leading slash rule that click would swap the whole page out from under the reader.
test("does not confuse an in-page anchor with a route", () => {
  expect(readMarketingRoute("#hardware")).toBe("home");
  expect(readMarketingRoute("#pricing")).toBe("home");
  expect(readMarketingRoute("#faq-self-host")).toBe("home");
});
