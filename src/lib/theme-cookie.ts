/** Appearance preference (light | dark | system). Not sensitive; readable by the page so the switch can update it. */
export const THEME_COOKIE = "cloudlink_theme";
export const themeCookieOptions = { path: "/", sameSite: "lax" as const, maxAge: 60 * 60 * 24 * 365, httpOnly: false };
