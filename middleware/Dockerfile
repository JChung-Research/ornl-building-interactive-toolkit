# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

FROM senhuang/volttron:6.x

COPY scripts /home/volttron/volttron/upgrade_scripts

COPY agents /home/volttron/volttron/app_agents

COPY init /home/volttron/volttron/app_agents/client

COPY agent_config /home/volttron/volttron/config

RUN /bin/bash -c "source /home/volttron/volttron/env/bin/activate"

ENV VOLTTRON_HOME=~/.volttron_central

RUN mkdir /home/volttron/.volttron_central

COPY middleware_config/keystore /home/volttron/.volttron_central/

COPY middleware_config/config /home/volttron/.volttron_central/

COPY middleware_config/auth.json /home/volttron/.volttron_central/

USER root

RUN ln -sf /usr/share/zoneinfo/Etc/UTC /etc/localtime && \
    echo "Etc/UTC" > /etc/timezone

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN /home/volttron/volttron/env/bin/pip install --no-cache-dir \
    --index-url https://pypi.org/simple \
    --trusted-host pypi.org \
    --trusted-host pypi.python.org \
    --trusted-host files.pythonhosted.org \
    "flask==1.1.4"

COPY ping_server.py /home/volttron/ping_server.py

RUN chown volttron /home/volttron/.volttron_central/keystore

RUN chown volttron /home/volttron/.volttron_central/config

RUN chown volttron /home/volttron/.volttron_central/auth.json

RUN chown volttron /home/volttron/.volttron_central/ -R

RUN chown volttron /home/volttron/volttron/config -R

USER volttron