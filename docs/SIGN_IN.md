# Signing in and signing up

## Demo sign-ins on this computer
These accounts exist only in your local development database (created by `npm run db:seed`). Start the app with `npm run dev` and `npm run worker`, then open http://localhost:3100.

**Password for every demo account: `Cloudlink-Demo-2026`**

### Staff (ISP) app: http://localhost:3100/login
| Email | Role | What they can do |
| --- | --- | --- |
| `owner@skyline.demo` | Owner, Skyline Fibre (Demo) | Everything, including settings and staff |
| `accountant@skyline.demo` | Accountant | Invoices, payments, reconciliation, reports |
| `cashier.wld@skyline.demo` | Cashier (Westlands branch only) | Record payments for one branch |
| `tech@skyline.demo` | Technician | Routers, sessions, network operations |
| `support@skyline.demo` | Support | Tickets and customer records |
| `sales@skyline.demo` | Sales | Leads and new subscribers |
| `owner@lakeside.demo` | Owner, Lakeside Wireless (Demo) | A second, separate ISP (shows tenant isolation) |

### Customer portal: http://localhost:3100/portal/skyline-demo/login
| Phone | Account number | Customer |
| --- | --- | --- |
| `254712000101` | `A000001` | Wanjiru Kamau |

Use the phone number or the account number, with the same password.

### If a password stops working
Run:
```
npm run db:demo-password                    # resets every demo account to Cloudlink-Demo-2026
npm run db:demo-password -- "Your-Own-Pass" # or choose your own (10+ characters)
```
- **What it touches.** Only demo accounts: staff emails ending in `.demo`, and the first customer of each `-demo` organization. It prints the list it changed.
- **Production.** It refuses to run when `APP_ENV=production`.
- **Lockouts.** After 5 wrong passwords an account locks for 15 minutes. The script also clears the lock.

## Creating a new ISP account (sign up)
On the sign-in page, choose **Create an account** (`/signup`).
1. Enter your company name, your name, email, an optional phone number and a password (10+ characters), then tick the box.
2. Cloudlink emails a confirmation link that works once, for 24 hours.
   - **Test mode.** With the mock mailer (`MESSAGING_ADAPTER=mock`, development only), no email is sent. The page shows the message and an **Open the confirmation link** button instead.
3. Open the link and choose **Create \<your company\>**. You become the owner of a new, empty workspace and are signed in.
4. The overview page shows a **Get started** checklist: create a plan, add payment methods, connect a router, add subscribers, brand the portal, invite your team.

Details:
- **Existing emails.** Signing up with an email that already has an account sends a "you already have an account" email instead, and the page shows the same message either way. Nobody can learn who has an account, or take over one.
- **Rate limits.** At most 5 attempts per hour per network address, and 3 per email.
- **Turning it off.** Set `SIGNUP_MODE=closed` to disable sign-up. The page then says sign-up is closed.
- **In production** sign-up needs a real mailer (`MESSAGING_ADAPTER=live` with SMTP settings). Without one, it says sign-up is unavailable.

## Customers who don't have a portal account
On any provider's portal sign-in page, choose **Sign up** (`/portal/<provider>/signup`):
- **New customer: Request a connection.** Name, phone, location and an optional plan. This becomes a lead in the ISP's CRM (Leads, source "Website"). Operators who enabled "Someone asks for a connection on the customer portal" under Settings → Operator alerts get an SMS or email. After installation, staff send the portal setup link as usual.
- **Already a customer: Send me a link.** Enter a phone or account number. If it matches an enabled customer account, a link to set the password is sent by SMS or email; it works for 72 hours. This also serves as "forgot password". The reply is the same whether or not the number matched.

## Test accounts used by the automated browser tests
The e2e tests use a separate database (`cloudlink_e2e`). Their accounts, for example `owner@alpha.e2e.test` with password `E2E-Password-123!`, are listed in `tests/e2e/users.ts`. They do not exist in your development database.
