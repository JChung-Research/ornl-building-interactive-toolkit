# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

"""Preprocessing module for WeatherAgent talking to the BOPTEST coordinator.

Placed in ``init/`` so the Dockerfile copies it to
``app_agents/client/boptest_weather_init.py``, importable as
``app_agents.client.boptest_weather_init``.
"""

import logging

_log = logging.getLogger(__name__)


def initialize(BASE, system_id):
    """Called by WeatherAgent on startup.

    Return value is NOT stored by the WeatherAgent (unlike InterfaceAgent).
    """
    _log.info('Initialize BOPTEST weather agent "%s"', system_id)


def preprocessing(payload, data_point, building_id):
    """Transform weather data to VOLTTRON format.

    Called as ``self.preprocessing(payload, self.points, self.building_id)``
    — exactly 3 arguments.

    Parameters
    ----------
    payload : dict
        ``{"output": {"outdoorTemperature": 55.3}}``
    data_point : dict
        Config's ``data_point`` dict.
    building_id : str
        Building identifier from config.

    Returns
    -------
    tuple[dict, dict]
        ``(values_dict, metadata_dict)``
    """
    try:
        input_data = payload['output']
    except (KeyError, TypeError) as e:
        _log.error('Error reading payload: %s', e)
        return {}, {}

    temp1 = {}
    temp2 = {}
    for key in input_data:
        if key in data_point:
            temp1[key] = input_data[key]
            temp2[key] = data_point[key]
    return temp1, temp2
