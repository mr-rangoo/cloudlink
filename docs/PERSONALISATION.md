# Branding, payment methods and live sessions

These features were added in phase 10. Each organization sets them up itself under **Settings**.

## Branding and theme (Settings → Branding & theme)
- **Theme presets.** There are seven: Midnight blue, Forest green, Ocean, Plum, Ember, Crimson and Graphite. Each one sets the accent colour, the sidebar colours and the focus ring, with light and dark previews. Every preset passes WCAG AA contrast (`tests/unit/themes.test.ts`).
- **Brand colour.** You can enter your own hex colour instead of a preset. It is rejected if white text on it would fall below 4.5:1 contrast. Lighter and darker shades are derived from it automatically.
- **Default appearance.** Choose light, dark or follow the device. It applies at sign-in to anyone who has not picked a mode. Customers can switch mode in the portal header, and staff can switch in the account menu. The choice is kept in the `cloudlink_theme` cookie.
- **Logo.** PNG, JPEG or WebP up to 512 KB. The file contents are checked, so SVG and renamed files are refused. The logo is served publicly from `/api/v1/branding/<slug>/logo` with `nosniff` and a locked-down content security policy.
- **Portal texts.** A welcome message on the portal home page, and support hours in the portal footer.
- **Where it shows.** The staff app, the customer portal, the portal sign-in and activation pages, and the hotspot captive portal. Changes are audited as `settings.branding.update`.

## Payment methods (Settings → Payment methods)
- **Kinds.** M-Pesa Paybill, M-Pesa Till (Buy Goods), bank transfer, cash at an office, and other (free text). Each method can have its own name, extra instructions and display order, and can be hidden or shown.
- **Personalised instructions.** Customers see the instructions with their own account number filled in, on the portal home page, on the invoice page and in a "How to pay" section of invoice PDFs. The section is left off paid or void invoices.
- **Limits and scope.** Up to 20 methods per organization. Every change is audited and organization-scoped.
- **Not the same as online payment.** These entries are instructions only. Paying online from the portal (an M-Pesa prompt to the phone) is a separate integration, set up under Integrations → M-Pesa. The settings tab shows whether it is enabled, in test mode, or off.

## Live sessions (Network Sessions page and customer portal)
- **Live mode.** The sessions page runs in live mode by default. While the page is open and visible:
  - It asks the worker to re-read the routers every 30 seconds. Requests are de-duplicated, so many viewers share one router read.
  - It re-renders from the database every 10 seconds.
  - It shows online counts (PPPoE and hotspot), how long ago the last sync ran, and a warning when data is more than 10 minutes old. That usually means the worker is not running or cannot reach the routers.
  - Live mode can be paused, and the choice is remembered in the browser.
- **Scheduled sync.** A sync still runs every 5 minutes for organizations that have routers, even when nobody is watching.
- **Customer "My connection" card.** Shows online or offline, time online, IP address, and data downloaded and uploaded in the current session, from the last sync. It refreshes every 30 seconds, says how fresh the reading is, and flags stale data. Customers never trigger router traffic. The same data is available from `GET /api/v1/customer/connection`.
- **Test mode.** The mock network adapter simulates sessions only for lines Cloudlink has enabled and for active hotspot vouchers. The simulation is deterministic, uses 10.64.0.0/10 addresses and locally administered MAC addresses, and never stores voucher codes. Every simulated row is labelled "Simulated" (staff) or "Test data" (customers). The mock adapter is refused in production.
- **Retention.** Succeeded routine jobs (session syncs, health checks, monitors) are pruned after 14 days by the daily `maintenance.prune` job. Failed jobs are kept.
