import "server-only";
import { Pool, type PoolClient } from "pg";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import type { ActiveSession } from "@/server/integrations/network";

/**
 * FreeRADIUS SQL provisioning adapter (rlm_sql, PostgreSQL dialect).
 *
 * Cloudlink writes the standard FreeRADIUS tables in a database the RADIUS server reads:
 * - radcheck:     Cleartext-Password (required for PPPoE CHAP/MS-CHAPv2) and Auth-Type := Reject while disabled
 * - radreply:     Mikrotik-Rate-Limit (optional per-user speed)
 * - radusergroup: group = the package's network profile (group attributes are managed by the operator)
 * - radacct:      read-only; active sessions are rows with acctstoptime IS NULL for the router's NAS address
 *
 * The RADIUS database is an external, operator-secured system. Cloudlink keeps its own copy of the PPPoE password
 * encrypted (AES-GCM) and only writes the plaintext into radcheck because FreeRADIUS requires it for CHAP.
 * Configure with RADIUS_DATABASE_URL (+ RADIUS_DB_SCHEMA). Without it RADIUS provisioning fails with a clear reason.
 */
let pool: Pool | null | undefined;

function settings() {
  const url = process.env.RADIUS_DATABASE_URL ?? "";
  const schema = process.env.RADIUS_DB_SCHEMA || "public";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new PermanentError("RADIUS_DB_SCHEMA is invalid", "RADIUS_MISCONFIGURED");
  return { url, schema };
}

export function radiusConfigured(): boolean {
  return Boolean(process.env.RADIUS_DATABASE_URL);
}

function getPool(): Pool {
  const { url } = settings();
  if (!url) throw new PermanentError("RADIUS provisioning is not configured (RADIUS_DATABASE_URL is empty).", "RADIUS_NOT_CONFIGURED");
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10_000, idleTimeoutMillis: 30_000 });
    pool.on("error", () => undefined);
  }
  return pool;
}

export async function closeRadiusPool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end().catch(() => undefined);
  }
}

/** Fully qualified table name; the schema is validated as a plain identifier above. */
function t(table: "radcheck" | "radreply" | "radusergroup" | "radacct"): string {
  return `"${settings().schema}"."${table}"`;
}

async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch (err) {
    if (err instanceof PermanentError) throw err;
    throw new RetryableError("Cannot reach the RADIUS database", "RADIUS_UNREACHABLE");
  }
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err instanceof PermanentError || err instanceof RetryableError) throw err;
    const code = (err as { code?: string }).code ?? "";
    // 42P01 undefined_table / 42703 undefined_column: schema not installed → permanent until an operator fixes it.
    if (code === "42P01" || code === "42703") throw new PermanentError("The RADIUS database does not have the FreeRADIUS tables", "RADIUS_SCHEMA_MISSING");
    throw new RetryableError("RADIUS database error", "RADIUS_DB_ERROR");
  } finally {
    client.release();
  }
}

export interface RadiusUser {
  username: string;
  password: string;
  group: string;
  rateLimit: string | null;
  disabled: boolean;
}

export interface RadiusResult {
  verified: boolean;
  detail: string;
}

