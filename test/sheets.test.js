// The one button that must always be reachable.
//
// A bottom sheet's content is not a fixed height: a 4:3 preview, a caption being typed,
// a cooldown banner and an error can all be on screen at once, and on a 667px phone
// that pushed Collect and Conquer past the bottom edge. They were reachable by
// scrolling the sheet, but nothing said the sheet scrolled, so the action looked absent
// — reported from a real iPhone as "the collect button is hidden by the UI".
//
// A first attempt pinned the button with `position: sticky`, which still failed on a
// real iPhone 15 Pro Max in both Safari and the installed app. Two reasons: the bottom
// strip of the screen belongs to Safari's toolbar and the home indicator, and a sticky
// footer is only as reliable as the scroll container under it. So the sheet is now a
// flex column — head, scrolling body, laid-out footer — and its contents are held clear
// of the bottom of the screen by `--sheet-lift`.
//
// That is layout, so this file cannot render it; what it can do is hold the structure
// in place, because the regression is somebody putting the button back inside the
// scrolling body or dropping the lift. The pixel behaviour was verified in a real
// browser at 430x932 (browser and standalone), 375x667 and 375x420 with the keyboard
// up, with and without a 34px home-indicator inset.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coveredBottom } from '../web/src/lib/viewport.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CSS = read('web/src/styles.css');

// Every sheet with an upload flow, and the action it must never hide.
const FLOWS = [
  { file: 'web/src/components/ParkCollect.jsx', action: 'Collect' },
  { file: 'web/src/components/ClaimFlow.jsx', action: 'Conquer / Steal / Reinforce' },
  // The Hood sheet was missed the first time round, and it is the one carrying two
  // actions: the claim and the parks button under it, which was reported invisible.
  { file: 'web/src/components/HoodSheet.jsx', action: 'the Hood sheet action' },
];

