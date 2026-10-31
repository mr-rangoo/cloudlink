/**
 * Cloudlink's router setup script (RouterOS .rsc), generated per router for the one-time setup command.
 * Original Cloudlink content. It is idempotent: running it again replaces what it created earlier.
 *
 * What it does:
 *  1. creates a least-privilege user group "cloudlink" (api, read, write) and the API user "cloudlink-api" with a
 *     freshly generated password, allowed to log in only from Cloudlink's management addresses;
 *  2. enables the API service (plain API, or API-SSL with a self-signed certificate) restricted to those addresses;
 *  3. adds a firewall rule dropping API traffic from anywhere else;
 *  4. for RADIUS routers, points PPP authentication and accounting at the RADIUS server;
 *  5. for hotspot routers, adds Cloudlink's host to the walled garden (captive portal over HTTP and HTTPS), installs
 *     Cloudlink's login page (a redirect to the captive portal) and allows plain-password login on the hotspot profiles;
 *  6. names the router and installs the Cloudlink agent (see router-agent.ts), when given;
 *  7. deletes the downloaded script file, which contains the password.
 * It never opens the API to the internet, never changes routing, and never touches unrelated configuration.
 */
export const SETUP_FILE_NAME = "cloudlink-setup.rsc";
export const SETUP_USERNAME = "cloudlink-api";
const GUARD_COMMENT = "cloudlink-api-guard";

/** Quote a value as a RouterOS string literal. */
export function rosString(value: string): string {
  return `"${value.replace(/[\\"$]/g, (c) => `\\${c}`).replace(/[\r\n\t]/g, " ")}"`;
}

export interface SetupScriptInput {
  routerName: string;
  apiPort: number;
  useTls: boolean;
  password: string;
  /** CIDRs/IPs the Cloudlink worker connects from (e.g. its VPN address). */
  managementSources: string[];
  radius?: { address: string; secret: string } | null;
  hotspotHost?: string | null;
  /** Hotspot routers: Cloudlink's login page for this router (redirects to the captive portal). */
  hotspotLoginUrl?: string | null;
  /** Router name and Cloudlink agent lines (domain/router-agent.ts agentInstallLines). */
  agentLines?: string[];
  generatedAt: Date;
}

export function buildSetupScript(input: SetupScriptInput): string {
  const sources = input.managementSources.join(",");
  const service = input.useTls ? "api-ssl" : "api";
  const other = input.useTls ? "api" : "api-ssl";
  const name = input.routerName.replace(/[^A-Za-z0-9 ._()[\]-]/g, "").slice(0, 60);
  const lines: string[] = [
    `# Cloudlink router setup for ${name}`,
    `# Generated ${input.generatedAt.toISOString()}. Single use. Contains a password: this file deletes itself.`,
    `:log info "Cloudlink setup: starting"`,
    "",
    "# 1. Least-privilege API account, usable only from Cloudlink's management addresses",
    `:if ([:len [/user group find name="cloudlink"]] = 0) do={ /user group add name="cloudlink" policy=api,read,write,!local,!telnet,!ssh,!ftp,!reboot,!policy,!test,!winbox,!password,!web,!sniff,!sensitive,!romon comment="Cloudlink billing" }`,
    `:if ([:len [/user find name="${SETUP_USERNAME}"]] > 0) do={ /user remove [find name="${SETUP_USERNAME}"] }`,
    `/user add name="${SETUP_USERNAME}" group="cloudlink" password=${rosString(input.password)} address=${rosString(sources)} comment="Cloudlink billing"`,
    "",
    "# 2. API service limited to the management addresses",
  ];
  if (input.useTls) {
    lines.push(
      `:if ([:len [/certificate find name="cloudlink-api"]] = 0) do={ /certificate add name="cloudlink-api" common-name="cloudlink-api" key-usage=tls-server days-valid=3650; /certificate sign "cloudlink-api"; :delay 5s }`,
      `/ip service set ${service} disabled=no port=${input.apiPort} address=${rosString(sources)} certificate="cloudlink-api"`,
    );
  } else {
    lines.push(`/ip service set ${service} disabled=no port=${input.apiPort} address=${rosString(sources)}`);
  }
  lines.push(
    `/ip service set ${other} address=${rosString(sources)}`,
    "",
    "# 3. Drop API traffic from any other source",
    `/ip firewall address-list remove [find list="cloudlink-mgmt"]`,
    ...input.managementSources.map((s) => `/ip firewall address-list add list="cloudlink-mgmt" address=${s} comment="Cloudlink management"`),
    `/ip firewall filter remove [find comment="${GUARD_COMMENT}"]`,
    `/ip firewall filter add chain=input protocol=tcp dst-port=${input.apiPort} src-address-list=!cloudlink-mgmt action=drop comment="${GUARD_COMMENT}"`,
    `:do { /ip firewall filter move [find comment="${GUARD_COMMENT}"] destination=0 } on-error={}`,
  );
  if (input.radius) {
    lines.push(
      "",
      "# 4. PPPoE authentication and accounting through RADIUS",
      `/radius remove [find comment="cloudlink"]`,
      `/radius add service=ppp address=${input.radius.address} secret=${rosString(input.radius.secret)} timeout=3s comment="cloudlink"`,
      `/ppp aaa set use-radius=yes accounting=yes interim-update=5m`,
    );
  }
  if (input.hotspotHost) {
    lines.push(
      "",
      "# 5. Let hotspot users reach the Cloudlink captive portal before logging in (HTTP and HTTPS)",
      `:do { /ip hotspot walled-garden remove [find comment="cloudlink"]; /ip hotspot walled-garden add dst-host=${rosString(input.hotspotHost)} comment="cloudlink" } on-error={ :log warning "Cloudlink setup: hotspot not configured on this router" }`,
      `:do { /ip hotspot walled-garden ip remove [find comment="cloudlink"]; /ip hotspot walled-garden ip add dst-host=${rosString(input.hotspotHost)} action=accept comment="cloudlink" } on-error={}`,
    );
    if (input.hotspotLoginUrl) {
      lines.push(
        "# 5b. Cloudlink's login page in every hotspot profile, and plain-password login so the portal can sign devices in",
        `:foreach p in=[/ip hotspot profile find] do={ :local dir [/ip hotspot profile get $p html-directory]; :if ([:len $dir] = 0) do={ :set dir "hotspot" }; :do { /tool fetch url=${rosString(input.hotspotLoginUrl)} dst-path=($dir . "/login.html") } on-error={ :log warning "Cloudlink setup: could not download the login page" }; /ip hotspot profile set $p login-by=cookie,http-chap,http-pap }`,
      );
    }
  }
  if (input.agentLines?.length) lines.push("", "# 6. Router name and the Cloudlink agent (checks in every minute and applies changes made in Cloudlink)", ...input.agentLines);
  lines.push(
    "",
    "# 7. Remove this file (it contains the API password)",
    `:do { /file remove [find name="${SETUP_FILE_NAME}"] } on-error={}`,
    `:log info "Cloudlink setup: done"`,
    "",
  );
  return lines.join("\n");
}

/** The command an operator pastes into the router terminal. */
export function setupCommand(url: string): string {
  const mode = url.startsWith("https://") ? "https" : "http";
  return `/tool fetch mode=${mode} url="${url}" dst-path=${SETUP_FILE_NAME}; :delay 2s; /import file-name=${SETUP_FILE_NAME};`;
}
