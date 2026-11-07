"use client";

import { useEffect } from "react";

const HOVER_OPEN_MS = 100;
const HOVER_CLOSE_MS = 200;
// The space a panel keeps from the viewport's edge, as the page margin is at 390.
const EDGE_PX = 16;
// A footnotes list opens and closes like a drawer, and a footnote a marker lands on lights briefly.
const DRAWER_MS = 220;
const FLASH_MS = 1200;
// What a list's bottom keeps clear of the viewport's, when the page has to move to show it.
const BOTTOM_GAP_PX = 16;

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const drawers = new WeakMap<HTMLElement, Animation>();
// A list still drawn while it closes, which is open to the browser and shut to the reader.
const closing = new WeakSet<HTMLDetailsElement>();

const listOf = (details: HTMLDetailsElement) =>
  details.querySelector<HTMLElement>(":scope > .footnotes__list");
const footnotesOpen = (details: HTMLDetailsElement) => details.open && !closing.has(details);

// Opens or closes a card's footnotes, its list growing or shrinking in height with a light fade,
// from wherever a running one has got to. With reduced motion it's at once, as the details element
// is with no script. Returns where the open list ends, measured before it's drawn growing.
function setFootnotes(details: HTMLDetailsElement, open: boolean): number {
  const list = listOf(details);
  const running = list && drawers.get(list);
  const from = running && list ? getComputedStyle(list) : null;
  const start = from ? { height: from.height, opacity: Number(from.opacity) } : null;
  running?.cancel();
  closing.delete(details);
  details.open = true;
  const bottom = list?.getBoundingClientRect().bottom ?? 0;
  if (!list || reducedMotion() || typeof list.animate !== "function") {
    details.open = open;
    return bottom;
  }
  const shut = { height: "0px", opacity: 0, paddingTop: "0px", marginTop: "0px" };
  const full = { height: `${list.getBoundingClientRect().height}px`, opacity: 1 };
  if (!open) closing.add(details);
  list.style.overflow = "hidden";
  const animation = list.animate(open ? [start ?? shut, full] : [start ?? full, shut], {
    duration: DRAWER_MS,
    easing: "ease-out",
  });
  drawers.set(list, animation);
  // One cancelled for a newer one leaves the list to that one.
  const done = () => {
    if (drawers.get(list) !== animation) return;
    list.style.removeProperty("overflow");
    drawers.delete(list);
  };
  animation.oncancel = done;
  animation.onfinish = () => {
    done();
    if (!open) {
      closing.delete(details);
      details.open = false;
    }
  };
  return bottom;
}

// Where the page has to be for a list's bottom to show, moving the least it can and never taking
// `top` under the header, or null when it already fits. It never aligns the list to the top.
function revealTarget(bottom: number, top: Element): number | null {
  const below = bottom + BOTTOM_GAP_PX - window.innerHeight;
  if (below <= 0) return null;
  const header = document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
  const room = top.getBoundingClientRect().top - header - BOTTOM_GAP_PX;
  const by = Math.max(0, Math.min(below, room));
  return by > 0 ? window.scrollY + by : null;
}

// A marker opens its card's list where the page is, with no jump to the footnote and no change to
// the address, scrolls only as far as the list's bottom needs, then moves focus to the footnote and
// lights it, so the reader sees which one it is. The page can't scroll past its end while the list
// is still growing, so a scroll cut short there finishes when the drawer does.
function openFootnote(footnote: HTMLElement): void {
  const details = footnote.closest<HTMLDetailsElement>("details.footnotes");
  const list = details && listOf(details);
  if (!details || !list) return;
  const bottom = footnotesOpen(details)
    ? list.getBoundingClientRect().bottom
    : setFootnotes(details, true);
  const target = revealTarget(bottom, footnote);
  const behavior = reducedMotion() ? "instant" : "smooth";
  if (target !== null) {
    window.scrollTo({ top: target, behavior });
    drawers
      .get(list)
      ?.finished.then(() => {
        if (window.scrollY < target - 1) window.scrollTo({ top: target, behavior });
      })
      .catch(() => {});
  }
  footnote.focus({ preventScroll: true });
  footnote.dataset.flash = "";
  setTimeout(() => delete footnote.dataset.flash, FLASH_MS);
}

function tipAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
}

const triggerOf = (tip: HTMLElement) => tip.querySelector<HTMLElement>(":scope > .tip__trigger");
const panelOf = (tip: HTMLElement) => tip.querySelector<HTMLElement>(":scope > .tip__panel");

