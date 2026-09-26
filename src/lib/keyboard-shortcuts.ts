/**
 * Keyboard layer.
 *
 * Staff work these screens for eight hours; the mouse is the slow path. This
 * module owns the small, predictable set of global keys and — crucially —
 * the rule for when a key is NOT a shortcut: while the operator is typing
 * into a field, a bare letter is a letter, never a command.
 *
 * Deliberately narrow:
 *   Cmd/Ctrl+K  open command search       (always, even inside a field)
 *   /           focus search              (only outside a field)
 *   N           new record, page-defined  (only outside a field)
 *   Cmd/Ctrl+↵  submit the focused form   (works inside a field, on purpose)
 *   Esc         close the top layer       (handled by dialogs themselves)
 *
 * Escape is intentionally absent here: Radix dialogs, sheets and popovers
 * already close on Escape with focus returned to the trigger. Adding a
 * global handler would fight them and break focus restoration.
 */
import { useEffect } from "react";

export type ShortcutAction = "command" | "search" | "new" | "submit";

export type ShortcutEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

const EDITABLE = new Set(["input", "textarea", "select"]);

/** True when the event target is a place the operator is typing text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (!EDITABLE.has(tag)) return false;
  // A disabled or read-only control is not being typed into.
  const input = el as HTMLInputElement;
  return !(input.disabled || input.readOnly);
}

/**
 * Resolves a keystroke to an action, or null when it is an ordinary key.
 * Pure, so the whole layer is testable without a DOM.
 */
export function resolveShortcut(
  event: ShortcutEventLike,
  options: { typing: boolean },
): ShortcutAction | null {
  const mod = Boolean(event.metaKey || event.ctrlKey);
  const key = event.key;

  if (mod && (key === "k" || key === "K")) return "command";
  if (mod && key === "Enter") return "submit";
  // Modifier combinations beyond those two belong to the browser or the OS.
  if (mod || event.altKey) return null;
  if (options.typing) return null;
  if (key === "/") return "search";
  if (key === "n" || key === "N") return "new";
  return null;
}

export type ShortcutHandlers = Partial<Record<ShortcutAction, () => void>>;

/**
 * Binds the global layer. Only handlers that are supplied claim their key,
 * so a page without a "new record" concept leaves N alone.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolveShortcut(event, { typing: isTypingTarget(event.target) });
      if (!action) return;
      const handler = handlers[action];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers, enabled]);
}

/** Display label for help text and tooltips, matched to the platform. */
export function shortcutLabel(action: ShortcutAction, isMac: boolean): string {
  const mod = isMac ? "⌘" : "Ctrl";
  switch (action) {
    case "command":
      return `${mod}K`;
    case "submit":
      return `${mod}↵`;
    case "search":
      return "/";
    case "new":
      return "N";
  }
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");
}
