#!/usr/bin/env bash
# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

: "${INFLUXDB_HOST:=influxdb}"
: "${INFLUXDB_ADMIN_USER:=admin}"
: "${INFLUXDB_ADMIN_PASSWORD:=admin}"
: "${INFLUXDB_DBS:=}"
: "${CERT_DIR:=/certs}"

mkdir -p "$CERT_DIR"
CRT="$CERT_DIR/server.crt"
KEY="$CERT_DIR/server.key"

if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
  echo "[INFO] generating self-signed TLS cert..."
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$KEY" -out "$CRT" -subj "/CN=ui"
fi

wait_for_influx() {
  echo "[INFO] Waiting for InfluxDB at http://${INFLUXDB_HOST}:8086/ping ..."
  for i in {1..90}; do
    if curl -sf "http://${INFLUXDB_HOST}:8086/ping" >/dev/null; then
      echo "[INFO] InfluxDB is up."
      return 0
    fi
    sleep 1
  done
  echo "[ERROR] InfluxDB did not become ready in time." >&2
  exit 1
}

create_one_db() {
  local db_name="$1"
  echo "[INFO] Ensuring database '${db_name}' exists ..."

  if curl -sG "http://${INFLUXDB_HOST}:8086/query" \
        --user "${INFLUXDB_ADMIN_USER}:${INFLUXDB_ADMIN_PASSWORD}" \
        --data-urlencode "q=CREATE DATABASE \"${db_name}\"" >/dev/null 2>&1; then
    echo "[INFO] DB '${db_name}' create (with auth) attempted."
    return 0
  fi

  if curl -sG "http://${INFLUXDB_HOST}:8086/query" \
        --data-urlencode "q=CREATE DATABASE \"${db_name}\"" >/dev/null 2>&1; then
    echo "[INFO] DB '${db_name}' create (no auth) attempted."
    return 0
  fi

  echo "[WARN] Could not confirm/create DB '${db_name}'. Continuing anyway."
}

create_dbs() {
  IFS=',' read -ra DB_ARRAY <<< "$INFLUXDB_DBS"
  for db in "${DB_ARRAY[@]}"; do
    db="$(echo "$db" | xargs)"
    [ -n "$db" ] && create_one_db "$db"
  done
}

wait_for_influx
create_dbs

echo "[INFO] Starting Flask UI..."
# exec python /app/ui_gateway.py --certfile "$CRT" --keyfile "$KEY"
exec python /app/ui_gateway.py