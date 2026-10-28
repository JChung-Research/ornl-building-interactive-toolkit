# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

import requests
import json
import time
from datetime import datetime

# Safe setpoint limits (°F)
MIN_SETPOINT = 55
MAX_SETPOINT = 90

def clamp_setpoint(value, min_temp=MIN_SETPOINT, max_temp=MAX_SETPOINT):
    """Clamp a temperature setpoint to safe bounds."""
    clamped = max(min_temp, min(max_temp, value))
    if clamped != value:
        print(f"[GUARDRAIL] Setpoint {value}°F clamped to {clamped}°F (bounds: {min_temp}-{max_temp}°F)")
    return clamped


def get_credential():
    url = "https://api.sb.ecobee.com/token"
    headers = {"Content-type":"application/json"}
    data = {}
    data["audience"] = "https://api.sb.ecobee.com"
    data["grant_type"] = "client_credentials"
    data["scopes"] = "read:thermostat read:thermostats"
    data["client_id"] = ""
    data["client_secret"] = ""   
    r = requests.post(url,  headers = headers, json = data, verify = False)
    if r.ok:
        return r.json()['access_token']
    else:
        return None   

def get_thermostat_list(token):
    url = "https://api.sb.ecobee.com/api/v1/thermostatIds"
    headers = {}
    headers["authorization"] = "Bearer {}".format(token)
    headers["zzaccept"] = "application/json"       
    r = requests.get(url,  headers = headers, verify = False)
    if r.ok:
        zones = r.json()['data']['items']
        ids = []
        for zone in zones:
            ids.append(zone['id'])
        return ids
    else:
        return r.status_code

def get_thermostat_status(zone_id, token):
    url = "https://api.sb.ecobee.com/api/v1/thermostats/{}/status".format(zone_id)
    headers = {}
    headers["authorization"] = "Bearer {}".format(token)
    headers["accept"] = "application/json"       
    r = requests.get(url,  headers = headers, verify = False)
    if r.ok:
        return r.json()
    else:
        return None

def get_thermostat_status_batch(token):
    tries = 100
    result = {}
    for i in range(tries):
        try:
            zones = get_thermostat_list(token)
        except KeyError as e:
            if i < tries - 1: # i is zero indexed
                time.sleep(3)
                continue
            else:
                raise
        break
    now = datetime.now()
    current_time = now.strftime("%Y/%m/%d %H:%M:%S")
    if type(zones) == type([]):
        for zone in zones:
            res = get_thermostat_status(zone, token)
            if res is not None:
                     temp = {}
                     temp['ZoneTemperature'] = res['data']['temperature']

                     # Add temperature setpoint and HVAC mode
                     temp['Setpoint'] = res['data']['setPoint']
                     temp['HVACMode'] = res['data']['hvacMode']
           
                     result[zone] = temp
    elif zones == 401:
        token = get_credential()
        cur_time_num = time.mktime(datetime.strptime(current_time, "%Y/%m/%d %H:%M:%S").timetuple())
        print("New token:{}".format(cur_time_num))
        if token is not None:
            zones = get_thermostat_list(token)
            if zones is not None:
                for zone in zones:
                    res = get_thermostat_status(zone, token)
                    if res is not None:
                        temp = {}
                        temp['ZoneTemperature'] = res['data']['temperature']   

                        # Add temperature setpoint and HVAC mode
                        temp['Setpoint'] = res['data']['setPoint']
                        temp['HVACMode'] = res['data']['hvacMode']
              
                        result[zone] = temp
    return token, result                    

def set_thermostat_status(zone_id, token, hvac_mode="auto"):
    url = "https://api.sb.ecobee.com/api/v1/thermostats/{}/hvacMode".format(zone_id)
    headers = {}
    headers["authorization"] = "Bearer {}".format(token)
    headers["accept"] = "application/json"
    headers["content-type"] = "application/json"
    data = {}
    data["hvacMode"] = hvac_mode
    r = requests.patch(url,  headers = headers, json = data, verify = False)
    if r.ok:
        return r.json()
    else:
        return None

def set_thermostat_cool(zone_id, token, cooling_setpoint):
    url = "https://api.sb.ecobee.com/api/v1/thermostats/{}/coolHold".format(zone_id)
    headers = {}
    headers["authorization"] = "Bearer {}".format(token)
    headers["accept"] = "application/json"  
    headers["content-type"] = "application/json"
    data = {}
#    data["type"] = "indefinite"
    data["type"] = "nextTransition"    
    data["desiredTemperature"] = cooling_setpoint  
    r = requests.post(url, headers = headers, json = data, verify = False)
    if r.ok:
        return r.json()
    else:
        return None

def set_thermostat_heat(zone_id, token, heating_setpoint):
    url = "https://api.sb.ecobee.com/api/v1/thermostats/{}/heatHold".format(zone_id)
    headers = {}
    headers["authorization"] = "Bearer {}".format(token)
    headers["accept"] = "application/json"  
    headers["content-type"] = "application/json"
    data = {}
#    data["type"] = "indefinite"
    data["type"] = "nextTransition"    
    data["desiredTemperature"] = heating_setpoint  
    r = requests.post(url, headers = headers, json = data, verify = False)
    if r.ok:
        return r.json()
    else:
        return None

def set_thermostat_batch(zone_id, token, heating_setpoint, cooling_setpoint, hvac_mode="auto"):
    heating_setpoint = clamp_setpoint(heating_setpoint)
    cooling_setpoint = clamp_setpoint(cooling_setpoint)
    tries = 50
    for i in range(tries):
        try:
            r_status = set_thermostat_status(zone_id, token, hvac_mode)
        except KeyError as e:
            if i < tries - 1: # i is zero indexed
                time.sleep(3)
                continue
            else:
                raise
        break
    now = datetime.now()
    current_time = now.strftime("%Y/%m/%d %H:%M:%S")
    if r_status == None:
        token = get_credential()
        cur_time_num = time.mktime(datetime.strptime(current_time, "%Y/%m/%d %H:%M:%S").timetuple())
        print("New token:{} at time {}".format(cur_time_num, str(current_time)))
        if token is not None:
            r_status = set_thermostat_status(zone_id, token, hvac_mode)
            r_cool = set_thermostat_cool(zone_id,token,cooling_setpoint)
            r_heat = set_thermostat_heat(zone_id,token,heating_setpoint)
    else:
        r_cool = set_thermostat_cool(zone_id,token,cooling_setpoint)
        r_heat = set_thermostat_heat(zone_id,token,heating_setpoint)
    return token, r_status, r_heat, r_cool