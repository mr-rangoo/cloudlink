/**
 * Organization themes (client-safe). An organization picks a preset and may override the accent with its brand
 * colour; the result is a small set of CSS variables layered over the base design tokens in globals.css.
 * Every preset is checked for readable contrast in tests/unit/themes.test.ts; custom colours are checked on save.
 */
export interface ThemeTokens {
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentForeground: string;
  ring: string;
  sidebar: string;
  sidebarElevated: string;
  sidebarActive: string;
  sidebarBorder: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

const t = (accent: string, accentHover: string, accentSoft: string, accentForeground: string, ring: string, sidebar: string, sidebarElevated: string, sidebarActive: string, sidebarBorder: string): ThemeTokens => ({
  accent,
  accentHover,
  accentSoft,
  accentForeground,
  ring,
  sidebar,
  sidebarElevated,
  sidebarActive,
  sidebarBorder,
});

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "violet",
    name: "Cloudlink violet",
    light: t("#7c3aed", "#6d28d9", "#f3edff", "#ffffff", "#a78bfa", "#161616", "#202020", "#2a2a2a", "#262626"),
    dark: t("#a77bf3", "#b994f6", "#2b2140", "#140b24", "#c4b5fd", "#1b1b1b", "#232323", "#2b2b2b", "#2c2c2c"),
  },
  {
    id: "midnight",
    name: "Midnight blue",
    light: t("#1d6fe8", "#155ccb", "#e7f0fe", "#ffffff", "#3b82f6", "#0b1424", "#121e33", "#1a2a46", "#1c2a42"),
    dark: t("#3b8bff", "#5b9dff", "#14284a", "#ffffff", "#60a5fa", "#070d18", "#0e1828", "#15233c", "#141f33"),
  },
  {
    id: "forest",
    name: "Forest green",
    light: t("#15803d", "#116932", "#e7f6ed", "#ffffff", "#22c55e", "#0b1c14", "#10271c", "#173526", "#183022"),
    dark: t("#3fbf74", "#5ccc8a", "#12301f", "#0a111e", "#4ade80", "#06110c", "#0b1a12", "#12261b", "#102017"),
  },
  {
    id: "ocean",
    name: "Ocean teal",
    light: t("#0f766e", "#0c6159", "#e3f5f3", "#ffffff", "#2dd4bf", "#08191b", "#0d2426", "#133234", "#112d2f"),
    dark: t("#2bb5a6", "#4cc4b7", "#0f2f2d", "#0a111e", "#5eead4", "#041011", "#08191a", "#0e2627", "#0c2122"),
  },
  {
    id: "plum",
    name: "Plum",
    light: t("#7c3aed", "#6d28d9", "#f1eafe", "#ffffff", "#a78bfa", "#160f2b", "#1f1638", "#2a1e4a", "#271c44"),
    dark: t("#a07cf6", "#b498f8", "#2a1d4d", "#0a111e", "#c4b5fd", "#0e0a1c", "#160f2a", "#20173a", "#1c1433"),
  },
  {
    id: "ember",
    name: "Ember orange",
    light: t("#c2410c", "#a8380a", "#fdeee5", "#ffffff", "#fb923c", "#1f120b", "#2a1810", "#382015", "#331d13"),
    dark: t("#f0803c", "#f39a62", "#3a1f10", "#0a111e", "#fdba74", "#140b06", "#1d110a", "#29180e", "#24150c"),
  },
  {
    id: "crimson",
    name: "Crimson",
    light: t("#be123c", "#9f1239", "#fdeaee", "#ffffff", "#fb7185", "#1f0b12", "#2a1019", "#391623", "#33131f"),
    dark: t("#f0567a", "#f37a96", "#3b1220", "#0a111e", "#fda4af", "#14070c", "#1d0b12", "#29101a", "#240e17"),
  },
  {
    id: "graphite",
    name: "Graphite",
    light: t("#334155", "#1e293b", "#eef1f6", "#ffffff", "#64748b", "#111827", "#1a2232", "#243046", "#222c3e"),
    dark: t("#94a3b8", "#b0bccb", "#1e2a3d", "#0a111e", "#cbd5e1", "#0b0f17", "#121823", "#1b2333", "#18202e"),
  },
];

export const DEFAULT_THEME = "violet";
export const LIGHT_SURFACE = "#ffffff";
export const DARK_SURFACE = "#1f1f1f";
const DARK_INK = "#121212";

// ───────── colour maths ─────────

const HEX_RE = /^#[0-9a-f]{6}$/;

export function isHexColor(v: string): boolean {
  return HEX_RE.test(v.toLowerCase());
}

function rgb(hex: string): [number, number, number] {
  const h = hex.toLowerCase();
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear interpolation between two colours (0 = a, 1 = b). */
export function mix(a: string, b: string, amount: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * amount) as [number, number, number]);
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Build light and dark tokens from a brand colour, keeping the preset's sidebar. Null when text would be hard to read. */
export function tokensFromBrand(hex: string, base: ThemePreset): { light: ThemeTokens; dark: ThemeTokens } | null {
  const accent = hex.toLowerCase();
  if (!isHexColor(accent) || contrast(accent, LIGHT_SURFACE) < 4.5) return null;
  // Dark mode: lighten until the colour reads as text on the dark card surface.
  let darkAccent = accent;
  for (let i = 1; i <= 20 && contrast(darkAccent, DARK_SURFACE) < 4.5; i++) darkAccent = mix(accent, "#ffffff", i * 0.05);
  if (contrast(darkAccent, DARK_SURFACE) < 4.5) return null;
  const darkForeground = contrast("#ffffff", darkAccent) >= contrast(DARK_INK, darkAccent) ? "#ffffff" : DARK_INK;
  return {
    light: { ...base.light, accent, accentHover: mix(accent, "#000000", 0.14), accentSoft: mix(accent, "#ffffff", 0.9), accentForeground: "#ffffff", ring: mix(accent, "#ffffff", 0.3) },
    dark: { ...base.dark, accent: darkAccent, accentHover: mix(darkAccent, "#ffffff", 0.15), accentSoft: mix(accent, DARK_SURFACE, 0.78), accentForeground: darkForeground, ring: mix(darkAccent, "#ffffff", 0.25) },
  };
}

export function presetById(id: string | null | undefined): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0]!;
}

export function resolveTheme(presetId: string | null | undefined, customAccent: string | null | undefined): { light: ThemeTokens; dark: ThemeTokens } {
  const preset = presetById(presetId);
  if (customAccent) {
    const custom = tokensFromBrand(customAccent, preset);
    if (custom) return custom;
  }
  return { light: preset.light, dark: preset.dark };
}

const VARS: Array<[keyof ThemeTokens, string]> = [
  ["accent", "--accent"],
  ["accentHover", "--accent-hover"],
  ["accentSoft", "--accent-soft"],
  ["accentForeground", "--accent-foreground"],
  ["ring", "--ring"],
  ["sidebar", "--sidebar"],
  ["sidebarElevated", "--sidebar-elevated"],
  ["sidebarActive", "--sidebar-active"],
  ["sidebarBorder", "--sidebar-border"],
];

/** CSS that overrides the base tokens. Values are validated hex colours, so the output is safe to inline. */
export function themeCss(theme: { light: ThemeTokens; dark: ThemeTokens }): string {
  const block = (tokens: ThemeTokens) =>
    VARS.map(([k, v]) => {
      const value = tokens[k];
      if (!isHexColor(value)) throw new Error("invalid theme colour");
      return `${v}:${value}`;
    }).join(";");
  return `:root{${block(theme.light)}}.dark{${block(theme.dark)}}`;
}
