// The one button that must always be reachable.
//
// A sheet's content is not a fixed height: a 4:3 preview, a caption being typed, a
// cooldown banner and an error can all be on screen at once, and on a small phone that
// pushed Collect and Conquer past the edge of the screen.
//
// History, because it explains the shape of this file. Sheets used to rise from the
// bottom. A sticky footer failed on a real iPhone; so did a guessed clearance ("only a
// sliver" of the button); so, for some players, did measuring the covered strip with
// visualViewport. The bottom of a phone screen belongs to Safari's toolbar, the home
// indicator and the keyboard, and its height moves. So sheets now drop from the top of
// the visible screen and are capped at its height: anything covering the bottom only
// shortens the sheet, and its footer stays above it.
//
// That is layout, so this file cannot render it. What it can do is hold the structure in
// place — the regressions are somebody anchoring a sheet to the bottom again, putting the
// button back inside the scrolling body, or dropping the height cap.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleArea } from '../web/src/lib/viewport.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CSS = read('web/src/styles.css');
const sheetRule = () => CSS.match(/\.bottom-sheet\s*\{[^}]*\}/s)?.[0];

// Every sheet with an upload flow, and the action it must never hide.
const FLOWS = [
  { file: 'web/src/components/ParkCollect.jsx', action: 'Collect' },
  // The car sheet carries the most of all: capacity, a Hood picker, a preview, a caption,
  // an identify error with a retake button — and then the card itself.
  { file: 'web/src/components/CarCollect.jsx', action: 'Snap it' },
  { file: 'web/src/components/ClaimFlow.jsx', action: 'Conquer / Steal / Reinforce' },
  // The Hood sheet was missed the first time round, and it is the one carrying two
  // actions: the claim and the parks button under it, which was reported invisible.
  { file: 'web/src/components/HoodSheet.jsx', action: 'the Hood sheet action' },
  // Scavenger Blitz: a hunt photo, with "I'm sure" in the footer when the camera says no.
  { file: 'web/src/components/HuntSubmit.jsx', action: 'Send it / I’m sure' },
  { file: 'web/src/components/HuntParkPicker.jsx', action: 'the park hunt picker action' },
];

describe('the sheet action footer', () => {
  test('the sheet is a flex column, so the footer is laid out and not scrolled', () => {
    const rule = sheetRule();
    assert.ok(rule, '.bottom-sheet must exist in styles.css');
    assert.match(rule, /display:\s*flex/);
    assert.match(rule, /flex-direction:\s*column/);
    // The sheet scrolls only as a last resort: the body (min-height: 0, below) gives up all
    // its height first. overflow: hidden here once made the Hood sheet's second button
    // unreachable on a heavily covered screen.
    assert.match(rule, /overflow-y:\s*auto/,
      'a sheet whose head and footer alone do not fit must still let you reach the buttons');
    assert.ok(!/overflow:\s*hidden/.test(rule), 'hidden cuts the footer off with no way to reach it');
  });

  test('only the middle of the sheet scrolls, and it can actually shrink', () => {
    const rule = CSS.match(/\.bottom-sheet\s*>\s*\.sheet-body\s*\{[^}]*\}/s);
    assert.ok(rule, '.bottom-sheet > .sheet-body must be the scroller');
    assert.match(rule[0], /overflow-y:\s*auto/);
    // Without min-height: 0 a flex child refuses to shrink below its content, the body
    // grows, and the footer is pushed out of the sheet. That is the entire bug.
    assert.match(rule[0], /min-height:\s*0/, 'min-height: 0 is what makes the body a scroller');
  });

  test('sheets drop from the top of the visible screen, never from the bottom', () => {
    const rule = sheetRule();
    assert.match(rule, /top:\s*calc\(var\(--vv-top\)\s*\+\s*var\(--safe-top\)\)/,
      'anchored to where the visible screen starts, below the notch');
    assert.ok(!/(^|[\s;{])bottom:/.test(rule),
      'the bottom edge belongs to the toolbar and the keyboard — anchoring there is the old bug');
    assert.match(CSS, /--vv-top:\s*0px/, 'it needs a 0 default for browsers that cannot measure');
  });

  test('a sheet is never taller than what is visible', () => {
    const rule = sheetRule();
    // The cap is what keeps the footer on screen: a toolbar or a keyboard can only make
    // the sheet shorter, never push its bottom out of view.
    assert.match(rule,
      /max-height:\s*calc\(var\(--vv-height\)\s*-\s*var\(--safe-top\)\s*-\s*var\(--sheet-gap\)\)/);
    assert.match(CSS, /--vv-height:\s*100dvh/, 'and a fallback that follows the dynamic viewport');
    assert.match(CSS, /--sheet-gap:\s*[\d.]+rem/);
  });

  test('the parks button is in the footer too, not below the fold', () => {
    const src = read('web/src/components/HoodSheet.jsx');
    const footer = src.indexOf('className="sheet-actions"');
    // Matched on the class rather than the label: the label has been reworded once
    // already, and what matters here is where the button sits.
    const parks = src.indexOf('btn-parkemans');
    assert.notEqual(footer, -1);
    assert.notEqual(parks, -1, 'the Hood sheet must still offer its parks');
    assert.ok(parks > footer, 'it sits under the claim action, in the footer');
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
      assert.ok(footer > body, 'the footer must come after the scrolling body, as a sibling of it');
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

  describe('measuring what is visible', () => {
    test('a browser toolbar covering the bottom shortens the visible height', () => {
      // iPhone 15 Pro Max in Safari: 932 layout, 849 visible.
      assert.deepEqual(visibleArea({ innerHeight: 932, height: 849 }), { top: 0, height: 849 });
    });

    test('nothing covering means the whole screen', () => {
      assert.deepEqual(visibleArea({ innerHeight: 932, height: 932 }), { top: 0, height: 932 });
    });

    test('the keyboard counts, because it is the same problem', () => {
      assert.deepEqual(visibleArea({ innerHeight: 932, height: 596 }), { top: 0, height: 596 });
    });

    test('a page scrolled by a focused field moves the top down with it', () => {
      assert.deepEqual(visibleArea({ innerHeight: 932, height: 596, offsetTop: 40.4 }),
        { top: 40, height: 596 });
    });

    test('fractional heights round down, since half a pixel past the edge is hidden', () => {
      assert.equal(visibleArea({ innerHeight: 932, height: 849.9 }).height, 849);
    });

    test('a nonsense reading cannot squash a sheet flat, or make it taller than the screen', () => {
      // Mid-rotation the two viewports can disagree wildly; 35% of the screen is the floor.
      assert.equal(visibleArea({ innerHeight: 900, height: 10 }).height, 315);
      assert.equal(visibleArea({ innerHeight: 800, height: 860 }).height, 800);
      assert.equal(visibleArea({ innerHeight: 800, height: 700, offsetTop: -5 }).top, 0);
    });
  });

  test('the photo preview is still capped, so it cannot eat the whole sheet', () => {
    // The footer makes the button reachable; this keeps the rest of the sheet usable.
    const rule = CSS.match(/\.sheet-photo\s*\{[^}]*\}/s);
    assert.ok(rule);
    assert.match(rule[0], /max-height:\s*\d+dvh/, 'a 4:3 photo at full width needs a ceiling');
  });
});
