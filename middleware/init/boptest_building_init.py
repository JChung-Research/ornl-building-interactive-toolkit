# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

"""Preprocessing module for InterfaceAgent talking to the BOPTEST coordinator.

Placed in ``init/`` so the Dockerfile copies it to
``app_agents/client/boptest_building_init.py``, importable as
``app_agents.client.boptest_building_init``.
"""

import logging

_log = logging.getLogger(__name__)


def initialize(BASE, system_id):
    """Called by InterfaceAgent on startup.

    MUST return the URL — InterfaceAgent stores it as ``self.url``.
    """
    _log.info('Initialize BOPTEST coordinator agent "%s"', system_id)
    return BASE


def preprocessing(payload, data_point):
    """Transform coordinator ``/get_point`` response to VOLTTRON format.

    Called as ``self.preprocessing(result.get('payload'), self.points)``
    — exactly 2 arguments.

    Parameters
    ----------
    payload : dict
        ``{"output": {"indoorTemperature": 72.5, ...}}``
    data_point : dict
        Config's ``data_point`` dict with metadata per key.

    Returns
    -------
    tuple[dict, dict]
        ``(values_dict, metadata_dict)`` published as VOLTTRON message.
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
    # Pass BOPTEST simulation time through for ui_gateway timestamp sync
    if 'time' in input_data:
        temp1['time'] = input_data['time']
    return temp1, temp2


def thermostat_control(input_object):
    """Format control signals for ``PUT /set_point``.

    Called as ``self.thermostat_control(tc_input)`` where *tc_input*
    is the dict from RecvAgent after ``convert_names_to_ids``.

    Follows the same pattern as ``ecobee_init.py``.
    """
    output_object = {}
    for key, settings in input_object.items():
        if isinstance(settings, dict):
            output_object[key] = {
                k: v for k, v in settings.items() if v is not None
            }
        else:
            output_object[key] = settings
    return output_object


def convert_names_to_ids(data):
    """Identity mapping — coordinator uses the same names as the UI."""
    return data
