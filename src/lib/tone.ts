/**
 * The single tone vocabulary for NEØ status surfaces.
 *
 * Status is expressed as a soft tint with dark text, never as a saturated or
 * near-black slab. Every chip, pill, badge and card ring reads from this map so
 * a contrast correction is made once instead of per component.
 */
export type Tone = "default" | "accent" | "success" | "warning" | "info" | "destructive";

/**
 * Tinted background + readable foreground — chips, pills, badges.
 * The `on-tint-*` colours are defined per theme, so a tinted surface keeps its
 * contrast in dark mode instead of painting dark text on a dark tint.
 */
export const TONE_TINT: Record<Tone, string> = {
  default: "bg-chip text-chip-foreground",
  accent: "bg-tint-accent text-on-tint-accent",
  success: "bg-tint-success text-on-tint-success",
  warning: "bg-tint-warning text-on-tint-warning",
  info: "bg-tint-info text-on-tint-info",
  destructive: "bg-tint-destructive text-on-tint-destructive",
};

/** Icon rings on metric cards. */
export const TONE_RING: Record<Tone, string> = {
  default: "bg-primary-soft text-primary",
  accent: "bg-tint-accent text-on-tint-accent",
  success: "bg-tint-success text-on-tint-success",
  warning: "bg-tint-warning text-on-tint-warning",
  info: "bg-tint-info text-on-tint-info",
  destructive: "bg-tint-destructive text-on-tint-destructive",
};

/** Hairline borders that match a tint. */
export const TONE_BORDER: Record<Tone, string> = {
  default: "border-outline-subtle",
  accent: "border-accent/30",
  success: "border-success/30",
  warning: "border-warning/35",
  info: "border-info/30",
  destructive: "border-destructive/30",
};

/**
 * A whole-card wash. Softer than `TONE_TINT` (which paints chips): enough
 * colour that a KPI card reads as designed rather than as a blank rectangle,
 * never enough to fight the figure printed on top of it.
 */
export const TONE_TINT_SURFACE: Record<Tone, string> = {
  default: "",
  accent: "neo-tint-accent",
  success: "neo-tint-success",
  warning: "neo-tint-warning",
  info: "neo-tint-info",
  destructive: "neo-tint-destructive",
};
