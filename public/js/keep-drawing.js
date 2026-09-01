// pdf.js draws a page in chunks and asks requestAnimationFrame for each next
// one. A hidden tab never fires a frame, so the drawing stops halfway and the
// render promise never settles. That matters here more than in most readers:
// Slate turns its own pages while reading aloud, and a listener's tab is
// usually in the background. While the tab is hidden, fall back to a timer.
//
// Called once, before pdf.js is asked to render anything.
export function keepDrawingWhenHidden() {
  const frame = window.requestAnimationFrame.bind(window);
  const drop = window.cancelAnimationFrame.bind(window);
  const timers = new Map();
  let handle = 0;

  window.requestAnimationFrame = callback => {
    if (!document.hidden) return frame(callback);
    // Negative handles cannot collide with the real ones the browser issues.
    const id = --handle;
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      callback(performance.now());
    }, 16));
    return id;
  };

  window.cancelAnimationFrame = id => {
    if (id >= 0) return drop(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
  };
}
