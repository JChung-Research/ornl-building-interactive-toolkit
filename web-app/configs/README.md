# ORBIT — Web-app configs (site-specific)

This folder is mounted read-only into the web server at `/app/configs`
(see [`../docker/docker-compose.yml`](../docker/docker-compose.yml)). Its contents depend on
the deployment, so none are included in the repository.

Place here the files that `web-app/.env` points to:

- `SETUP_FILES` — building unit configs (`config_<campus>-<building>-<system>.config`), generated
  by the [configuration converter](../../configuration-converter/).
  Examples: [`example-config-files/unit/`](../../example-config-files/unit/).
- `SETUP_ILC_FILES` — the ILC site file (`site.json`).
- `SETUP_TEMPLATE_FILES` — the ILC templates (`templates/*.json`).
