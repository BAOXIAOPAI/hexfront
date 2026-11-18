"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { GripHorizontal } from "lucide-react";
import "./floating-actions.css";

type Position = { x: number; y: number };
type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  left: number;
  top: number;
  previous: Position | null;
  moved: boolean;
};
const STORAGE_KEY = "tidal-floating-actions-position";
const EDGE = 8;
const clamp = (n: number, max = 1) => Math.min(max, Math.max(0, n));

/** A personal, movable toolbar. Position is independent of game/turn state. */
export function FloatingActions({ visible, children }: { visible: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const position = useRef<Position | null>(null);
  const gesture = useRef<Drag | null>(null);
  const suppressClickUntil = useRef(0);
  const [dragging, setDragging] = useState(false);

  function geometry() {
    const element = root.current;
    const board = element?.parentElement;
    if (!element || !board || element.hidden || !element.offsetWidth) return null;
    const frame = board.getBoundingClientRect();
    const bar = element.getBoundingClientRect();
    return {
      element, frame, bar,
      width: Math.max(0, frame.width - bar.width - 2 * EDGE),
      height: Math.max(0, frame.height - bar.height - 2 * EDGE),
    };
  }

  function fitMenus() {
    const bounds = geometry();
    if (!bounds) return;
    const left = Math.max(bounds.frame.left, 0) + EDGE;
    const right = Math.min(bounds.frame.right, window.innerWidth) - EDGE;
    const top = Math.max(bounds.frame.top, 0) + EDGE;
    root.current?.querySelectorAll<HTMLElement>(".table-radial-menu").forEach(menu => {
      menu.style.setProperty("--floating-menu-x", "0px");
      menu.style.setProperty("--floating-menu-up", "0px");
      menu.dataset.fanBelow = "false";
      // Flip the fan below the entire toolbar near the upper map edge.
      // Shifting it down from above would cover the main action buttons.
      if (menu.getBoundingClientRect().top < top) menu.dataset.fanBelow = "true";
      const box = menu.getBoundingClientRect();
      const dx = Math.max(left - box.left, Math.min(0, right - box.right));
      menu.style.setProperty("--floating-menu-x", `${dx}px`);
    });
  }

  function applyPosition() {
    const bounds = geometry();
    if (!bounds) return;
    const { element, width, height } = bounds;
    if (position.current) {
      element.style.left = `${EDGE + position.current.x * width}px`;
      element.style.top = `${EDGE + position.current.y * height}px`;
      element.style.bottom = "auto";
      element.style.transform = "none";
    } else {
      for (const property of ["left", "top", "bottom", "transform"]) element.style.removeProperty(property);
    }
    fitMenus();
  }

  function remember() {
    try {
      if (position.current) localStorage.setItem(STORAGE_KEY, JSON.stringify(position.current));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* Storage restrictions must not prevent moving the toolbar. */ }
  }

  useLayoutEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        position.current = { x: clamp(saved.x), y: clamp(saved.y) };
      }
    } catch { /* Keep the responsive default if a saved preference is invalid. */ }
    applyPosition();
  }, []);

  useLayoutEffect(() => {
    if (!visible || !root.current?.parentElement) return;
    applyPosition();
    const resize = new ResizeObserver(applyPosition);
    resize.observe(root.current);
    resize.observe(root.current.parentElement);
    const menus = new MutationObserver(fitMenus);
    menus.observe(root.current, { childList: true, subtree: true });
    window.addEventListener("resize", applyPosition);
    return () => {
      resize.disconnect();
      menus.disconnect();
      window.removeEventListener("resize", applyPosition);
      gesture.current = null;
      setDragging(false);
    };
  }, [visible]);

  function begin(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || gesture.current) return;
    suppressClickUntil.current = 0;
    const target = event.target as Element;
    if (target.closest(".table-radial-menu")) return;
    const bounds = geometry();
    if (!bounds) return;
    gesture.current = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      left: bounds.bar.left - bounds.frame.left, top: bounds.bar.top - bounds.frame.top,
      previous: position.current, moved: false,
    };
    // Capture on the original button so an ordinary click still reaches it.
    const capture = target.closest<HTMLElement>("button") || bounds.element;
    capture.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    const bounds = geometry();
    if (!bounds) return;
    if (!drag.moved) { drag.moved = true; setDragging(true); }
    event.preventDefault();
    position.current = {
      x: bounds.width ? clamp((drag.left + dx - EDGE) / bounds.width) : 0,
      y: bounds.height ? clamp((drag.top + dy - EDGE) / bounds.height) : 0,
    };
    applyPosition();
  }

  function finish(event: PointerEvent<HTMLDivElement>, cancel = false) {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDragging(false);
    if (!drag.moved) return;
    suppressClickUntil.current = performance.now() + 500;
    if (cancel) { position.current = drag.previous; applyPosition(); }
    else remember();
  }

  function reset() {
    position.current = null;
    applyPosition();
    remember();
  }

  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Home") { event.preventDefault(); reset(); return; }
    const direction: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!direction[event.key]) return;
    const bounds = geometry();
    if (!bounds) return;
    event.preventDefault();
    const step = event.shiftKey ? 30 : 10;
    const [dx, dy] = direction[event.key];
    position.current = {
      x: bounds.width ? clamp((bounds.bar.left - bounds.frame.left - EDGE + dx * step) / bounds.width) : 0,
      y: bounds.height ? clamp((bounds.bar.top - bounds.frame.top - EDGE + dy * step) / bounds.height) : 0,
    };
    applyPosition();
    remember();
  }

  return <div ref={root} hidden={!visible} className={`minimal-floating-actions floating-toolbar ${dragging ? "floating-actions-dragging" : ""}`}
    onPointerDownCapture={begin} onPointerMoveCapture={move}
    onPointerUpCapture={event => finish(event)} onPointerCancelCapture={event => finish(event, true)}
    onLostPointerCapture={event => finish(event, true)}
    onClickCapture={event => { if (event.detail !== 0 && performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } }}>
    <button type="button" className="floating-actions-grip" aria-label="拖动操作栏，方向键移动，Home 或双击复位" title="拖动移动 · 双击复位" onKeyDown={keyboard} onDoubleClick={reset}>
      <GripHorizontal size={18} aria-hidden="true" />
    </button>
    {children}
  </div>;
}