/** Create or update a RADIUS user and its enabled/disabled state, then read it back. */
export async function radiusUpsertUser(u: RadiusUser): Promise<RadiusResult> {
  return withTx(async (c) => {
    const existed = (await c.query(`SELECT 1 FROM ${t("radcheck")} WHERE username = $1 AND attribute = 'Cleartext-Password'`, [u.username])).rowCount! > 0;
    await c.query(`DELETE FROM ${t("radcheck")} WHERE username = $1 AND attribute IN ('Cleartext-Password', 'Auth-Type')`, [u.username]);
    await c.query(`INSERT INTO ${t("radcheck")} (username, attribute, op, value) VALUES ($1, 'Cleartext-Password', ':=', $2)`, [u.username, u.password]);
    if (u.disabled) await c.query(`INSERT INTO ${t("radcheck")} (username, attribute, op, value) VALUES ($1, 'Auth-Type', ':=', 'Reject')`, [u.username]);
    await c.query(`DELETE FROM ${t("radreply")} WHERE username = $1 AND attribute = 'Mikrotik-Rate-Limit'`, [u.username]);
    if (u.rateLimit) await c.query(`INSERT INTO ${t("radreply")} (username, attribute, op, value) VALUES ($1, 'Mikrotik-Rate-Limit', ':=', $2)`, [u.username, u.rateLimit]);
    await c.query(`DELETE FROM ${t("radusergroup")} WHERE username = $1`, [u.username]);
    await c.query(`INSERT INTO ${t("radusergroup")} (username, groupname, priority) VALUES ($1, $2, 1)`, [u.username, u.group]);
    const rows = (await c.query<{ attribute: string; value: string }>(`SELECT attribute, value FROM ${t("radcheck")} WHERE username = $1`, [u.username])).rows;
    const hasPassword = rows.some((r) => r.attribute === "Cleartext-Password");
    const rejected = rows.some((r) => r.attribute === "Auth-Type" && r.value === "Reject");
    return { verified: hasPassword && rejected === u.disabled, detail: `RADIUS user ${u.username} ${existed ? "updated" : "created"} and ${u.disabled ? "disabled" : "enabled"}` };
  });
}

/** Remove a RADIUS user entirely (idempotent). */
export async function radiusRemoveUser(username: string): Promise<RadiusResult> {
  return withTx(async (c) => {
    const removed = (await c.query(`DELETE FROM ${t("radcheck")} WHERE username = $1`, [username])).rowCount ?? 0;
    await c.query(`DELETE FROM ${t("radreply")} WHERE username = $1`, [username]);
    await c.query(`DELETE FROM ${t("radusergroup")} WHERE username = $1`, [username]);
    const left = (await c.query(`SELECT 1 FROM ${t("radcheck")} WHERE username = $1`, [username])).rowCount ?? 0;
    return { verified: left === 0, detail: removed ? `RADIUS user ${username} removed` : `RADIUS user ${username} was already absent` };
  });
}

/** Connectivity and schema check for the integration status page (never throws). */
export async function radiusHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!radiusConfigured()) return { ok: false, detail: "not configured" };
  try {
    await withTx((c) => c.query(`SELECT 1 FROM ${t("radcheck")} LIMIT 1`));
    return { ok: true, detail: "RADIUS tables reachable" };
  } catch (err) {
    return { ok: false, detail: err instanceof PermanentError || err instanceof RetryableError ? err.message : "RADIUS database check failed" };
  }
}

/** Open accounting sessions for one NAS (router) address. */
export async function radiusActiveSessions(nasAddress: string): Promise<ActiveSession[]> {
  return withTx(async (c) => {
    const rows = (
      await c.query<{
        acctsessionid: string;
        username: string;
        framedipaddress: string | null;
        callingstationid: string | null;
        acctstarttime: Date | null;
        acctsessiontime: string | number | null;
        acctinputoctets: string | null;
        acctoutputoctets: string | null;
      }>(
        `SELECT acctsessionid, username, host(framedipaddress) AS framedipaddress, callingstationid, acctstarttime, acctsessiontime, acctinputoctets, acctoutputoctets
         FROM ${t("radacct")} WHERE acctstoptime IS NULL AND nasipaddress = $1::inet ORDER BY acctstarttime DESC LIMIT 5000`,
        [nasAddress],
      )
    ).rows;
    return rows.map((r) => ({
      kind: "PPPOE" as const,
      externalId: r.acctsessionid,
      username: r.username,
      address: r.framedipaddress ?? undefined,
      macAddress: r.callingstationid ?? undefined,
      uptimeSeconds: r.acctsessiontime == null ? undefined : Number(r.acctsessiontime),
      bytesIn: r.acctinputoctets == null ? undefined : BigInt(r.acctinputoctets),
      bytesOut: r.acctoutputoctets == null ? undefined : BigInt(r.acctoutputoctets),
      startedAt: r.acctstarttime ?? undefined,
    }));
  });
}
