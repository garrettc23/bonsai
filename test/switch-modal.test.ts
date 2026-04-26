/**
 * Switch button → instructions modal contract.
 *
 * "Switch for me" used to re-fire the offer-hunt agent on click — wrong:
 * Bonsai doesn't actually switch services for users. The button now
 * opens a static instructions modal explaining how to switch from the
 * current to the recommended provider.
 *
 * Source-level structural checks (no jsdom in this repo).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(__dirname, "..", "public", "assets", "app.js");
const INDEX_HTML = join(__dirname, "..", "public", "index.html");

const appJs = readFileSync(APP_JS, "utf-8");
const indexHtml = readFileSync(INDEX_HTML, "utf-8");

describe("Offer card Switch button", () => {
  test("button text is plain 'Switch' (not 'Switch for me')", () => {
    // The card markup lives in buildOfferCard. Both the offer-card and
    // Compare modal buttons must render as 'Switch'.
    const cardSection = appJs.slice(appJs.indexOf("function buildOfferCard"), appJs.indexOf("function buildBestProviderCard"));
    expect(cardSection).toContain('data-action="switch"');
    expect(cardSection).toContain(">Switch<");
    expect(cardSection).not.toContain("Switch for me");
  });

  test("opens the switch modal — does NOT call runOfferHuntForCard", () => {
    const cardSection = appJs.slice(appJs.indexOf("function buildOfferCard"), appJs.indexOf("function buildBestProviderCard"));
    expect(cardSection).toContain("openSwitchModal(o)");
    expect(cardSection).not.toContain("runOfferHuntForCard(o, card)");
  });
});

describe("Compare modal switch button", () => {
  test("Compare modal Switch button opens the instructions modal", () => {
    // openCompareModal's switch onclick should now route to openSwitchModal.
    const fn = appJs.slice(appJs.indexOf("function openCompareModal"), appJs.indexOf("function switchSignupStep"));
    expect(fn).toContain("openSwitchModal(offer)");
    expect(fn).not.toContain("runOfferHuntForCard(offer, card)");
  });

  test("Compare modal markup uses 'Switch' text", () => {
    const idx = indexHtml.indexOf('id="cmp-switch"');
    expect(idx).toBeGreaterThan(-1);
    const surrounding = indexHtml.slice(idx, idx + 200);
    expect(surrounding).toContain(">Switch<");
    expect(surrounding).not.toContain("Switch for me");
  });
});

describe("Switch instructions modal markup", () => {
  test("index.html has #switch-modal with steps + note containers", () => {
    expect(indexHtml).toContain('id="switch-modal"');
    expect(indexHtml).toContain('id="switch-scrim"');
    expect(indexHtml).toContain('id="switch-steps"');
    expect(indexHtml).toContain('id="switch-note"');
  });

  test("openSwitchModal populates 3 steps + the savings note", () => {
    const fn = appJs.slice(appJs.indexOf("function openSwitchModal"));
    expect(fn).toContain("switchSignupStep");
    expect(fn).toContain("switchMatchStep");
    expect(fn).toContain("switchCancelStep");
    expect(fn).toContain("switch-note");
  });

  test("savings note mentions the estimated savings figure", () => {
    const fn = appJs.slice(appJs.indexOf("function openSwitchModal"));
    expect(fn).toContain("Bonsai estimates");
  });
});
