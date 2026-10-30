// Captive portal templates: original Cloudlink designs. Shared by the portal page, the settings gallery and the server
// (which only accepts these ids). Colours come from the organization's theme tokens unless a template sets its own.

export type PlanLayout = "list" | "tiles" | "rows" | "large";

export interface PortalTemplate {
  id: string;
  name: string;
  summary: string;
  /** Page behind the card. */
  page: string;
  /** The card that holds the portal. */
  card: string;
  /** Render the card with the dark tokens. */
  dark: boolean;
  header: "row" | "center" | "hero" | "band";
  plans: PlanLayout;
  /** Open on the voucher tab (for sites that mostly sell printed vouchers). */
  voucherFirst: boolean;
  /** Show the how-to-buy steps above the plans. */
  steps: boolean;
  serif: boolean;
}

export const PORTAL_TEMPLATES: PortalTemplate[] = [
  {
    id: "harbor",
    name: "Harbor",
    summary: "Calm card on a deep blue page. Plans as a clear list.",
    page: "bg-gradient-to-b from-sidebar to-sidebar-active",
    card: "rounded-2xl bg-surface shadow-(--shadow-pop)",
    dark: false,
    header: "row",
    plans: "list",
    voucherFirst: false,
    steps: false,
    serif: false,
  },
  {
    id: "tiles",
    name: "Tiles",
    summary: "Plans as a two-column grid of tiles with the price up front.",
    page: "bg-surface-muted",
    card: "rounded-2xl border border-border bg-surface shadow-(--shadow-card)",
    dark: false,
    header: "center",
    plans: "tiles",
    voucherFirst: false,
    steps: false,
    serif: false,
  },
  {
    id: "guided",
    name: "Guided",
    summary: "Numbered steps explain how to buy before the plans.",
    page: "bg-gradient-to-b from-accent-soft to-surface",
    card: "rounded-2xl bg-surface shadow-(--shadow-pop)",
    dark: false,
    header: "center",
    plans: "list",
    voucherFirst: false,
    steps: true,
    serif: false,
  },
  {
    id: "headline",
    name: "Headline",
    summary: "A big welcome line and large prices for quick choices.",
    page: "bg-surface",
    card: "bg-surface",
    dark: false,
    header: "hero",
    plans: "large",
    voucherFirst: false,
    steps: false,
    serif: false,
  },
  {
    id: "night",
    name: "Night",
    summary: "Dark card and page, easy on the eyes at night.",
    page: "dark bg-background",
    card: "rounded-2xl border border-border bg-surface",
    dark: true,
    header: "row",
    plans: "list",
    voucherFirst: false,
    steps: false,
    serif: false,
  },
  {
    id: "prism",
    name: "Prism",
    summary: "A coloured band in your brand colour across the top.",
    page: "bg-surface-muted",
    card: "overflow-hidden rounded-2xl bg-surface shadow-(--shadow-pop)",
    dark: false,
    header: "band",
    plans: "rows",
    voucherFirst: false,
    steps: false,
    serif: false,
  },
  {
    id: "ember",
    name: "Ember",
    summary: "Warm sunset page with tiles. Lively and bright.",
    page: "bg-gradient-to-br from-[#f97316] via-[#e11d48] to-[#7c3aed]",
    card: "rounded-3xl bg-surface shadow-(--shadow-pop)",
    dark: false,
    header: "center",
    plans: "tiles",
    voucherFirst: false,
    steps: false,
    serif: false,
  },
  {
    id: "paper",
    name: "Paper",
    summary: "Cream page and serif headings, like a printed price list.",
    page: "bg-[#f4efe4]",
    card: "rounded-xl border border-[#e2d8c3] bg-[#fffdf8]",
    dark: false,
    header: "center",
    plans: "rows",
    voucherFirst: false,
    steps: false,
    serif: true,
  },
  {
    id: "ticket",
    name: "Ticket",
    summary: "Opens on the voucher code, for sites that sell printed vouchers.",
    page: "bg-accent-soft",
    card: "rounded-2xl border-2 border-dashed border-accent/40 bg-surface",
    dark: false,
    header: "row",
    plans: "rows",
    voucherFirst: true,
    steps: false,
    serif: false,
  },
  {
    id: "plain",
    name: "Plain",
    summary: "No frills: a white page and a simple list. Loads fastest.",
    page: "bg-surface",
    card: "bg-surface",
    dark: false,
    header: "row",
    plans: "rows",
    voucherFirst: false,
    steps: false,
    serif: false,
  },
];

export const DEFAULT_TEMPLATE = "harbor";

export function templateById(id: string | null | undefined): PortalTemplate {
  return PORTAL_TEMPLATES.find((t) => t.id === id) ?? PORTAL_TEMPLATES[0]!;
}

export const DEFAULT_STEPS = [
  "Choose a plan below.",
  "Enter your M-Pesa number and tap Pay.",
  "Enter your M-Pesa PIN on your phone.",
  "Wait a few seconds: you are connected automatically.",
];
