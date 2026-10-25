import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

/** Install the FreeRADIUS-compatible tables (deploy/radius/schema.sql) into `schema` of the given test database. */
export async function installRadiusSchema(url: string, schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("bad schema name");
  const sql = fs.readFileSync(path.resolve(import.meta.dirname, "../../deploy/radius/schema.sql"), "utf8").replaceAll(':"schema"', `"${schema}"`);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function radiusQuery<T extends Record<string, unknown>>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}
