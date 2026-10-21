#!/usr/bin/env bash
set -Eeuo pipefail
# Official entrypoint sources this only when initializing an empty data directory.
psql --no-password --set=ON_ERROR_STOP=1 --username=postgres --dbname=postgres <<'SQL'
\getenv app_password VM2API_POSTGRES_PASSWORD
CREATE ROLE vm2api LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE vm2api OWNER vm2api;
SQL
