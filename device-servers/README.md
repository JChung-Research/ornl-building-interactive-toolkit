# ORBIT — Device Servers

Lightweight HTTP/BACnet/Modbus device drivers that expose building equipment (thermostats, energy meters) as simple REST endpoints for the agents
to poll. Part of the **ORBIT** platform — see the [root README](../README.md)
for the overall architecture.

## Where it fits

Each driver is a small Flask service that talks to a physical (or simulated) device
and serves its readings/controls over HTTP. The `InterfaceAgent`
(`middleware/`) reaches these by **service name** on the shared
`orbit` Compose network — e.g. `http://ecobee:5005`.

| Service | Port | Driver | Device |
|---------|------|--------|--------|
| `ecobee` | 5005 | `server_ecobee.py` | ecobee thermostat |
| `egauge` | 5006 | `server_egauge.py` | eGauge energy meter (BACnet/IP) |
| `schneider` | 5004 | `server_schneider.py` | Schneider thermostat (BACnet/IP) |
| `modbus` | 5008 | `server_modbus.py` | Schneider energy meter (Modbus) |

## Run

Normally launched with the whole platform from the repository root (the root
`docker-compose.yml` includes this folder, so the drivers share one network with
the agents that poll them):

```bash
docker compose up -d            # from the repo root
```

Each `Dockerfile.<driver>` builds its service (`orbit-ecobee`, `orbit-egauge`,
`orbit-schneider`, `orbit-modbus`). Topic/device mappings are mounted from the `*_topic.csv` /
`*_device.csv` files; device addresses are set via the `DEVICE_ADDRESS` env in
`docker-compose.yml`.

## Provenance

ORNL-original components. `SPDX-License-Identifier: Apache-2.0`,
Copyright UT-Battelle, LLC — see the root [`NOTICE`](../NOTICE) and [`LICENSE`](../LICENSE).
