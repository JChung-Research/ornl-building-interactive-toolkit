# ORBIT — Agent configs (site-specific)

This folder holds the configuration for each Interface/Recv agent pair. Its contents
depend on the building being integrated, so none are included in the repository.

Generate them with the [configuration converter](../../configuration-converter/), which writes:

- `interface_config_<agent_id>` / `recv_config_<agent_id>` — agent configs, into this folder
- `upgrade_interface_<agent_id>` / `upgrade_rec_<agent_id>` — install scripts, into [`../scripts/`](../scripts/)

The default scripts in `../scripts/` (`upgrade_interface`, `upgrade_rec`) expect files named
`interface_config` and `recv_config` here.

Examples: [`example-config-files/volttron/config/`](../../example-config-files/volttron/config/).

The middleware image copies this folder into the container at build time
(`COPY agent_config ...` in [`../Dockerfile`](../Dockerfile)).