describe('the sheet action footer', () => {
  test('the sheet is a flex column, so the footer is laid out and not scrolled', () => {
    const rule = CSS.match(/\.bottom-sheet\s*\{[^}]*\}/s);
    assert.ok(rule, '.bottom-sheet must exist in styles.css');
    assert.match(rule[0], /display:\s*flex/);
    assert.match(rule[0], /flex-direction:\s*column/);
    assert.match(rule[0], /overflow:\s*hidden/,
      'the sheet itself must not scroll, or the footer scrolls away with the content');
  });

  test('only the middle of the sheet scrolls, and it can actually shrink', () => {
    const rule = CSS.match(/\.bottom-sheet\s*>\s*\.sheet-body\s*\{[^}]*\}/s);
    assert.ok(rule, '.bottom-sheet > .sheet-body must be the scroller');
    assert.match(rule[0], /overflow-y:\s*auto/);
    // Without min-height: 0 a flex child refuses to shrink below its content, the body
    // grows, and the footer is pushed out of the sheet. That is the entire bug.
    assert.match(rule[0], /min-height:\s*0/, 'min-height: 0 is what makes the body a scroller');
  });

  test('the sheet sits above whatever covers the bottom of the screen', () => {
    const rule = CSS.match(/\.bottom-sheet\s*\{[^}]*\}/s);
    // A fixed element anchors to the layout viewport, which on iOS Safari runs on
    // underneath the toolbar. A guessed clearance left the button showing a sliver;
    // the measured inset is the only thing that tracks a toolbar of unknown height.
    assert.match(rule[0], /bottom:\s*var\(--vv-bottom\)/,
      'the sheet must be positioned above the covered strip, not at the layout bottom');
    assert.match(rule[0], /max-height:\s*calc\(88dvh\s*-\s*var\(--vv-bottom\)\)/,
      'and it must not be taller than what is visible');
    assert.match(rule[0], /padding-bottom:\s*calc\(var\(--safe-bottom\)\s*\+\s*var\(--sheet-lift\)\)/);
    // The inset must be counted once in each of position and height, never added to
    // the padding as well — doing all three squeezed the sheet flat with the keyboard up.
    assert.ok(!/padding-bottom:[^;]*--vv-bottom/.test(rule[0]),
      'the inset is already in `bottom` and `max-height`; adding it to padding double-counts');
    assert.match(CSS, /--vv-bottom:\s*0px/, 'it needs a 0 default for browsers that cannot measure');
    assert.match(CSS, /--sheet-lift:\s*[\d.]+rem/);
    assert.match(CSS, /@media \(display-mode: standalone\)\s*\{[^}]*--sheet-lift/s,
      'installed there is no toolbar, so do not leave a gap that looks like a mistake');
  });

  test('the parks button is in the footer too, not below the fold', () => {
    const src = read('web/src/components/HoodSheet.jsx');
    const footer = src.indexOf('className="sheet-actions"');
    // Matched on the class rather than the label: the label has been reworded once
    // already (it read "Play Parkemans GO" until the app took that name), and what
    // matters here is where the button sits.
    const parks = src.indexOf('btn-parkemans');
    assert.notEqual(footer, -1);
    assert.notEqual(parks, -1, 'the Hood sheet must still offer its parks');
    assert.ok(parks > footer,
      'it sits under the claim action, so it is the first thing to fall off the screen');
  });

  test('.sheet-actions is opaque, so content cannot show through the footer', () => {
    const rule = CSS.match(/\.sheet-actions\s*\{[^}]*\}/s);
    assert.ok(rule, '.sheet-actions must exist in styles.css');
    assert.match(rule[0], /background:\s*var\(--surface\)/);
  });

  for (const flow of FLOWS) {
    test(`${flow.action} lives in the footer, outside the scrolling body`, () => {
      const src = read(flow.file);
      const footer = src.indexOf('className="sheet-actions"');
      assert.notEqual(footer, -1, `${flow.file} must wrap its action in .sheet-actions`);

      // The footer has to be a sibling of the body, not its last child, or it scrolls
      // with the content and the flex layout above buys nothing.
      const body = src.indexOf('className="sheet-body');
      assert.notEqual(body, -1);
      assert.ok(footer > body,
        'the footer must come after the scrolling body, as a sibling of it');
      const bodyClose = src.lastIndexOf('      </div>', footer);
      assert.ok(bodyClose !== -1 && bodyClose < footer,
        `${flow.file}: .sheet-actions still looks nested inside .sheet-body`);

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

  describe('measuring what is covered', () => {
    test('a browser toolbar overlaying the layout viewport', () => {
      // iPhone 15 Pro Max in Safari: 932 layout, 849 visible.
      assert.equal(coveredBottom({ innerHeight: 932, height: 849 }), 83);
    });

    test('nothing covering means no offset', () => {
      assert.equal(coveredBottom({ innerHeight: 932, height: 932 }), 0);
    });

    test('the keyboard counts, because it is the same problem', () => {
      assert.equal(coveredBottom({ innerHeight: 932, height: 596 }), 336);
    });

    test('offsetTop is included, or the inset reads short', () => {
      // The visible viewport pushed down 40px by a focused field.
      assert.equal(coveredBottom({ innerHeight: 932, height: 849, offsetTop: 40 }), 43);
    });

    test('a visible viewport larger than the layout one is not negative', () => {
      assert.equal(coveredBottom({ innerHeight: 800, height: 860 }), 0);
    });

    test('a nonsense reading cannot swallow the sheet', () => {
      // Mid-rotation the two viewports can disagree wildly; 60% is the ceiling.
      assert.equal(coveredBottom({ innerHeight: 900, height: 10 }), 540);
    });

    test('fractional pixels round up, since half a toolbar still hides half a button', () => {
      assert.equal(coveredBottom({ innerHeight: 932.4, height: 849.1 }), 84);
    });
  });

  test('the photo preview is still capped, so it cannot eat the whole sheet', () => {
    // The footer makes the button reachable; this keeps the rest of the sheet usable.
    const rule = CSS.match(/\.sheet-photo\s*\{[^}]*\}/s);
    assert.ok(rule);
    assert.match(rule[0], /max-height:\s*\d+dvh/, 'a 4:3 photo at full width needs a ceiling');
  });
});
