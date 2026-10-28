# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime
import time
from time import gmtime, strftime
from flask import Flask, jsonify, request
from flask_restful import Resource, Api, reqparse
# from ecobee import get_thermostat_status_batch, set_thermostat_status, set_thermostat_cool
from ecobee import get_thermostat_status_batch, set_thermostat_batch, set_thermostat_status, clamp_setpoint

token = ''

app = Flask(__name__)
api = Api(app)
actuation = False

activate_get_point = False
activate_set_point = False

# Fake response for '/get_point' 
get_point_response = {

}


def filter_setpoints_by_mode(data):
    """Remove the irrelevant setpoint based on HVACMode.

    cool -> remove desiredHeat; heat -> remove desiredCool; auto/off -> keep both.
    Returns a deep copy so the mutable get_point_response global is not modified.
    """
    from copy import deepcopy
    filtered = deepcopy(data)
    for zone_id, zone in filtered.items():
        mode = zone.get('HVACMode', '').lower()
        sp = zone.get('Setpoint', {})
        if mode == 'cool':
            sp.pop('desiredHeat', None)
        elif mode == 'heat':
            sp.pop('desiredCool', None)
    return filtered


class building_data(Resource):
    '''Interface to get the operation information from ecobee API.'''
    def get(self):
        if activate_get_point:
            now = strftime("%Y-%m-%d-%H-%M-%S", gmtime())
            global token
            token,data = get_thermostat_status_batch(token)
            data = filter_setpoints_by_mode(data)
            return {'status':200, 'message':None, 'payload':{'output':data,'time':now}}
        else:
            now = strftime("%Y-%m-%d-%H-%M-%S", gmtime())
            data = filter_setpoints_by_mode(get_point_response)
            return {'status':200, 'message':None, 'payload':{'output':data,'time':now}}

class building_control(Resource):
    '''Interface to get the operation information from FRP.''' 
    def put(self):
        global token
        now = strftime("%Y-%m-%d-%H-%M-%S", gmtime())
        try:            
            inputs = request.get_json()
            
            if isinstance(inputs, str):
                inputs = json.loads(inputs)
            print("inputs from VOLTTRON: ", inputs)
        except:
            return {'status':400, 'message':'Unexpected Input', 'payload':{'output':None,'time':now}}
        
        for key in inputs.keys():
            if 'desiredHeat' in inputs[key]:
                inputs[key]['desiredHeat'] = clamp_setpoint(inputs[key]['desiredHeat'])
            if 'desiredCool' in inputs[key]:
                inputs[key]['desiredCool'] = clamp_setpoint(inputs[key]['desiredCool'])

            has_heat = 'desiredHeat' in inputs[key]
            has_cool = 'desiredCool' in inputs[key]
            both_differ = has_heat and has_cool and inputs[key]['desiredHeat'] != inputs[key]['desiredCool']
            if both_differ:
                resolved_mode = 'auto'
            elif has_heat:
                resolved_mode = 'heat'
            else:
                resolved_mode = 'cool'

            if activate_set_point:
                heat_sp = inputs[key].get('desiredHeat', inputs[key].get('desiredCool'))
                cool_sp = inputs[key].get('desiredCool', inputs[key].get('desiredHeat'))
                token, r_status, r_heat, r_cool = set_thermostat_batch(key, token, heat_sp, cool_sp, resolved_mode)
                r_status = set_thermostat_status(key, token, resolved_mode)
            else:
                r_status = {'status': 'success', 'data': {'HVACMode': resolved_mode}}
                r_cool = {'status': 'success', 'data': {'type': 'nextTransition', 'desiredTemperature': 76}}
                r_heat = {'status': 'success', 'data': {'type': 'nextTransition', 'desiredTemperature': 68}}

                # Update the fake response with the new setpoints and mode
                if key in get_point_response:
                    if both_differ:
                        get_point_response[key]['Setpoint']['desiredHeat'] = inputs[key]['desiredHeat']
                        get_point_response[key]['Setpoint']['desiredCool'] = inputs[key]['desiredCool']
                        get_point_response[key]['HVACMode'] = 'auto'
                    else:
                        hvac_mode = inputs[key].get('HVACMode')
                        if hvac_mode == 'heat' and has_heat:
                            sp = inputs[key]['desiredHeat']
                            get_point_response[key]['Setpoint']['desiredHeat'] = sp
                            get_point_response[key]['Setpoint']['desiredCool'] = sp
                        elif hvac_mode == 'cool' and has_cool:
                            sp = inputs[key]['desiredCool']
                            get_point_response[key]['Setpoint']['desiredHeat'] = sp
                            get_point_response[key]['Setpoint']['desiredCool'] = sp
                        else:
                            if has_heat:
                                get_point_response[key]['Setpoint']['desiredHeat'] = inputs[key]['desiredHeat']
                            if has_cool:
                                get_point_response[key]['Setpoint']['desiredCool'] = inputs[key]['desiredCool']
                        if 'HVACMode' in inputs[key]:
                            get_point_response[key]['HVACMode'] = inputs[key]['HVACMode']
     
            print('{}: Set thermostat result:'.format(now))
            print(r_status)
            print('r_heat: {}, r_cool: {}'.format(r_heat, r_cool))

        return {'status':200, 'message':None, 'payload':{'output':None,'time':now}}

class health(Resource): 
    def get(self): 
        ts_local = datetime.now().astimezone().isoformat()

        return {'status': 200, 'message': None, 'payload': {"time": ts_local}}


api.add_resource(building_data, '/get_point')
api.add_resource(building_control, '/set_point')
api.add_resource(health, '/ping')

if __name__ == '__main__':
    app.run(host='0.0.0.0',port = 5005, debug=False)