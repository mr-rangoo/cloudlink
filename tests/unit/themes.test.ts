import { describe, expect, it } from "vitest";
import { contrast, DARK_SURFACE, LIGHT_SURFACE, mix, resolveTheme, THEME_PRESETS, themeCss, tokensFromBrand } from "@/lib/themes";

const SIDEBAR_TEXT = "#c8d3e6";

describe("theme presets", () => {
  it.each(THEME_PRESETS.map((p) => [p.id, p] as const))("%s keeps text readable in light and dark mode", (_id, p) => {
    // Light: button text on the accent, and the accent as link text on white cards.
    expect(contrast(p.light.accentForeground, p.light.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.light.accent, LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5);
    // Dark: the accent as link text on dark cards; button labels at least 3:1 (WCAG UI-component/large-text level).
    expect(contrast(p.dark.accent, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.dark.accentForeground, p.dark.accent)).toBeGreaterThanOrEqual(3);
    // Sidebar navigation text.
    expect(contrast(SIDEBAR_TEXT, p.light.sidebar)).toBeGreaterThanOrEqual(7);
    expect(contrast(SIDEBAR_TEXT, p.dark.sidebar)).toBeGreaterThanOrEqual(7);
  });

  it("has unique ids", () => {
    expect(new Set(THEME_PRESETS.map((p) => p.id)).size).toBe(THEME_PRESETS.length);
  });
});

describe("brand colours", () => {
  it("derives readable light and dark tokens from a brand colour", () => {
    const base = THEME_PRESETS[0]!;
    const t = tokensFromBrand("#0b6e4f", base)!;
    expect(t.light.accent).toBe("#0b6e4f");
    expect(contrast(t.dark.accent, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.dark.accentForeground, t.dark.accent)).toBeGreaterThanOrEqual(3);
    expect(t.light.sidebar).toBe(base.light.sidebar);
  });

  it("rejects colours too light to read on white, and malformed values", () => {
    expect(tokensFromBrand("#ffd400", THEME_PRESETS[0]!)).toBeNull();
    expect(tokensFromBrand("red", THEME_PRESETS[0]!)).toBeNull();
    expect(resolveTheme("forest", "#ffd400").light.accent).toBe(THEME_PRESETS[1]!.light.accent); // falls back to the preset
  });

  it("emits CSS variables only from validated colours", () => {
    const css = themeCss(resolveTheme("plum", null));
    expect(css.startsWith(":root{--accent:#7c3aed;")).toBe(true);
    expect(css).toContain(".dark{--accent:#a07cf6;");
    expect(() => themeCss({ light: { ...THEME_PRESETS[0]!.light, accent: "red;}body{x" }, dark: THEME_PRESETS[0]!.dark })).toThrow();
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});
