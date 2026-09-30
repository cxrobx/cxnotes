'use strict';

/**
 * Window glass — one transparency dial, three pane alphas.
 *
 * Every CXNotes window sits on a native `NSVisualEffectView` (Electron's
 * `vibrancy` option), so the blur is real: it sees the desktop *behind the
 * window*, which `backdrop-filter` cannot — that filter blurs an element's
 * backdrop root, which for anything inside the page is the page itself. The
 * menu-bar panel carried a `backdrop-filter: blur(30px)` for exactly this job
 * and it was always a no-op; the comment beside it ("a transparent Electron
 * window has no native vibrancy behind it") described the missing half.
 *
 * This module owns the *other* half. Blur with no tint is an unreadable smear
 * and tint with no blur is a flat panel with a legible desktop behind it, so
 * the material and these alphas only work as a pair.
 *
 * Electron-free and dependency-free on purpose — the same rules as
 * `meetingFilter.js` / `vaultLocator.js`. It is pure arithmetic over one
 * number, which is what makes it testable without a window.
 */

/** Where the slider sits for a fresh install. Glassy enough to read as glass. */
const TRANSPARENCY_DEFAULT = 0.38;

/**
 * The floor each layer may reach at full transparency.
 *
 * PANE backs running text — meeting titles, vault paths, transcript excerpts —
 * so it is the layer that decides whether the app is readable over someone's
 * wallpaper. CHROME (the settings sidebar, the panel's header and footer) may
 * go far thinner because it carries short high-contrast labels, and its
 * thinness is the entire visual character being copied here: chrome that reads
 * as laid *over* the work rather than as a hole punched through to the desktop.
 *
 * CARD is not given a floor. It is derived from `pane` below, because a card
 * lies ON the pane and has to stay denser than whatever it sits on at every
 * slider position — a fixed floor would let the two cross over somewhere in
 * the middle of the range and invert the depth.
 */
const PANE_FLOOR = 0.3;
const CHROME_FLOOR = 0.12;

/**
 * How much faster chrome reaches its glassy end than the pane does.
 *
 * The BOOST multiplies the *transparency* before it is applied, never the
 * resulting alpha. Scaling the alpha instead (`pane * 0.5`) would leave chrome
 * half-transparent with the slider at zero, so the "Solid" end of the range
 * would not actually be solid. Boosting the input keeps t=0 meaning 1 for both
 * layers, and lets the two curves separate as the slider moves.
 */
const CHROME_BOOST = 1.9;

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * Coerce anything that reached us from the store / a slider into a usable dial
 * position.
 *
 * `Number.isFinite` rather than a `!= null` guard: a corrupt store value parses
 * to `NaN`, which sails straight through a null check and makes every alpha
 * `NaN`. An invalid alpha is not "ignored", it is *invalid at computed-value
 * time* — the panes paint fully transparent and the window becomes floating
 * text on a bare blur panel. The default is the safe answer, never `NaN`.
 */
function normaliseTransparency(value) {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  return Number.isFinite(n) ? clamp01(n) : TRANSPARENCY_DEFAULT;
}

/**
 * One dial position → the three alphas, holding two relationships at every
 * point in the range:
 *
 *   chrome <= pane <= card
 *
 * A formula rather than three independent settings precisely so those cannot
 * be violated by fiddling. Turning one up past its neighbour reads as a bug in
 * the blur, not as a bad value.
 */
function transparencyToAlphas(transparency) {
  const t = normaliseTransparency(transparency);
  const pane = 1 - t * (1 - PANE_FLOOR);
  const chromeT = Math.min(1, t * CHROME_BOOST);
  return {
    pane,
    chrome: 1 - chromeT * (1 - CHROME_FLOOR),
    // Half-way from the pane back to opaque: always denser than the surface it
    // rests on, and still moving with the dial rather than pinned.
    card: pane + (1 - pane) * 0.5
  };
}

/**
 * The alphas as a CSS declaration block body, for stamping onto an element's
 * inline `style`.
 *
 * Inline, not a stylesheet rule, and that is the point: an inline style beats
 * every selector, so there is no specificity left to get wrong when it lands in
 * a renderer that already defines fallback values on `:root`. The fallbacks
 * stay meaningful as the pre-push first paint, and this always wins afterwards.
 */
function glassStyleText(transparency) {
  const { pane, chrome, card } = transparencyToAlphas(transparency);
  return [
    `--alpha-pane:${pane.toFixed(3)}`,
    `--alpha-chrome:${chrome.toFixed(3)}`,
    `--alpha-card:${card.toFixed(3)}`
  ].join(';');
}

module.exports = {
  TRANSPARENCY_DEFAULT,
  PANE_FLOOR,
  CHROME_FLOOR,
  CHROME_BOOST,
  normaliseTransparency,
  transparencyToAlphas,
  glassStyleText
};
