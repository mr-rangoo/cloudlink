# Network automation: MikroTik RouterOS, PPPoE, Hotspot and RADIUS

Cloudlink changes router or RADIUS state only through **durable network operations** with an allowlisted type.
Billing status (`Subscription.status`) and network status (`Subscription.networkStatus`) are separate and both visible.

## Verification status
| Area | Status |
| --- | --- |
| RouterOS API wire protocol and client | Tested against an in-process, protocol-faithful fake RouterOS API server (`tests/support/fake-routeros.ts`): login, `!re`/`!done`/`!trap`/`!fatal`, split TCP frames, timeouts, dropped connections. |
| RouterOS adapter (PPPoE secrets, hotspot users, disconnects, health, sessions) | Tested against the fake server, including read-back verification. |
| RADIUS SQL provisioning and accounting | Tested against real PostgreSQL tables compatible with the FreeRADIUS `rlm_sql` PostgreSQL dialect. |
| Real MikroTik hardware | **Not verified.** No device or private network was available. |
| Real FreeRADIUS server reading these tables | **Not verified.** |
| Supported RouterOS versions | Designed for 6.43+ and 7.x (the post-6.43 `/login` with name and password). Older challenge-response login is not supported. |

Do not treat production network automation as verified until the steps in "Testing against a real router" have been run and recorded in `IMPLEMENTATION_PLAN.md`.

## Adapters (`NETWORK_ADAPTER`)
| Mode | Behaviour |
| --- | --- |
| `mock` (development, tests, demo) | Changes nothing, contacts nothing. Results are `SIMULATED`, verification "not verifiable", and the UI says so. Rejected when `APP_ENV=production`. |
| `routeros` | Real RouterOS API over TCP 8728 or TLS 8729. Every write is read back. Routers set to RADIUS authentication are provisioned through the RADIUS SQL adapter. |
| `disabled` | Every operation fails immediately with "Network automation is disabled". |

Deterministic mock failure injection uses the router name:

| Name contains | Mock behaviour |
| --- | --- |
| `[flaky]` | Attempt 1 of every operation times out, so the retry policy is visible. |
| `[offline]` | Every operation times out, and health checks report offline. |
| `[reject]` | Every operation fails permanently, as if the router refused the change. |

## Router management address policy
Only the worker talks to routers. The web tier never opens a router connection.

1. The address must be an IP literal. Hostnames are refused, so the target cannot be moved through DNS.
2. The address must be private: RFC 1918, CGNAT `100.64.0.0/10`, or IPv6 ULA `fc00::/7`. Public addresses are always refused. Loopback is accepted only outside production, for the fake router in tests.
3. If `MIKROTIK_ALLOWED_NETWORKS` is set, the address must also fall inside one of its CIDRs. Each allowlist entry must itself be private.
4. In production with `NETWORK_ADAPTER=routeros`, `MIKROTIK_ALLOWED_NETWORKS` is mandatory.
5. With `MIKROTIK_CONNECTION_MODE=api-ssl`, routers must use the TLS API.

These checks run when a router is saved, and again before every operation.

## Operation types (the allowlist)
| Type | Local secrets router | RADIUS router | Verification |
| --- | --- | --- | --- |
| `pppoe.enable` | Create or update `/ppp/secret` (password, profile, `disabled=no`). | Write `radcheck` Cleartext-Password, remove `Auth-Type := Reject`, set `radusergroup` and optional `Mikrotik-Rate-Limit`. | Read back profile and disabled state, or the radcheck rows. |
| `pppoe.disable` | Same with `disabled=yes`, then remove matching `/ppp/active` sessions. | Add `Auth-Type := Reject`, then disconnect active sessions through the router API. | Read back. |
| `pppoe.remove` | Remove the secret and its sessions. | Delete the user's radcheck, radreply and radusergroup rows, then disconnect. | Confirms the user is absent. |
| `session.disconnect` | Remove `/ppp/active` or `/ip/hotspot/active` entries for a username. | Same, through the router API. | Confirms none remain. |
| `hotspot.user.upsert` | Create or update `/ip/hotspot/user` (code as username and password, profile, `limit-uptime`, optional MAC). | Same (hotspot vouchers always use the router API). | Read back the profile. |
| `profile.sync` | Create or update the plan's `/ppp/profile` (PPPoE plans) or `/ip/hotspot/user/profile` (hotspot plans) by name: `rate-limit` (with burst) and, for hotspot, `shared-users` = devices per account. | Same through the router API (RADIUS users also get `Mikrotik-Rate-Limit`). | Read back `rate-limit` (burst times compared without the `s` unit) and `shared-users`. |

