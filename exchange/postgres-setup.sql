-- Self-hosted PostgreSQL setup for the KlavierXML MusicXML exchange.
-- Run as a superuser (e.g. postgres):
--   psql -h 127.0.0.1 -U postgres -f exchange/postgres-setup.sql

CREATE DATABASE klavierxml;

\c klavierxml

CREATE TABLE IF NOT EXISTS exchange_scores (
  id text PRIMARY KEY,
  title text NOT NULL,
  composer text NOT NULL,
  credit text,
  filename text NOT NULL,
  format text NOT NULL DEFAULT 'mxl',
  bytes integer NOT NULL DEFAULT 0,
  added date NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,
  license text,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS exchange_scores_created_at_idx
  ON exchange_scores (created_at DESC);
