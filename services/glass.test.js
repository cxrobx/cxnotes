'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  TRANSPARENCY_DEFAULT,
  PANE_FLOOR,
  CHROME_FLOOR,
  normaliseTransparency,
  transparencyToAlphas,
  glassStyleText
} = require('./glass');

const POSITIONS = [0, 0.1, 0.25, TRANSPARENCY_DEFAULT, 0.5, 0.75, 0.9, 1];

/* ── normaliseTransparency ───────────────────────────────────── */

test('normaliseTransparency passes a usable dial position through', () => {
  assert.strictEqual(normaliseTransparency(0), 0);
  assert.strictEqual(normaliseTransparency(0.38), 0.38);
  assert.strictEqual(normaliseTransparency(1), 1);
});

test('normaliseTransparency clamps out-of-range values into 0..1', () => {
  assert.strictEqual(normaliseTransparency(-2), 0);
  assert.strictEqual(normaliseTransparency(4.5), 1);
});

test('normaliseTransparency parses the string a range input hands back', () => {
  assert.strictEqual(normaliseTransparency('0.62'), 0.62);
});

test('normaliseTransparency falls back to the default, never NaN', () => {
  // The failure this exists to prevent: a NaN alpha is invalid at
  // computed-value time, so every pane paints fully transparent.
  for (const bad of [undefined, null, NaN, 'glass', '', {}, []]) {
    const out = normaliseTransparency(bad);
    assert.ok(Number.isFinite(out), `${String(bad)} produced a non-finite dial`);
    assert.strictEqual(out, TRANSPARENCY_DEFAULT);
  }
});

/* ── transparencyToAlphas ────────────────────────────────────── */

test('the solid end of the range is genuinely solid on every layer', () => {
  const { pane, chrome, card } = transparencyToAlphas(0);
  assert.strictEqual(pane, 1);
  assert.strictEqual(chrome, 1);
  assert.strictEqual(card, 1);
});

test('the glass end lands each layer on its floor', () => {
  const { pane, chrome, card } = transparencyToAlphas(1);
  assert.ok(Math.abs(pane - PANE_FLOOR) < 1e-9);
  assert.ok(Math.abs(chrome - CHROME_FLOOR) < 1e-9);
  // Card is derived, not floored — half-way from the pane back to opaque.
  assert.ok(Math.abs(card - (PANE_FLOOR + (1 - PANE_FLOOR) / 2)) < 1e-9);
});

test('chrome <= pane <= card holds at every position', () => {
  // The depth ordering is the whole reason this is one formula rather than
  // three settings: a crossover anywhere in the range reads as a broken blur.
  for (const t of POSITIONS) {
    const { pane, chrome, card } = transparencyToAlphas(t);
    assert.ok(chrome <= pane + 1e-9, `chrome overtook pane at t=${t}`);
    assert.ok(pane <= card + 1e-9, `pane overtook card at t=${t}`);
  }
});

test('every alpha stays a finite number inside 0..1', () => {
  for (const t of [...POSITIONS, -1, 2, NaN, 'x', undefined]) {
    for (const [layer, a] of Object.entries(transparencyToAlphas(t))) {
      assert.ok(Number.isFinite(a), `${layer} was not finite at t=${String(t)}`);
      assert.ok(a >= 0 && a <= 1, `${layer} left 0..1 at t=${String(t)}`);
    }
  }
});

test('every layer is monotonically non-increasing as the dial opens', () => {
  let prev = transparencyToAlphas(0);
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const next = transparencyToAlphas(t);
    for (const layer of ['pane', 'chrome', 'card']) {
      assert.ok(next[layer] <= prev[layer] + 1e-9, `${layer} rose at t=${t.toFixed(2)}`);
    }
    prev = next;
  }
});

test('chrome reaches its glassy end well before the pane does', () => {
  // The boost is applied to the transparency, not to the resulting alpha —
  // which is what keeps t=0 opaque while still separating the two curves.
  const { pane, chrome } = transparencyToAlphas(TRANSPARENCY_DEFAULT);
  assert.ok(chrome < pane - 0.2, `chrome (${chrome}) is not visibly thinner than pane (${pane})`);
});

test('a corrupt dial value renders the default glass, not a transparent window', () => {
  assert.deepStrictEqual(
    transparencyToAlphas('not a number'),
    transparencyToAlphas(TRANSPARENCY_DEFAULT)
  );
});

/* ── glassStyleText ──────────────────────────────────────────── */

test('glassStyleText emits the three custom properties', () => {
  const text = glassStyleText(TRANSPARENCY_DEFAULT);
  assert.match(text, /--alpha-pane:0\.\d+/);
  assert.match(text, /--alpha-chrome:0\.\d+/);
  assert.match(text, /--alpha-card:0\.\d+/);
  assert.strictEqual(text.split(';').length, 3);
});

test('glassStyleText never emits a value CSS would reject', () => {
  for (const bad of [undefined, NaN, 'glass', null]) {
    const text = glassStyleText(bad);
    assert.doesNotMatch(text, /NaN|undefined|null/);
  }
});

test('glassStyleText contains nothing that could escape an inline style', () => {
  // It is stamped onto an element's style attribute from the main process, so
  // quotes, semicolon-terminators and angle brackets must be impossible.
  for (const t of [...POSITIONS, '0.5; background: red', '"><script>']) {
    assert.match(glassStyleText(t), /^[-a-z:;.0-9]+$/);
  }
});
