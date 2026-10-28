#!/bin/bash
# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

# BOPTEST Testing Startup Script
# Starts VOLTTRON with agents configured for BOPTEST coordinator testing.
# Usage: ./start_boptest.sh
#
# Prerequisites:
#   - BOPTEST services running (docker compose up from project1-boptest_original)
#   - Coordinator server running (docker compose up from boptest-coordinator)

source env/bin/activate
volttron -vv &
sleep 30

# --- InterfaceAgent + RecvAgent pair (building sensor data) ---
./scripts/upgrade_interface_boptest
./scripts/upgrade_rec_boptest

# --- WeatherAgent + RecvAgent pair (outdoor temperature) ---
./scripts/upgrade_weather_boptest
./scripts/upgrade_rec_boptest_weather

# Health check server (responds to /ping on port 5000)
python3 -m http.server 5000 --bind 0.0.0.0 &

echo "=== BOPTEST agents started ==="
echo "Agent pairs:"
echo "  InterfaceAgent  <-> RecvAgent        (building data)"
echo "  WeatherAgent    <-> RecvAgent        (weather data)"
echo ""
echo "Tailing VOLTTRON logs..."
tail -f v.log

# $env:TIME_ACCELERATOR=60; docker compose up volttron -d    