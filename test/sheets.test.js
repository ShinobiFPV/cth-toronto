// The one button that must always be reachable.
//
// A bottom sheet's content is not a fixed height: a 4:3 preview, a caption being typed,
// a cooldown banner and an error can all be on screen at once, and on a 667px phone
// that pushed Collect and Conquer past the bottom edge. They were reachable by
// scrolling the sheet, but nothing said the sheet scrolled, so the action looked absent
// — reported from a real iPhone as "the collect button is hidden by the UI".
//
// The fix is a sticky `.sheet-actions` footer. That is layout, so this file cannot
// render it; what it can do is hold the structure in place, because the regression is
// somebody moving the button back out of the footer or dropping `position: sticky`.
// The pixel behaviour was verified in a real browser at 375x667, 375x420 (keyboard up),
// 390x844 and 430x932, with and without a 34px home-indicator inset.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CSS = read('web/src/styles.css');

// Every sheet with an upload flow, and the action it must never hide.
const FLOWS = [
  { file: 'web/src/components/ParkCollect.jsx', action: 'Collect' },
  { file: 'web/src/components/ClaimFlow.jsx', action: 'Conquer / Steal / Reinforce' },
];

describe('the sticky sheet action footer', () => {
  test('.sheet-actions is sticky to the bottom of the scrollport', () => {
    const rule = CSS.match(/\.sheet-actions\s*\{[^}]*\}/s);
    assert.ok(rule, '.sheet-actions must exist in styles.css');
    assert.match(rule[0], /position:\s*sticky/, 'it has to stick, or the button scrolls away');
    assert.match(rule[0], /bottom:\s*0/, 'sticking to the top of the sheet would be useless');
    assert.match(rule[0], /background:\s*var\(--surface\)/,
      'an opaque background, or content slides visibly under the button');
  });

  test('the sheet leaves room for the footer when a field is focused', () => {
    const rule = CSS.match(/\.bottom-sheet\s*\{[^}]*\}/s);
    assert.ok(rule);
    assert.match(rule[0], /scroll-padding-bottom/,
      'without it, tapping the caption box parks it behind the action button');
    assert.match(rule[0], /overflow-y:\s*auto/, 'the sheet is the scrollport the footer sticks to');
  });

  for (const flow of FLOWS) {
    test(`${flow.action} lives inside the footer`, () => {
      const src = read(flow.file);
      const footer = src.indexOf('className="sheet-actions"');
      assert.notEqual(footer, -1, `${flow.file} must wrap its action in .sheet-actions`);

      // The primary block button is the action. Every one of them has to be inside the
      // footer — a second one above it would be exactly the bug coming back.
      const buttons = [...src.matchAll(/className="btn btn-primary btn-block"/g)].map((m) => m.index);
      assert.ok(buttons.length > 0, 'no primary action button found');
      for (const at of buttons) {
        assert.ok(at > footer,
          `a primary action button at ${at} sits above the footer at ${footer} — it can fall off a small screen`);
      }
    });
  }

  test('the photo preview is still capped, so it cannot eat the whole sheet', () => {
    // The footer makes the button reachable; this keeps the rest of the sheet usable.
    const rule = CSS.match(/\.sheet-photo\s*\{[^}]*\}/s);
    assert.ok(rule);
    assert.match(rule[0], /max-height:\s*\d+dvh/, 'a 4:3 photo at full width needs a ceiling');
  });
});
