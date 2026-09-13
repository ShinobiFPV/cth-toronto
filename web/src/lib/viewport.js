// What part of the screen is actually visible.
//
// Sheets drop down from the top of the screen. They used to rise from the bottom, and
// the bottom is the one edge of a phone screen the page does not own: on iOS Safari the
// layout viewport runs on underneath the browser toolbar, the keyboard covers it when a
// caption is being typed, and its height changes as the toolbar collapses. Every fix for
// a button lost down there ("only a sliver" of Collect, then of Conquer) was a better
// guess at that strip, and players kept finding the cases the guess missed.
//
// From the top the problem gets simpler. A sheet starts where the visible screen starts
// and is capped at the visible height, so whatever covers the bottom — toolbar or
// keyboard — only ever shortens the sheet, and its footer stays on screen above it.
// visualViewport knows both numbers; they land in `--vv-top` and `--vv-height`.

/**
 * The visible area, from a visualViewport-shaped reading. Pure, so it can be tested.
 *
 *   top     how far the visible screen has been pushed down (the keyboard scrolling the
 *           page, or pinch-zoom) — a fixed element anchors to the layout viewport, so
 *           without this the top of a sheet slides out of sight
 *   height  floored: half a pixel past the visible edge still hides half a button.
 *           Clamped to at least 35% of the screen so a nonsense reading mid-rotation
 *           cannot squash a sheet flat, and never taller than the screen.
 */
export function visibleArea({ innerHeight, height, offsetTop = 0 }) {
  const top = Math.max(0, Math.round(offsetTop));
  const floor = Math.round(innerHeight * 0.35);
  const h = Math.min(Math.max(Math.floor(height), floor), Math.floor(innerHeight));
  return { top, height: h };
}

/**
 * Publish the visible area as CSS variables and keep them current. Returns an
 * unsubscribe. Safe where `visualViewport` does not exist: the variables keep their
 * stylesheet defaults (0px and 100dvh).
 */
export function trackViewport() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};

  const root = document.documentElement.style;
  const apply = () => {
    const { top, height } = visibleArea({
      innerHeight: window.innerHeight, height: vv.height, offsetTop: vv.offsetTop,
    });
    root.setProperty('--vv-top', `${top}px`);
    root.setProperty('--vv-height', `${height}px`);
  };

  apply();
  // 'resize' covers the toolbar and the keyboard; 'scroll' covers the visible viewport
  // being panned while zoomed or while a focused field is scrolled into view.
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    window.removeEventListener('orientationchange', apply);
  };
}