// Keyboard focus keeps a panel open under a leaving pointer. Focus a mouse click left on a trigger
// doesn't. A browser that can't say counts it as keyboard focus, as before.
function keyboardFocus(element: Element | null): boolean {
  if (!element) return false;
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

// Keeps an open panel inside the viewport: shifted sideways, and above its trigger when there's no
// room below and more above.
function place(tip: HTMLElement): void {
  const panel = panelOf(tip);
  if (!panel) return;
  panel.style.removeProperty("--tip-shift");
  delete tip.dataset.flipped;
  const width = document.documentElement.clientWidth;
  const box = panel.getBoundingClientRect();
  const shift =
    box.left < EDGE_PX
      ? EDGE_PX - box.left
      : box.right > width - EDGE_PX
        ? width - EDGE_PX - box.right
        : 0;
  if (shift !== 0) panel.style.setProperty("--tip-shift", `${Math.round(shift)}px`);
  const trigger = triggerOf(tip)?.getBoundingClientRect();
  if (!trigger) return;
  const room = { below: window.innerHeight - trigger.bottom, above: trigger.top };
  const [side, other] =
    "above" in tip.dataset ? [room.above, room.below] : [room.below, room.above];
  if (box.height > side && other > side) tip.dataset.flipped = "";
}

function listen(root: Document): () => void {
  // CSS opens a panel on :hover and :focus-within until this says it has taken over.
  root.documentElement.dataset.tips = "on";
  let open: HTMLElement | null = null;
  // A clicked or tapped panel stays until it's dismissed, so the pointer leaving can't close it.
  let pinned = false;
  // Closed by Escape with focus going back to its trigger, so that focus doesn't open it again. It
  // can open again once focus has left it.
  let dismissed: HTMLElement | null = null;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const close = () => {
    clearTimeout(closeTimer);
    if (!open) return;
    delete open.dataset.open;
    const trigger = triggerOf(open);
    if (trigger?.hasAttribute("aria-expanded")) trigger.setAttribute("aria-expanded", "false");
    open = null;
    pinned = false;
  };

  const show = (tip: HTMLElement) => {
    clearTimeout(closeTimer);
    if (open === tip) return;
    close();
    tip.dataset.open = "";
    const trigger = triggerOf(tip);
    if (trigger?.hasAttribute("aria-expanded")) trigger.setAttribute("aria-expanded", "true");
    open = tip;
    place(tip);
  };

  const onPointerOver = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const tip = tipAt(event.target);
    if (!tip) return;
    if (tip === open) {
      clearTimeout(closeTimer);
      return;
    }
    clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      if (pinned) return;
      show(tip);
    }, HOVER_OPEN_MS);
  };

  const onPointerOut = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const tip = tipAt(event.target);
    if (!tip || tipAt(event.relatedTarget) === tip) return;
    clearTimeout(openTimer);
    const focused = root.activeElement;
    if (tip !== open || pinned || (tip.contains(focused) && keyboardFocus(focused))) return;
    closeTimer = setTimeout(close, HOVER_CLOSE_MS);
  };

  const onFocusIn = (event: FocusEvent) => {
    const tip = tipAt(event.target);
    if (tip && tip === dismissed) return;
    if (tip) show(tip);
    // One kept open by a tap or click goes once focus moves on. One open under the pointer stays
    // until the pointer leaves.
    else if (open && pinned) close();
  };

  const onFocusOut = (event: FocusEvent) => {
    const tip = tipAt(event.target);
    if (!tip || tipAt(event.relatedTarget) === tip) return;
    if (tip === dismissed) dismissed = null;
    if (tip === open) close();
  };

  const onClick = (event: MouseEvent) => {
    clearTimeout(openTimer);
    const target = event.target instanceof Element ? event.target : null;
    // A footnote marker opens its card's list in place. Without a script it's a link to it.
    const ref = target?.closest<HTMLAnchorElement>("a[data-fn-ref]");
    const footnote = ref && root.getElementById(ref.hash.slice(1));
    const plain = !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (footnote && plain) {
      event.preventDefault();
      openFootnote(footnote);
    }
    // The Footnotes toggle, by click, Enter or Space, opens and closes its list as a drawer.
    const drawer = target?.closest("summary")?.parentElement;
    if (drawer instanceof HTMLDetailsElement && drawer.matches(".footnotes")) {
      event.preventDefault();
      setFootnotes(drawer, !footnotesOpen(drawer));
    }
    const tip = tipAt(target);
    const trigger = tip && target?.closest(".tip__trigger");
    if (tip && trigger && trigger.tagName === "BUTTON") {
      // Open by hover or focus, a click keeps it. Kept already, a click closes it.
      if (tip === open && pinned) {
        close();
      } else {
        show(tip);
        pinned = true;
      }
      return;
    }
    if (open && tip !== open) close();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    const tip = open;
    const focusInside = tip.contains(root.activeElement);
    close();
    // Focus in the panel goes back to its trigger. Focus elsewhere stays, so the page doesn't move.
    if (focusInside) {
      dismissed = tip;
      triggerOf(tip)?.focus({ preventScroll: true });
    }
  };

  const onResize = () => {
    if (open) place(open);
  };

  // A screen reader hears the radio and not the panel it shows, so this says which one is showing.
  const onChange = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.closest(".chain-filter")) return;
    const status = root.querySelector("[data-chain-status]");
    const label = input.closest("label")?.textContent?.trim();
    if (status && label) status.textContent = `Showing ${label}.`;
  };

  // CSS may have opened a panel before this took over, under the pointer or around the focus, and
  // taking over hides it. So it opens again here, with no event to wait for.
  const already = tipAt(root.activeElement) ?? root.querySelector<HTMLElement>("[data-tip]:hover");
  if (already) show(already);

  root.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointerout", onPointerOut);
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", onFocusOut);
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("change", onChange);
  window.addEventListener("resize", onResize);
  return () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    delete root.documentElement.dataset.tips;
    root.removeEventListener("pointerover", onPointerOver);
    root.removeEventListener("pointerout", onPointerOut);
    root.removeEventListener("focusin", onFocusIn);
    root.removeEventListener("focusout", onFocusOut);
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("change", onChange);
    window.removeEventListener("resize", onResize);
  };
}

// Mounted once, in the layout. Only delegated listeners: every tooltip, toggle and filter option
// works without this, through CSS and native controls, so a reader without it loses no content.
export function ExplainEnhance() {
  useEffect(() => listen(document), []);
  return null;
}
