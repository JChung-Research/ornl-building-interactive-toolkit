# ORBIT — Web Application

The operator-facing web application of the **ORBIT** platform — a configuration-driven dashboard for real-time monitoring, time-series visualization, and supervisory control of building energy systems, plus the API / auth / orchestration layer behind it. See the [root README](../README.md) for the overall architecture and motivation.

## Components

| Path | Stack | Role |
|------|-------|------|
| [`web-server/`](web-server/) | Next.js, Prisma, GraphQL (Apollo/Pothos), Postgres, Redis | Backend, database, GraphQL API, auth |
| [`web-client/`](web-client/) | React | Operator UI |
| [`docker/`](docker/) | Docker Compose | Orchestration (Traefik proxy, certs, db) |
| [`configs/`](configs/) | — | Site-specific building configs (unit configs, `site.json`, templates); not included — see its README |

**Data path:** the client sends control inputs to the server (API); the server mediates with the [middleware](../middleware/), persists configuration, users, and logs in **Postgres**, and buffers recent sensor/actuator data in a short-term **InfluxDB** store.


## Run

The whole platform normally runs as one Compose project from the repository root.
This component needs its own env file:

```bash
cp web-app/.env.example web-app/.env     # set DATABASE_PASSWORD, COMPOSE_PROFILES, …
docker compose up -d                     # from the repo root
```

To run just the web application:

```bash
cd web-app
docker compose up -d                     # uses web-app/docker/ via the include wrapper
```

> Prerequisites for local development: Node.js 20.x, Yarn, and Postgres 16.x. Per-component dev commands are in [`web-server/README.md`](web-server/README.md) and [`web-client/README.md`](web-client/README.md). Sensor collection requires the [middleware](../middleware/) to be running.

## Features

The ORNL operator UI contributes:

- **Sensor-data integration** — collects real-time sensor data from the middleware, stores it long-term, and relays it to the client.
- **Sensor-data visualization** — time-series data line charts, scatter plots, and box plots; users can add/remove charts and select variables.
- **Expanded building/control metadata** — broader building-system compatibility (variables below).

### Supported building & control variables

- `bldgType` / `operator` / `image` / `description` — building type, operator, unit image, description
- `supplyDuctPressure` — supply duct pressure setpoint (AHU)
- `coolingCoilValve` / `heatingCoilValve` — cooling/heating coil valve control signal (AHU)
- `coolingCoilPump` / `heatingCoilPump` — cooling/heating coil pump control signal (AHU)
- `supplyFanSpeed` — supply fan speed setpoint (AHU)
- `supplyAirSetpoint` / `supplyHeaterSetpoint` — supply air / heater temperature setpoints
- `outsideAirDamperPosition` / `returnAirDamperPosition` — damper position setpoints (AHU)
- `zoneDamperPosition` / `zoneReheatControl` — zone damper position / reheat control signal
- `zoneAirSetpoint` / `zoneAirCoolingSetpoint` / `zoneAirHeatingSetpoint` — zone air temperature setpoints
- `zoneOperativeCoolingSetpoint` / `zoneOperativeHeatingSetpoint` — zone operative temperature setpoints
- `controlStagePump` — integer signal to stage the pump on/off
- `hvacMode` (`auto`/`cooling`/`heating`) · `heatingMode` (`heating`/`off`) · `coolingMode` (`cooling`/`off`)

## Provenance

Derived from PNNL's `volttron-pnnl-aems` web application (the `web-server` and parts of `web-client` come from upstream's `app/` and `client/`, Apache-2.0, © Battelle Memorial Institute), substantially extended at ORNL. See the root [`NOTICE`](../NOTICE) and [`LICENSE`](../LICENSE).
