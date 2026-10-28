# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-
import requests, json
import logging
from volttron.platform.agent import utils

utils.setup_logging()
_log = logging.getLogger(__name__)

url = "http://ui:5100"
HEADERS = {'Content-Type': 'application/json'}

def call_back(obj):
    """
    Send sensor data for a system (zone/testcase) to ui_gateway API. 
    
    Args:
        obj (dict): A dictionary where each key is a system ID and the value is the corresponding sensor data.

    Returns:
        dict: Response from the ui_gateway API, containing the updated 'u' control object for the system ID.
    """
    
    json_object = json.dumps(obj, indent=4, default=str)
    try:
        result = requests.put('{0}/set_point'.format(url), headers=HEADERS, data=json_object).json()
        _log.info(f"Result from ui_gateway: {result}")
        return result
    except Exception as e:
        _log.error(f'[ui_init] PUT /set_point to ui_gateway failed: {e}')
        return {}