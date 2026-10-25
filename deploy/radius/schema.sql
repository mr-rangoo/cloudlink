-- Minimal FreeRADIUS-compatible SQL tables (PostgreSQL) used by Cloudlink's RADIUS adapter in local development
-- and automated tests. Column names follow the rlm_sql PostgreSQL dialect, so a FreeRADIUS server configured
-- with `dialect = "postgresql"` can read them. In production, install the schema shipped with your FreeRADIUS
-- version instead (it is a superset of these columns) and point RADIUS_DATABASE_URL at that database.
--
-- Usage: psql "$RADIUS_DATABASE_URL" -v schema=radius -f deploy/radius/schema.sql
-- Idempotent: only creates objects that are missing. Never drops anything.

CREATE SCHEMA IF NOT EXISTS :"schema";
SET search_path TO :"schema";

CREATE TABLE IF NOT EXISTS radcheck (
  id        serial PRIMARY KEY,
  username  text NOT NULL DEFAULT '',
  attribute text NOT NULL DEFAULT '',
  op        varchar(2) NOT NULL DEFAULT '==',
  value     text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS radcheck_username ON radcheck (username, attribute);

CREATE TABLE IF NOT EXISTS radreply (
  id        serial PRIMARY KEY,
  username  text NOT NULL DEFAULT '',
  attribute text NOT NULL DEFAULT '',
  op        varchar(2) NOT NULL DEFAULT '=',
  value     text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS radreply_username ON radreply (username, attribute);

CREATE TABLE IF NOT EXISTS radusergroup (
  id        serial PRIMARY KEY,
  username  text NOT NULL DEFAULT '',
  groupname text NOT NULL DEFAULT '',
  priority  integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS radusergroup_username ON radusergroup (username);

CREATE TABLE IF NOT EXISTS radacct (
  radacctid        bigserial PRIMARY KEY,
  acctsessionid    text NOT NULL,
  acctuniqueid     text NOT NULL UNIQUE,
  username         text,
  nasipaddress     inet NOT NULL,
  nasportid        text,
  acctstarttime    timestamp with time zone,
  acctupdatetime   timestamp with time zone,
  acctstoptime     timestamp with time zone,
  acctsessiontime  bigint,
  acctinputoctets  bigint,
  acctoutputoctets bigint,
  callingstationid text,
  framedipaddress  inet,
  acctterminatecause text
);
CREATE INDEX IF NOT EXISTS radacct_active_session ON radacct (nasipaddress, acctstoptime);
