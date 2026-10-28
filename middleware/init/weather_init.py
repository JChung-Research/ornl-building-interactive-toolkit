# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

import logging
from volttron.platform.agent import utils
from typing import Dict, Tuple

utils.setup_logging()
_log = logging.getLogger(__name__)

HEADERS = {'Content-Type': 'application/json'}

def initialize(BASE, system_id):
    _log.info('Initialize agent "{}"'.format(system_id))
    url = f'{BASE}'
    return url

def preprocessing(payload: Dict, data_point: Dict, building: str = None) -> Tuple[Dict, Dict]:
    """
    Extract weather data from OpenWeather API response.

    Args:
        payload (Dict): Incoming payload with key 'output' containing weather values.
        data_point (Dict): Mapping of parameter names to their metadata from config.
        building (str): Building identifier to inject into metadata.

    Returns:
        Tuple[Dict, Dict]:
            - temp1: Extracted real-time values for each parameter.
            - temp2: Corresponding metadata from data_point (with building injected).
    """
    try:
        input_data = payload['output']
    except KeyError as e:
        _log.error(f"Error reading payload: missing key {e}. Payload was: {payload}")
        return {}, {}

    temp1, temp2 = {}, {}
    for key in input_data:
        if key in data_point:
            temp1[key] = input_data[key]
            meta = dict(data_point[key])
            if building is not None:
                meta['building'] = building
            temp2[key] = meta

    return temp1, temp2