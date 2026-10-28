# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

import logging, csv
from volttron.platform.agent import utils
from typing import Dict, Tuple, Any, Union

utils.setup_logging()
_log = logging.getLogger(__name__)

# Base URL for the Schneider Smart Themostat API endpoint
HEADERS = {'Content-Type': 'application/json'}

def initialize(BASE, system_id):
    _log.info('Initialize agent "{}"'.format(system_id))
    url = f'{BASE}'
    return url

def preprocessing(payload: Dict, data_point: Dict) -> Tuple[Dict, Dict]:
    """
    Processes raw payload from the Schneider API and aligns it with data point definitions.

    Args:
        payload (Dict): Incoming payload containing real-time thermostat data.
        data_point (Dict): Mapping of parameter names to their metadata from config files.

    Returns:
        Tuple[Dict, Dict]: 
            - temp1: Extracted real-time values for each room/parameter.
            - temp2: Corresponding metadata from data_point.
    """
    try:
        input_data = payload['output']
    except KeyError as e:
        _log.error(f"Error reading payload: missing key {e}. Payload was: {payload}")
        return {}, {}

    temp1, temp2 = {}, {}
    for key, room_data in input_data.items():
        temp1.setdefault(key, {})
        temp2.setdefault(key, {})
        
        for subkey, subvalue in room_data.items():
            if subkey == 'OccupiedSetpoint' and isinstance(subvalue, type({})):
                for param, value in subvalue.items():
                    temp1[key][param] = value
                    temp2[key][param] = data_point.get(param, {})
            elif subkey not in ['UnoccupiedSetpoint', 'StandbySetpoint']:
                temp1[key][subkey] = subvalue
                temp2[key][subkey] = data_point.get(subkey, {})

    return temp1, temp2

def thermostat_control(input_object: Union[str, Dict[str, Any]]) -> Dict[str, Dict[str, float]]:
    output_object: Dict[str, Dict[str, float]] = {}

    _log.info('Schneider input_object: "{}"'.format(input_object))

    for room_id, settings in input_object.items():

        desired_heat = settings.get("desiredHeat")
        desired_cool = settings.get("desiredCool")
        mode = settings.get("HVACMode")

        output_object[room_id] = {
            "OccupiedSetpoint": {
                "desiredHeat": desired_heat, 
                "desiredCool": desired_cool
                },
            "HVACMode": mode
        }

    return output_object