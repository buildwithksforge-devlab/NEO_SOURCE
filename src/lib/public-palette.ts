/** Derive readable ink from the published three-colour palette; never replace its brand fill. */
export function normalizedHex(value: string, fallback = "#18C4C8"): string {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(v))
    return (
      "#" +
      v
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
        .toUpperCase()
    );
  return fallback;
}
function rgb(value: string) {
  const h = normalizedHex(value);
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
export function relativeLuminance(value: string) {
  return rgb(value)
    .map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    })
    .reduce((n, v, i) => n + v * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
}
export function colorContrast(a: string, b: string) {
  const x = relativeLuminance(a),
    y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function primaryInk(fill: string) {
  const v = normalizedHex(fill),
    navy = "#020A1C";
  const preferred = colorContrast(v, navy) >= colorContrast(v, "#FFFFFF") ? navy : "#FFFFFF";
  return colorContrast(v, preferred) >= 4.5 ? preferred : "#000000";
}
export function accessibleAccent(accent: string, ground: string) {
  const start = rgb(accent),
    toward = rgb(primaryInk(ground));
  for (let step = 0; step <= 100; step++) {
    const t = step / 100;
    const color =
      "#" +
      start
        .map((v, i) =>
          Math.round(v + ((toward[i] ?? 0) - v) * t)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    if (colorContrast(color, ground) >= 4.5) return color;
  }
  return primaryInk(ground);
}
export function guestPalette(primary: string, background: string) {
  const fill = normalizedHex(primary),
    ground = normalizedHex(background, "#F7F9FC"),
    dark = relativeLuminance(ground) < 0.2;
  return {
    "--pa-primary": fill,
    "--pa-on-primary": primaryInk(fill),
    "--pa-accent-ink": accessibleAccent(fill, ground),
    "--pa-accent-ink-dark": accessibleAccent(fill, "#111827"),
    "--pa-accent-ink-light": accessibleAccent(fill, "#F7F9FC"),
    "--guest-ground": ground,
    "--guest-surface": dark ? "#172033" : "#FFFFFF",
    "--guest-text": dark ? "#F1F5F9" : "#10213A",
    "--guest-muted": dark ? "#B3C0D2" : "#52627A",
    "--guest-border": dark ? "#344156" : "#DCE3EC",
    "--guest-scheme": dark ? "dark" : "light",
  };
}
