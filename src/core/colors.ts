// Peer colors. A color is #rrggbb, and the same key always gives the
// same color. Contrast is the WCAG 2.2 ratio (1.4.3 and 1.4.11).
//
// No single color gives 4.5:1 text contrast on both a white page and a
// dark page: that needs a luminance both at most 0.18 and at least 0.20.
// So there are three modes:
//   "light"  4.5:1 on LIGHT_BACKGROUND, for text on a light page.
//   "dark"   4.5:1 on DARK_BACKGROUND, for text on a dark page.
//   "both"   3:1 on both, for cursors, carets, and outlines (1.4.11).
// Use "both" for the color a peer sends in its presence.
export const LIGHT_BACKGROUND = "#ffffff";
export const DARK_BACKGROUND = "#121212";
export const TEXT_CONTRAST = 4.5;
export const GRAPHIC_CONTRAST = 3;

export type ColorMode = "light" | "dark" | "both";

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The WCAG contrast ratio of two #rrggbb colors, from 1 to 21.
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function fromHsl(hue: number, saturation: number, lightness: number): string {
  const k = (n: number) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) =>
    Math.round(255 * (lightness - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[channel(0), channel(8), channel(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// FNV-1a over the UTF-16 units, so the hash is the same everywhere.
function hueOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash % 360;
}

function passes(color: string, mode: ColorMode): boolean {
  const light = contrastRatio(color, LIGHT_BACKGROUND);
  const dark = contrastRatio(color, DARK_BACKGROUND);
  if (mode === "light") return light >= TEXT_CONTRAST;
  if (mode === "dark") return dark >= TEXT_CONTRAST;
  return light >= GRAPHIC_CONTRAST && dark >= GRAPHIC_CONTRAST;
}

// A color for a key (a name or any stable id). It keeps the key's hue and
// takes the most vivid lightness that passes the mode.
export function peerColor(key: string, mode: ColorMode = "both"): string {
  const hue = hueOf(key);
  for (const saturation of [0.7, 0.5, 0.3, 0]) {
    const found: string[] = [];
    for (let step = 0; step <= 100; step++) {
      const color = fromHsl(hue, saturation, step / 100);
      if (passes(color, mode)) found.push(color);
    }
    if (found.length === 0) continue;
    // The lightest passing color on a light page, the darkest on a dark
    // page, and the middle one when both pages must pass.
    if (mode === "light") return found[found.length - 1];
    if (mode === "dark") return found[0];
    return found[Math.floor(found.length / 2)];
  }
  // Unreachable: a gray passes every mode. Fail closed to black or white.
  return mode === "dark" ? "#ffffff" : "#000000";
}

// The color a peer sent, if it is #rrggbb and passes "both". A color of
// any other form, such as a CSS string, is replaced by the key's own.
export function safePeerColor(color: unknown, key: string): string {
  return isHexColor(color) && passes(color, "both") ? color.toLowerCase() : peerColor(key, "both");
}