### Plan profiles (`profile.sync`)
Each plan with a rate limit has a router profile, named by the plan's **Router profile name** (new plans get a stable `cl-<plan-name>` name; older plans fall back to the plan name). PPPoE secrets and hotspot users reference that profile.
- A push is queued when a plan is created, when its name, profile name, speed, burst, devices, access type or router restriction changes, and when staff press **Push to routers** (plan) or call `POST /routers/:id/sync-plans`. Description or price edits do not touch routers.
- Targets: routers that are not archived, have PPPoE (PPPoE plans) or the hotspot (hotspot plans) enabled, and are allowed by the plan's router restriction.
- Automatic pushes are idempotent per plan version and router; a newer push for the same plan and router cancels queued older ones.
- Rates use RouterOS's decimal units (`k` = 1 000 bit/s, `M` = 1 000 000), written upload/download (rx/tx from the router's side), e.g. `5M/5M 10M/10M 4M/4M 30/30`.
- Renaming a profile creates a new profile; the old one is left on the router for whatever still references it.

Plan rules also apply when access is sold or granted: a plan limited to certain routers cannot be provisioned or have vouchers issued for other routers, and a scheduled plan's vouchers are refused outside its time window (the voucher stays unused).

Staff may request only `pppoe.sync` (re-apply a subscription's current access state) and `session.disconnect` through `POST /api/v1/routers/:id/operations`. Arbitrary router commands are rejected with a validation error.

A change counts as successful only when the adapter succeeds **and** the read-back matches. A mismatch is retried.

## Billing → network mapping
Network access follows the billing status of provisioned PPPoE subscriptions. Access is enabled while the subscription is `ACTIVE` and disabled otherwise.

| Billing change | Network operation |
| --- | --- |
| Activate, reactivate, renew after a lapse | `pppoe.enable` |
| Suspend, expire, cancel | `pppoe.disable` |
| Status unchanged and network already in the right state | None |
| Paid invoice renews a lapsed subscription | `pppoe.enable`, queued in the same transaction as the renewal |

The operation row is written in the **same transaction** as the billing change. It cannot be lost after the billing change commits.

- **Superseding.** A newer enable or disable for the same subscription, router and username cancels queued older ones, so only the latest state is applied.
- **Ordering.** An operation waits while an earlier one for the same subscription is still running.
- **Staleness guard.** Before running, an operation checks that the subscription still uses that router and username. If not, it is cancelled with a reason.

## Execution, retries and alerts
- The worker runs one `network.execute` background job per operation. Every attempt is written to the append-only `NetworkOperationAttempt` table with its outcome, a safe error code, detail and duration.
- **Retryable** failures: timeouts, refused or dropped connections, an unreachable RADIUS database, read-back mismatches. Backoff is 30 s, 1 min, 2 min, 4 min, with up to 5 attempts per operation.
- **Permanent** failures: login rejected, the router refused the change (`!trap`, such as an unknown profile), address-policy violations, archived routers, missing credentials, RADIUS not configured, network automation disabled.
- After a permanent failure or exhausted retries, the operation is `FAILED` and the subscription's network status is `ERROR`. A critical `OPERATION_FAILED` alert is raised.
- Staff with `network.operate` can **retry** a failed operation, which adds 5 more attempts. Retry is refused if a newer operation exists for the subscription. Staff can also **cancel** a queued or retrying operation. Both actions are audited.
- `network.monitor` raises an `OPERATION_STUCK` alert for operations running longer than 10 minutes, or queued or retrying with no progress for 30 minutes.
- Alerts resolve automatically when the operation later succeeds, or the router comes back online. Staff can also resolve them by hand.

## Scheduled jobs
These jobs run only for organizations with at least one active router.

| Job | Every | Purpose |
| --- | --- | --- |
| `routers.healthcheck` | 15 min | Reads `/system/resource` and `/system/identity`. Records status, version and board, and raises or resolves `ROUTER_OFFLINE` alerts. |
| `network.sync_sessions` | 5 min | Reads `/ppp/active` and `/ip/hotspot/active`, or `radacct` for RADIUS routers. Upserts `NetworkSession` and closes sessions that disappeared. |
| `network.monitor` | 15 min | Raises stuck-operation alerts. |

Staff can also queue a health check ("Check now") or a session refresh. Both run in the worker.

## Secrets
- **Router API credentials.** Encrypted with AES-256-GCM, bound to the router id (`router:<id>`). They are write-only through the API, never returned or logged, and decrypted only in the worker.
- **PPPoE passwords.** 12 random characters, encrypted and bound to the subscription (`pppoe:<id>`). "Show credentials" requires `network.operate` and is audited without the password. Its response is never cached and never stored in the idempotency table. Removing access deletes the stored password.
- **RADIUS.** FreeRADIUS needs `Cleartext-Password` in `radcheck` for PPPoE CHAP and MS-CHAPv2. Treat the RADIUS database as a secret store: give it its own credentials and network restrictions, and back it up encrypted.
- Operation records hold only non-secret parameters, such as the username and reason.

## Setting up a MikroTik router

### Option A: the one-time setup command (recommended)
On the router's page, click **Setup command**, then **Generate command**. You get one line to paste into the router terminal (WinBox → New Terminal, or SSH):

```
/tool fetch mode=https url="https://<cloudlink>/api/v1/routers/setup/<token>" dst-path=cloudlink-setup.rsc; :delay 2s; /import file-name=cloudlink-setup.rsc;
```

The link works **once** and expires after **30 minutes**. Generating a new command cancels the previous one. Only a hash of the token is stored.

When the router downloads the script, Cloudlink:
- generates a new API password, stores it encrypted, and replaces the router's previous credentials in Cloudlink;
- records when and from which public address the script was fetched;
- queues a health check for one minute later.

The script itself (original Cloudlink content, idempotent):
- creates the user group `cloudlink` (`api`, `read`, `write` only) and the user `cloudlink-api`, allowed to log in only from `ROUTER_MANAGEMENT_SOURCES`;
- enables the API (or API-SSL with a self-signed certificate) for those addresses only;
- adds a firewall rule at the top of the input chain that drops API traffic from anywhere else;
- for RADIUS routers, adds the RADIUS server (`RADIUS_SERVER_ADDRESS`, `RADIUS_SHARED_SECRET`) for PPP and turns on RADIUS authentication and accounting;
- for hotspot routers, adds Cloudlink's host to the walled garden;
- deletes the downloaded file, which contains the password.

It never opens the API to the internet and does not change routing, PPPoE servers, pools or profiles.

Things to know:
- Set `ROUTER_MANAGEMENT_SOURCES` to the address the Cloudlink worker uses on your VPN (for example `10.8.0.1/32`). If it is empty, the API is restricted to private ranges in general, which is looser.
- The router's management address in Cloudlink must still be its private or VPN address. The script does not create a VPN.
- Treat the command like a password until it has been used. If the import fails part-way, generate a new command.
- RouterOS `fetch` may not validate the server certificate on older versions. The single use and short lifetime limit the exposure.
- **Not verified on hardware.** The script is unit-tested for content and escaping only.

### Option B: manual setup
Review these commands against your RouterOS version before running them.

```
# Dedicated least-privilege API user, reachable only from the Cloudlink worker's VPN address
/user group add name=cloudlink policy=api,read,write,!local,!telnet,!ssh,!ftp,!reboot,!policy,!test,!winbox,!password,!web,!sniff,!sensitive,!romon
/user add name=cloudlink-api group=cloudlink address=10.8.0.10/32 password=<long random password>

# Prefer the TLS API, restricted to the worker's address
/ip service set api-ssl disabled=no address=10.8.0.10/32 certificate=<your certificate>
/ip service set api disabled=yes

# Defence in depth: drop API traffic from anywhere else
/ip firewall filter add chain=input protocol=tcp dst-port=8728,8729 src-address=!10.8.0.10 action=drop comment="Cloudlink API: VPN only"
```

Create PPP profiles (and hotspot user profiles) whose names match each package's **Router profile** field. If the field is empty, the profile name is the package name. Rate limits and address pools live in those profiles.

For the hotspot captive portal, see `docs/VOUCHERS.md`.

## RADIUS deployment
```
 Cloudlink worker ──(PostgreSQL 5432)──▶ RADIUS database ◀── FreeRADIUS (rlm_sql, dialect=postgresql)
        │                                                        ▲
        │ RouterOS API (VPN, 8729)                               │ RADIUS UDP 1812 auth / 1813 accounting
        ▼                                                        │
   MikroTik NAS (PPPoE server) ──────────────────────────────────┘
```

1. Install the schema that ships with your FreeRADIUS version in the RADIUS database. `deploy/radius/schema.sql` is a minimal compatible subset, used for development and tests.
2. Give Cloudlink a database user with `SELECT, INSERT, UPDATE, DELETE` on `radcheck`, `radreply` and `radusergroup`, and `SELECT` on `radacct`. Set `RADIUS_DATABASE_URL` and `RADIUS_DB_SCHEMA`.
3. Configure FreeRADIUS: enable the `sql` module (`dialect = "postgresql"`, `read_groups = yes`), and use `sql` in `authorize` and `accounting`. Group attributes in `radgroupreply` stay operator-managed.
4. On each MikroTik NAS:
   ```
   /radius add service=ppp address=<radius server> secret=<shared secret> src-address=<router private ip>
   /ppp aaa set use-radius=yes accounting=yes interim-update=5m
   ```
5. In Cloudlink, register the router with **PPPoE authentication: RADIUS**. API credentials are still required, because disconnects go through the router API.
6. Firewall: UDP 1812 and 1813 from the NAS addresses to the RADIUS server only. Port 5432 on the RADIUS database only from FreeRADIUS and the Cloudlink worker.

Not implemented: RADIUS CoA or Disconnect-Message (UDP 3799). Active sessions are disconnected through the router API instead.

## Deployment topology and ports
| From | To | Port | Notes |
| --- | --- | --- | --- |
| Worker | Routers | TCP 8729 (API-SSL) or 8728 | Over VPN or private network only, never the public internet. |
| Worker | RADIUS database | TCP 5432 | Only when RADIUS routers are used. |
| Routers (NAS) | FreeRADIUS | UDP 1812 and 1813 | RADIUS routers only. |
| Customers' browsers | Cloudlink web | TCP 443 | Captive portal and customer portal. |

Run WireGuard, OpenVPN or IPsec from the worker host to your routers, and put that subnet in `MIKROTIK_ALLOWED_NETWORKS`.

## Configuration
| Variable | Purpose |
| --- | --- |
| `NETWORK_ADAPTER` | `mock`, `routeros` or `disabled`. |
| `MIKROTIK_CONNECTION_MODE` | `api-ssl` forces TLS for every router. `api` allows plain API on private links. |
| `MIKROTIK_ALLOWED_NETWORKS` | Comma-separated private CIDRs that router addresses must fall in. Required in production with RouterOS. |
| `ROUTEROS_TIMEOUT_MS` | Per-connection and per-reply timeout. Default 8000. |
| `RADIUS_DATABASE_URL`, `RADIUS_DB_SCHEMA` | FreeRADIUS SQL database for RADIUS routers. |
| `ROUTER_MANAGEMENT_SOURCES` | Addresses the worker connects from (its VPN address). Written into setup scripts as the only allowed API sources. |
| `RADIUS_SERVER_ADDRESS`, `RADIUS_SHARED_SECRET` | Written into the setup script of RADIUS routers. Cloudlink does not speak RADIUS UDP itself. |
| `OPERATION_BACKOFF_BASE_MS` | Shortens retry backoff outside production. Used by end-to-end tests. |

## Testing against a real router
Do this when hardware and private connectivity are available.

1. Connect the worker host to the router over VPN. Set `NETWORK_ADAPTER=routeros` and `MIKROTIK_ALLOWED_NETWORKS=<vpn subnet>`. Create the `cloudlink-api` user as shown above.
2. Register the router, then click **Check now**. Expect status Online, with identity and version filled in.
3. Create a test PPPoE package whose Router profile exists on the router. Provision a test subscriber, then check with `/ppp secret print where name=<username>` on the router.
4. Suspend the subscriber, then confirm `disabled=yes` and that the test CPE was disconnected. Reactivate it and confirm the CPE reconnects.
5. Disconnect the VPN and suspend again. Confirm the operation retries, ends `FAILED` after 5 attempts, and raises an alert. Reconnect and retry it.
6. Record the RouterOS version, board, commands and results in `IMPLEMENTATION_PLAN.md`.

## Automated tests
- `tests/unit/network.test.ts`: protocol framing, injection guards, address policy, environment guards, error classification.
- `tests/integration/network.test.ts`: RouterOS adapter and engine against the fake RouterOS server. Covers lifecycle, superseding, retries, permanent failures, alerts, retry and cancel, moving routers, removing access, sessions, hotspot, mock behaviour, authorization and tenancy.
- `tests/integration/radius.test.ts`: RADIUS provisioning and accounting against a `radius` schema in the test database.
- `tests/e2e/network.spec.ts`: a `[flaky]` mock router failure is visible and retried. Unauthorized staff cannot run router actions through the UI or the API.

## Known limitations
- Session data is polled every 5 minutes, not streamed. Usage counters are stored on `NetworkSession`; there is no separate usage-record table.
- Each operation opens its own API connection. That suits moderate volumes; very large fleets may need connection pooling per router.
- Hotspot vouchers need a router chosen on the batch, or exactly one hotspot-enabled router.
- No IPv6 delegation or static IP management.
