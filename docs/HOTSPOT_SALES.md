# Hotspot self-service sales (captive portal)

Customers on a hotspot buy a plan with M-Pesa on the captive portal and are logged in automatically. Vouchers keep working alongside (see `VOUCHERS.md`).

## Verification status
- Implemented and tested against the mock payment adapter, the in-process fake RouterOS server and a browser (Playwright).
- **Not verified with real M-Pesa or a real MikroTik router.** Sandbox and hardware checks follow `PAYMENTS.md` and `NETWORK.md`.

## Flow
1. The router's hotspot login page (installed by the setup command, see below) redirects the device to `/hotspot/<org>?router=<id>&mac=…&ip=…&link-login-only=…&dst=…`.
2. The portal lists the organization's **Live** hotspot plans (hidden and off plans are not shown), with the price including tax, filtered by the plan's router restriction. Scheduled plans outside their window are shown as unavailable.
3. The customer picks a plan and enters a Safaricom number. `POST /api/v1/hotspot/<org>/purchase`:
   - finds the hotspot customer for that phone, or creates one (`Subscriber.source = hotspot`, display name = the phone number); concurrent purchases for one phone are serialised with an advisory lock;
   - refuses suspended accounts, closed schedules, routers outside the plan's restriction, prices that are not whole shillings, and online purchase when no hotspot router can be identified (outside test mode);
   - sends an STK Push through the normal payment pipeline (`PaymentAttempt.purpose = hotspot_purchase`, with the plan, router, device MAC and IP);
   - returns a **purchase token**. The token is derived from the page's request id with a server key, so a retried request returns the same purchase and never a second prompt; only its hash is stored.
4. The portal polls `POST /purchase/status` with the token. Nothing happens on the browser's word.
5. When M-Pesa's callback is validated and verified (`mobile-money.ts`), the same transaction that records the money calls `applyHotspotPurchaseTx`:
   - the plan's current price must equal the amount paid, otherwise the money is kept as customer credit and the request says so;
   - the customer's hotspot subscription is created or extended: the **same plan while active** continues after the current period (time stacks); a **different plan while active** starts now (the rest of the old plan is replaced); an expired subscription starts now;
   - the subscription snapshot is refreshed to today's plan terms, `autoRenew` is off (no recurring invoices);
   - the period invoice is issued **without** applying other credit and without an "invoice issued" message, then paid with exactly this payment, so a purchase never pays an older unpaid invoice;
   - the router change is queued in the same transaction (`hotspot.access.enable`, or `device.binding.enable` for TV/device plans).
6. After payment the status response contains the login details (username = account number, an 8-character password stored encrypted) for 24 hours, to the token holder only. The portal polls `POST /access` (the login details are the proof) until the router has the user, then posts them to the router's `link-login-only` URL.
7. The activation time (payment confirmed → access confirmed on the router) is recorded on the payment request (`activatedAt`).

## Other ways in
- **Already paid?** `POST /reconnect` with the paying phone and the M-Pesa confirmation code returns the login details again (new device, cleared browser). If the customer is now at another of the organization's hotspots, the login is moved there (disabled on the old router, enabled on the new one). Failures are rate-limited per IP and do not reveal which part was wrong.
- **Free trials** (plan type Trial, price 0): granted directly, once per phone **and** per device MAC within the plan's cool-down (default 30 days). No invoice.
- **TV / streaming devices** (plan type TV / device): the customer enters the device's MAC address; the router lets that MAC through without a login page (`/ip hotspot ip-binding type=bypassed`). Expiry removes the binding.

## On the router
`hotspot.access.enable` creates or updates `/ip/hotspot/user` with the plan profile, `disabled=no`, `limit-uptime` = the time left in the paid period (a router-side backstop), and `limit-bytes-total` for data bundles (counters are reset for a new bundle period). `hotspot.access.disable` sets `disabled=yes` and removes the user's active sessions and login cookies, so the device cannot reconnect silently. All changes are read back.

Expiry runs every minute (`subscriptions.expire_due`). Scheduled plans are switched off when their window closes and back on when it opens (`plans.enforce_schedules`, every minute). Sessions synced from the router are linked to the customer by username (logins) or MAC (bound devices).

## Router setup
The one-time setup command (router page → **Setup command**) now also, on hotspot routers:
- adds Cloudlink's host to the walled garden for HTTP **and** HTTPS (`/ip hotspot walled-garden` and `walled-garden ip`);
- downloads Cloudlink's login page (`/api/v1/hotspot-files/<router id>/login.html`, a redirect with no secrets) into each hotspot profile's HTML directory;
- sets `login-by=cookie,http-chap,http-pap` on the hotspot profiles, because the portal hands the router a plain password.

Set the router's **Hotspot login address** (e.g. `wifi.login`, the hotspot server's DNS name) on the router form: the portal posts login details only to that host or to a private IPv4 address, never to an address taken from a crafted link.

## Portal templates and settings
Settings → Network → **Hotspot** (`/settings?tab=hotspot`, `settings.write`):
- **Template**: ten original designs (Harbor — default, Tiles, Guided, Headline, Night, Prism, Ember, Paper, Ticket, Plain), defined in `src/lib/portal-templates.ts`. Each sets the page and card styling, header style, plan layout (list, tiles, rows, large prices), whether the voucher tab opens first, and whether the how-to-buy steps are shown. Colours follow the organization's Branding theme unless a template sets its own page colour. The gallery renders each template at phone size with the organization's live plans (inert previews; the security policy forbids iframes).
- **Headline** (falls back to the Branding portal welcome, then a default), **how-to-buy steps** (one per line; templates with steps only), **support phone** (falls back to the billing phone) and **WhatsApp number**, and whether the **Voucher** and **Already paid?** tabs are shown.
- Stored in `HotspotSettings` (one row per organization; defaults apply without one). `GET/PUT /api/v1/settings/hotspot`.

## Test mode
With `PAYMENT_ADAPTER=mock` the portal shows **Simulate payment / Simulate cancel**. The simulation goes through the real callback validation and verification, is labelled everywhere, and is refused in production. With `NETWORK_ADAPTER=mock` and no hotspot router registered, access is marked "simulated" and no router is contacted.

## Security notes
- Public endpoints: plans (prices only), purchase (same-origin, rate-limited per IP, per organization and per phone), purchase status (token), access status (login details), reconnect (M-Pesa code + phone; failures rate-limited), simulation (test mode only). All are on the route-guard allowlist.
- Login details are returned only after a verified payment, only to the token holder, and only for 24 hours after the purchase.
