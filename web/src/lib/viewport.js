// How much of the bottom of the screen is not actually ours.
//
// A `position: fixed; bottom: 0` element anchors to the **layout** viewport. On iOS
// Safari the layout viewport extends underneath the browser's bottom toolbar, so a
// bottom sheet's last few rows are painted somewhere the player cannot see them. That
// is why the Collect button showed "only a sliver" even after the sheet was given a
// fixed 3.5rem of clearance: a guessed number cannot track a toolbar that is sometimes
// there, sometimes collapsed, and a different height on every iOS release.
//
// visualViewport knows the real answer. The difference between the layout viewport and
// the visible one is exactly what is covering the bottom — the Safari toolbar, and the
// software keyboard when it is up, which is the same problem wearing a different hat.
// It lands in `--vv-bottom` and the stylesheet does the rest.

const VAR = '--vv-bottom';

/**
 * Publish the covered inset as a CSS variable and keep it current. Returns an
 * unsubscribe, and is safe to call where `visualViewport` does not exist — the
 * variable simply stays at its 0px default and `--sheet-lift` carries the sheet.
 */
export function trackBottomInset() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};

  const apply = () => {
    // offsetTop is how far the visible viewport has been pushed down (pinch-zoom, or
    // the keyboard scrolling the page); without it the inset reads short.
    const covered = window.innerHeight - vv.height - vv.offsetTop;
    // Rounded up: half a pixel of a toolbar still hides half a pixel of button. Capped
    // so a bad reading mid-rotation cannot swallow the whole sheet.
    const px = Math.min(Math.max(0, Math.ceil(covered)), Math.round(window.innerHeight * 0.6));
    document.documentElement.style.setProperty(VAR, `${px}px`);
  };

  apply();
  // 'resize' covers the toolbar appearing and the keyboard; 'scroll' covers the visible
  // viewport being panned while zoomed.
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    window.removeEventListener('orientationchange', apply);
  };
}

/**
 * The measurement on its own, so it can be tested without a browser.
 * Same clamp as above: never negative, never more than 60% of the screen.
 */
export function coveredBottom({ innerHeight, height, offsetTop = 0 }) {
  const covered = innerHeight - height - offsetTop;
  return Math.min(Math.max(0, Math.ceil(covered)), Math.round(innerHeight * 0.6));
}
