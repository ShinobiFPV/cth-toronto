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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CSS = read('web/src/styles.css');

// Every sheet with an upload flow, and the action it must never hide.
const FLOWS = [
  { file: 'web/src/components/ParkCollect.jsx', action: 'Collect' },
  { file: 'web/src/components/ClaimFlow.jsx', action: 'Conquer / Steal / Reinforce' },
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

  test('the sheet holds its contents clear of the bottom of the screen', () => {
    const rule = CSS.match(/\.bottom-sheet\s*\{[^}]*\}/s);
    assert.match(rule[0], /padding-bottom:\s*calc\(var\(--safe-bottom\)\s*\+\s*var\(--sheet-lift\)\)/,
      'the safe-area inset alone does not clear the browser toolbar');
    assert.match(CSS, /--sheet-lift:\s*[\d.]+rem/, '--sheet-lift must have a real default');
    // Installed as an app there is no browser toolbar, so the lift can relax.
    assert.match(CSS, /@media \(display-mode: standalone\)\s*\{[^}]*--sheet-lift/s,
      'standalone should not waste a whole toolbar of space');
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

  test('the photo preview is still capped, so it cannot eat the whole sheet', () => {
    // The footer makes the button reachable; this keeps the rest of the sheet usable.
    const rule = CSS.match(/\.sheet-photo\s*\{[^}]*\}/s);
    assert.ok(rule);
    assert.match(rule[0], /max-height:\s*\d+dvh/, 'a 4:3 photo at full width needs a ceiling');
  });
});
