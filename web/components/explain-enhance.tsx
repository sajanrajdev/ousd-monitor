"use client";

import { useEffect } from "react";

const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 250;

function popoverAt(target: EventTarget | null): HTMLDetailsElement | null {
  return target instanceof Element ? target.closest(".info-popover") : null;
}

function triggerPopoverAt(target: EventTarget | null): HTMLDetailsElement | null {
  const trigger = target instanceof Element ? target.closest(".info-popover > summary") : null;
  return trigger ? popoverAt(trigger) : null;
}

function showAllChains(root: Document): void {
  const all = root.querySelector<HTMLInputElement>('.chain-filter input[value="all"]');
  if (!all || all.checked) return;
  all.checked = true;
  all.dispatchEvent(new Event("change", { bubbles: true }));
}

function listen(root: Document): () => void {
  // Open by hover and not clicked yet, so it closes when the mouse leaves.
  let hoverOpen: HTMLDetailsElement | null = null;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const openPopovers = () => [...root.querySelectorAll<HTMLDetailsElement>(".info-popover[open]")];

  const keepOpen = () => {
    clearTimeout(closeTimer);
    hoverOpen = null;
  };

  const onPointerOver = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (hoverOpen && popoverAt(event.target) === hoverOpen) {
      clearTimeout(closeTimer);
      return;
    }
    const popover = triggerPopoverAt(event.target);
    if (!popover || popover.open) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      // A clicked popover stays until it is dismissed, so hovering elsewhere can't replace it.
      if (openPopovers().some((open) => open !== hoverOpen)) return;
      clearTimeout(closeTimer);
      if (hoverOpen) hoverOpen.open = false;
      popover.open = true;
      hoverOpen = popover;
    }, HOVER_OPEN_MS);
  };

  const onPointerOut = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (triggerPopoverAt(event.target)) clearTimeout(openTimer);
    const left = popoverAt(event.target);
    if (!left || left !== hoverOpen || popoverAt(event.relatedTarget) === left) return;
    closeTimer = setTimeout(() => {
      left.open = false;
      if (hoverOpen === left) hoverOpen = null;
    }, HOVER_CLOSE_MS);
  };

  const onClick = (event: MouseEvent) => {
    clearTimeout(openTimer);
    const inside = popoverAt(event.target);
    if (inside && inside === hoverOpen) {
      // The first click on a hover-opened panel keeps it open, rather than closing it.
      if (triggerPopoverAt(event.target)) event.preventDefault();
      keepOpen();
      return;
    }
    if (event.target instanceof Element && event.target.closest("[data-finding-link]")) {
      showAllChains(root);
    }
    for (const open of openPopovers()) {
      if (open !== inside) open.open = false;
    }
    if (hoverOpen && hoverOpen !== inside) keepOpen();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    const open = openPopovers()[0];
    if (!open) return;
    const focused = root.activeElement;
    const onNothing = !focused || focused === root.body;
    open.open = false;
    keepOpen();
    // Focus somewhere else stays there, as moving it would scroll the page away from the reader.
    if (onNothing || open.contains(focused)) {
      open.querySelector("summary")?.focus({ preventScroll: onNothing });
    }
  };

  // A screen reader hears the radio and not the panel it shows, so this says which one is showing.
  const onChange = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.closest(".chain-filter")) return;
    const status = root.querySelector("[data-chain-status]");
    const label = input.closest("label")?.textContent?.trim();
    if (status && label) status.textContent = `Showing ${label}.`;
  };

  root.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointerout", onPointerOut);
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("change", onChange);
  return () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    root.removeEventListener("pointerover", onPointerOver);
    root.removeEventListener("pointerout", onPointerOut);
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("change", onChange);
  };
}

// Mounted once, in the layout. Only delegated listeners: every panel, toggle and filter option works
// without this, so a reader without it loses none of the content.
export function ExplainEnhance() {
  useEffect(() => listen(document), []);
  return null;
}
