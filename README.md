# ORNL Building Interactive Toolkit (ORBIT)

**ORBIT** is an open-source, scalable software platform for **building energy management (BEM) in small and medium-sized commercial
buildings (SMCBs)** — the segment that makes up the large majority of U.S. commercial buildings yet remains widely underserved by affordable, interoperable BEM tooling.

Built on PNNL's **VOLTTRON™** middleware and AEMS framework and substantially extended
at **Oak Ridge National Laboratory**, ORBIT provides:

- **Vendor-agnostic device integration** over the open **BACnet** and **Modbus** protocols — no proprietary lock-in;
- a configuration-driven **web application** for real-time monitoring, time-series visualization, and supervisory control; and
- **automated configuration** — a unified YAML (and Brick Schema) converter that generates each building's config files from a single semantic building model,

all containerized with Docker Compose for reproducible deployment.

## Architecture

| Component | Path | Stack | Role |
|-----------|------|-------|------|
| Web application | [`web-app/`](web-app/) | Next.js + React | Dashboard, API, auth, orchestration |
| ↳ Web server | [`web-app/web-server/`](web-app/web-server/) | Next.js, Prisma, GraphQL, Docker | Server, database, GraphQL API |
| ↳ Web client | [`web-app/web-client/`](web-app/web-client/) | React, Docker | Operator UI |
| Middleware | [`middleware/`](middleware/) | VOLTTRON, Docker | Platform, agents, server UI |
| Device servers | [`device-servers/`](device-servers/) | Python, Docker | Device drivers (ecobee, eGauge, Schneider, Modbus) |
| Configuration converter | [`configuration-converter/`](configuration-converter/) | Python | Unified YAML / Brick Schema → per-building config files |

## Repository layout

```
orbit/
├── docker-compose.yml       Top-level stack — `include`s the components below
├── web-app/                 Web application
│   ├── web-server/             Next.js backend + API
│   ├── web-client/             React operator UI
│   ├── docker/                 Compose orchestration (proxy, certs, db…)
│   └── configs/                Site-specific thermostat + ILC configs (add your own)
├── middleware/               VOLTTRON platform, agents, server UI
├── device-servers/           Device drivers (ecobee, eGauge, Schneider, Modbus)
├── configuration-converter/  Unified YAML / Brick Schema → per-building configs
└── example-config-files/     Sample converter inputs and generated configs
```

## Getting started

The whole platform runs as a **single Compose project (`orbit`)** from the repo
root — middleware, device servers, and the web app share one network,
so services reach each other by name.

```bash
# 1. Provide the web app's secrets (database password, SSO, profiles, …).
cp web-app/.env.example web-app/.env        # then edit
#    Set COMPOSE_PROFILES=proxy in that file to enable the Traefik HTTPS proxy.

# 2. Build and start the whole stack from the repo root.
docker compose build
docker compose up -d
```

> Each component can also be built and run independently from its own folder.

## Provenance / Attribution

This project is **derived from PNNL's [`volttron-pnnl-aems`](https://github.com/VOLTTRON/volttron-pnnl-aems)**, licensed under **Apache-2.0**,
© **Battelle Memorial Institute**. It has been substantially modified and extended at
**Oak Ridge National Laboratory (UT-Battelle, LLC)**.

In accordance with Apache-2.0 §4, the original Battelle copyright and notices are **retained**; UT-Battelle modifications are marked and added alongside them. See [`NOTICE`](NOTICE) for the full attribution and the U.S. Government disclaimer.

### What's different from upstream

ORNL's contributions on top of the upstream AEMS web application include:

- **Operator web client** with configuration-driven dashboards and customizable real-time data visualization ([`web-app/web-client/`](web-app/web-client/));
- **Device servers** exposing ecobee, eGauge, Schneider, and Modbus equipment over REST / BACnet / Modbus ([`device-servers/`](device-servers/));
- **Configuration converter** — a single YAML (or Brick Schema) specification that generates every building's config files, replacing manual multi-file setup ([`configuration-converter/`](configuration-converter/));
- **Top-level Docker Compose orchestration** that runs the whole stack as one project on a shared network.

## License

Licensed under the **Apache License, Version 2.0** — see [`LICENSE`](LICENSE).

`SPDX-License-Identifier: Apache-2.0`

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributions are accepted under Apache-2.0.

## Acknowledgements

This project is developed at **Oak Ridge National Laboratory** in collaboration with **Pacific Northwest National Laboratory**, with funding from the **U.S. Department of Energy Building Technologies Office**, and aims to provide low-cost, user-centric, and interoperable software that enables scalable building energy management systems for small and medium-sized commercial buildings.

## Release

- ORNL Software Registration System (SRS) number: `ORNL-CODE-004110`
- DOE CODE DOI: `TBD`