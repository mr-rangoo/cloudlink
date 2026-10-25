import "dotenv/config";

/** Resolve the isolated test database URL and refuse anything that does not look like a test database. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set. Integration tests require an isolated PostgreSQL test database.");
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/_test$|_e2e$/.test(dbName)) {
    throw new Error(`Refusing to run integration tests against database "${dbName}": name must end with _test or _e2e.`);
  }
  return url;
}
