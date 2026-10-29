import { describe, expect, test } from "vitest";
import {
  DARK_BACKGROUND,
  GRAPHIC_CONTRAST,
  LIGHT_BACKGROUND,
  TEXT_CONTRAST,
  contrastRatio,
  peerColor,
  safePeerColor,
} from "./colors.js";

describe("contrast ratio", () => {
  test("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});

// Many keys cover every hue, and awkward ones such as blue and yellow.
const keys = [
  "Ana", "Zoë", "Summary bot", "agent-7", "", "a", "李雷", "Claude (work)",
  ...Array.from({ length: 720 }, (_, i) => `peer-${i}`),
];

describe("peer colors", () => {
  test.each(keys)("%s gets passing colors in every mode", (key) => {
    const light = peerColor(key, "light");
    const dark = peerColor(key, "dark");
    const both = peerColor(key, "both");
    for (const color of [light, dark, both]) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(light, LIGHT_BACKGROUND)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrastRatio(dark, DARK_BACKGROUND)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrastRatio(both, LIGHT_BACKGROUND)).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
    expect(contrastRatio(both, DARK_BACKGROUND)).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
  });

  test("the same key always gives the same color", () => {
    expect(peerColor("Ana")).toBe(peerColor("Ana"));
    expect(peerColor("Ana", "light")).toBe(peerColor("Ana", "light"));
  });

  test("a fixed key gives a fixed color, so a change in the hash shows", () => {
    expect(peerColor("Ana", "both")).toMatchInlineSnapshot(`"#dd3c6f"`);
  });

  test("different keys mostly give different colors", () => {
    const colors = new Set(keys.map((key) => peerColor(key)));
    expect(colors.size).toBeGreaterThan(100);
  });
});

describe("a color from another peer", () => {
  test("keeps a good #rrggbb color, in lower case", () => {
    expect(safePeerColor("#DD3C6F", "Zoë")).toBe("#dd3c6f");
  });

  test.each([
    ["too light for a light page", "#ffff00"],
    ["too dark for a dark page", "#000000"],
    ["white", "#ffffff"],
    ["a CSS string", "red; background: url(https://x.example/a)"],
    ["a short hex", "#0a0"],
    ["hsl", "hsl(10 70% 45%)"],
    ["a number", 5],
    ["null", null],
    ["an object", { a: 1 }],
  ])("replaces %s with the key's own color", (_label, color) => {
    expect(safePeerColor(color, "Ana")).toBe(peerColor("Ana", "both"));
  });
});
