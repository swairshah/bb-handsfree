import { useLayoutEffect, type RefObject } from "react";

/** Keep the embedded composer and call footer above the software keyboard.
 * BB's portaled drawer can retain its layout-viewport height on iOS even when
 * the visual viewport shrinks. Only constrain our content, not the host drawer.
 */
export function useDrawerViewport(ref: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const root = ref.current;
    const win = root?.ownerDocument.defaultView;
    const viewport = win?.visualViewport;
    if (!root || !win || !viewport) return;

    const previousMaxHeight = root.style.maxHeight;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const bounds = root.getBoundingClientRect();
      const available = Math.floor(viewport.offsetTop + viewport.height - bounds.top);
      // Let pinch zoom behave normally. Hidden/offscreen persistent panels
      // must not retain a zero-height constraint when opened again.
      root.style.maxHeight = viewport.scale === 1 && bounds.height > 0 && available > 0
        ? `${available}px`
        : previousMaxHeight;
    };
    const schedule = () => {
      if (frame === null) frame = win.requestAnimationFrame(update);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(root);
    if (root.parentElement) observer?.observe(root.parentElement);
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    win.addEventListener("resize", schedule);
    // BB may move the drawer without resizing its content during opening.
    win.addEventListener("transitionend", schedule);
    root.addEventListener("focusin", schedule);
    root.addEventListener("focusout", schedule);
    update();
    return () => {
      observer?.disconnect();
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      win.removeEventListener("resize", schedule);
      win.removeEventListener("transitionend", schedule);
      root.removeEventListener("focusin", schedule);
      root.removeEventListener("focusout", schedule);
      if (frame !== null) win.cancelAnimationFrame(frame);
      root.style.maxHeight = previousMaxHeight;
    };
  }, [ref]);
}
