# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

import argparse
import threading
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any, Dict, List, Optional

import pandas as pd
from flask import Flask, request
from flask_restful import Api, Resource
from pandas.tseries.holiday import AbstractHolidayCalendar, Holiday

# --- web / manager modules ---
import sys, os
# Holiday and observance objects (local holiday_utils.py)
from holiday_utils import ALL_HOLIDAYS, OBSERVANCE
from influxdb_historian.influxdb_utils import *
from influxdb_historian.influxdb_utils import (
    _auto_bucket_interval,
    _influx_db_for_measurement,
    _ensure_influx_database,
    get_influx_client,
    get_all_influx_clients,
)

# ----------------- FLASK APPS -----------------
app_middleware = Flask(__name__)
api_middleware = Api(app_middleware)

app_web = Flask(__name__)
api_web = Api(app_web)

# ----------------- AUTH INFO -----------------
VALID_USERNAME = "admin"
VALID_PASSWORD = "admin"

# ----------------- GLOBAL STATE -----------------
u = {} # Control values for forwarding to the VOLTTRON backend
y = {} # Environmental and control values from VOLTTRON to the web applications
y_raw = {} # Raw thermostat data for InfluxDB — never modified by frontend
t_sys = {} # Control values for schedules, holidays, occupancy override
u_uo = {} # Control values for unoccuppied zone temperature setpoints
u_o = {} # Control values for occupied zone temperature setpoints
occ_state = {} # Current occupancy state for each building system / zone
t_bldg = {} # Holidays, occupancy override per building (keyed by building_id)

# u: Control values for forwarding to the VOLTTRON backend
# y: Environmental and control values from VOLTTRON to the web applications
# t_sys: Control values for schedules, holidays, occupancy override
# u_o/u_uo: Control values for occupied/unoccupied zone temperature setpoints
# occ_state: occupancy state per system_id ("occupied"/"unoccupied")
# t_bldg: holidays/occupancies per building_id (like t_sys but building-level)
u: Dict[str, Dict[str, Any]] = {}
y: Dict[str, List[Dict[str, Any]]] = {}
t_sys: Dict[str, Dict[str, Any]] = {}
u_uo: Dict[str, Dict[str, Any]] = {}
u_o: Dict[str, Dict[str, Any]] = {}
occ_state: Dict[str, str] = {}
u_frontend_updated: set = set()  # system_ids with frontend-set values, not yet delivered to InterfaceAgent
u_frontend_configured: set = set()  # system_ids that have been configured by frontend at least once
t_bldg: Dict[str, Dict[str, Any]] = {}

# logical clock used for schedule/holiday checks
timestamp = datetime.now(timezone.utc)
_time_accelerator_val = int(os.environ.get('TIME_ACCELERATOR', '1'))
print("_time_accelerator_val: ", _time_accelerator_val)
time_accelerator = _time_accelerator_val > 1
_time_step_seconds = int(os.environ.get('TIME_STEP', '60'))  # simulation time step
_boptest_sim_year = int(os.environ.get('BOPTEST_SIM_YEAR', str(datetime.now().year)))

_CREATED_DBS: set[str] = set()

# ----------------- DATA CONVERSION TOOL -----------------

data_mapping: Dict[str, Dict[str, Any]] = {

}

def _write_influx_for_systems(sys_keys: list[str]):
    """Write the current y[] snapshot (plus Occupancy) to the right DB per system."""
    if not HISTORIAN_ENABLE:
        return

    for key in sys_keys:
        system_id = f"manager.{key}"
        measurement = building_of(system_id)
        dbname = _influx_db_for_measurement(measurement)

        # Get ALL clients (primary + replica) for this database
        clients = get_all_influx_clients(dbname)
        if not clients:
            continue

        entries = y_raw.get(system_id, [])

        # Only write the active setpoint to InfluxDB based on current HVAC mode
        hvac_mode = ""
        for e in entries:
            if e.get("name") == "HVACMode":
                hvac_mode = str(e.get("value", "")).lower()
                break
        if hvac_mode == "cool":
            entries = [e for e in entries if e.get("name") != "ZoneAirHeatingSetpoint"]
        elif hvac_mode == "heat":
            entries = [e for e in entries if e.get("name") != "ZoneAirCoolingSetpoint"]

        # Append Occupancy as 1/0 for easy plotting
        occ = data_mapping["occupancy"].copy()
        occ["value"] = 1.0 if occ_state.get(system_id, "unoccupied") == "occupied" else 0.0

        # IMPORTANT: force all points (including occupancy) to be written under this building measurement
        entries_with_occ = []
        for e in list(entries) + [occ]:
            ee = e.copy()
            ee["building"] = measurement
            entries_with_occ.append(ee)

        print("\ntimestamp: ", timestamp)

        points = points_from_entries(measurement, system_id, entries_with_occ, timestamp)

        if not points:
            continue

        # Write to every target host
        for client, host_label in clients:
            try:
                _ensure_influx_database(client, dbname, _CREATED_DBS)
                print(f"Writing.. {dbname} @ {host_label}")
                print(f"system keys: {sys_keys}")
                # print(f"points: {points}")
                ok = client.write_points(points=points, time_precision="s", database=dbname)
                if not ok:
                    print(f"[WARN] Influx write unsuccessful. db={dbname} @ {host_label}, points={len(points)}")
            except Exception as ex:
                print(f"[WARN] Influx write failed. db={dbname} @ {host_label}: {ex}")


# ----------------- HELPERS -----------------
def building_of(system_id: str) -> str:
    """Return mapping tag for the given system_id."""
    sid = system_id.lower()

    if "bestest_air" in sid:
        return "bestest_air"
    if "bestest_hydronic" in sid:
        return "bestest_hydronic"
    return "3147"


BUILDING_TIMEZONE = {
    "bestest_air": "America/New_York",
    "bestest_hydronic": "America/New_York",
}

def timezone_of(building_id: str) -> str:
    """Return IANA timezone for the given building."""
    return BUILDING_TIMEZONE.get(building_id, "America/New_York")


# ----------------- WEB STRUCTURERS -----------------
def restructure_sensor_data_by_zone(raw_zone_data: Dict[str, Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Convert raw sensor data by zone into structured web-style list of dictionaries.
    
    Args:
        raw_zone_data (dict): Raw sensor data structured by zone ID.
        
    Returns:
        dict: Restructured data by zone, formatted as web-style sensor entries.
    """

    output: Dict[str, List[Dict[str, Any]]] = {}
    
    for system_id, sensors in raw_zone_data.items():
        building = building_of(system_id)
        structured: List[Dict[str, Any]] = []
        for var, value in sensors.items():           
            meta = data_mapping.get(var)
            if not meta:  # skip unknown points defensively
                continue
            entry = meta.copy()
            entry["value"] = value
            entry["building"] = building
            structured.append(entry)
        # output[f"manager.zone-{system_id}"] = structured
        output[f"manager.{system_id}"] = structured

    return output


def restructure_control_data(control_dict: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Converts flat control input dictionary into web-style structured list format.
    
    Args:
        control_dict (dict): Dictionary of control parameters and their values.
    
    Returns:
        list[dict]: web-style list of structured control entries.
    """
    
    output: List[Dict[str, Any]] = []
    for key, value in control_dict.items():
        matched = next(
            (d for d in data_mapping.values() if d.get("type") == "control" and d.get("name") == key),
            None
        )

        if matched:
            output.append({
                "name": matched["name"],
                "label": matched["label"],
                "type": matched["type"],
                "value": value,
                "unit": matched["unit"]
            })

    return output

# ----------------- UPDATE Y VARIABLE -----------------
def update_zone_environment(y_: Dict[str, List[Dict[str, Any]]],
                            y_env_data: Dict[str, List[Dict[str, Any]]]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Updates the 'sensor' entries for each system (zone) in the global 'y' dictionary.

    Args:
        y_ (dict): The existing y variable (global zone data).
        y_env_data (dict): New environmental data structured by system ID.

    Returns:
        dict: The updated y dictionary.
    """

    y_env_manager_id = next(iter(y_env_data)).removeprefix("manager.")
    y_env_building = building_of(y_env_manager_id)

    for system_id, new_env_list in y_env_data.items():
        if system_id in y_:
            # For fast lookup: map existing sensor name to item dict
            env_name_object = {item['name']: item for item in y_[system_id] if item.get("type") == "sensor"}

            # Update existing sensor values or append as new if not found
            for entry in new_env_list:
                if entry.get("type") != "sensor":
                    continue  # controls are handled by update_zone_controls
                entry_name = entry.get("name")
                if entry_name in list(env_name_object.keys()):
                    env_name_object.get(entry_name)["value"] = entry.get("value")
                else:
                    y_[system_id].append(entry.copy())

        elif system_id.removeprefix("manager.") == 'egauge':
            # Updates HVAC energy data of all zones within the same building as `y_env_building`
            new_values = {entry['name']: entry['value'] for entry in new_env_list}
            for y_system_id, entries in y_.items():
                # Skip zones not belonging to the target building                
                if building_of(y_system_id.removeprefix("manager.")) != y_env_building:
                    continue

                # Update matching sensor values
                for entry in entries:
                    if entry.get("type") == "sensor" and entry.get("name") in new_values:
                        entry['value'] = new_values[entry['name']]

                # Append any missing sensor entries
                existing_names = {entry["name"] for entry in entries if isinstance(entry, dict) and "name" in entry}
                to_add = [entry.copy() for entry in new_env_list
                        if entry.get("type") == "sensor" and entry["name"] not in existing_names]
                if to_add:
                    entries.extend(to_add)
        else:
            # If zone doesn't exist — create with sensor entries only
            y_[system_id] = [e.copy() for e in new_env_list if e.get("type") == "sensor"]

    return y_

def update_zone_controls(y_: Dict[str, List[Dict[str, Any]]],
                         system_id: str,
                         control_data: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Updates the 'control' entries for a given system (zone) in the 'y' dictionary.
    
    Args:
        y_ (dict): The existing y variable (global zone data).
        system_id (str): System ID like "manager.bestest_air".
        control_data (list): List of control entries from web.
        
    Returns:
        dict: The updated y dictionary.
    """

    if system_id in y_:
        # Create a mapping from name to value in new_env_list
        new_values = {entry['name']: entry['value'] for entry in control_data if entry.get("type") == "control"}

        # Update values in existing list if the name matches
        for entry in y_[system_id]:
            if entry['name'] in new_values:
                entry['value'] = new_values[entry['name']]

        # Append any control entries that don't exist yet
        existing_names = {entry["name"] for entry in y_[system_id]}
        for entry in control_data:
            if entry.get("type") == "control" and entry["name"] not in existing_names:
                y_[system_id].append(entry.copy())
    else:
        # Zone doesn't exist: create it with control entries
        y_[system_id] = control_data.copy()

    return y_

# ----------------- SCHEMA DEFINITIONS -----------------
class Params:
    def __init__(self, authentication=None, data=None, **kwargs):
        self.authentication = authentication
        self.data = data or {}

class JSONRPCRequest:
    def __init__(self, jsonrpc=None, _id=None, method=None, params=None, **kwargs):
        self.jsonrpc = jsonrpc
        self.id = _id                # Manager Agent ID (e.g., 'manager.four-pipe-fcu-1')
        self.method = method         # JSON-RPC method (e.g., 'get_temperature_setpoints')
        self.params = params         # Authentication flag and data payload (e.g., {authentication: token, data: data})

# ------------- READ SENSOR DATA FROM VOLTTRON -------------
def get_temperature_setpoints(system_id: str, time_range: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:

    """
    Simulates control setpoints and environmental readings for different BOPTEST test cases.
    Used as a placeholder for VOLTTRON/BOPTEST integration.

    Args:
        system_id (str): System ID like "manager.bestest_air".
        start_time (str | None): Start time in 'YYYY-MM-DD HH:MM:SS' (UTC).
        end_time (str | None): End time in 'YYYY-MM-DD HH:MM:SS' (UTC).
    
    Returns:
        list[dict]: Emulated or actual sensor readings / control signals for that system
    """
    try:
        if isinstance(time_range, dict):
            if time_range.get("start_time"):
                start_time = time_range["start_time"]
            if time_range.get("end_time"):
                end_time = time_range["end_time"]

        measurement = building_of(system_id)
        dbname = _influx_db_for_measurement(measurement)
        client = get_influx_client(dbname)
        _ensure_influx_database(client, dbname, _CREATED_DBS)
        # start_time = start_time or (timestamp - timedelta(hours=6)).strftime('%Y-%m-%d %H:%M:%S')
        # end_time = end_time or timestamp.strftime('%Y-%m-%d %H:%M:%S')
        # start_time = datetime(2025, 9, 21, 19, 00, 0, tzinfo=timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
        # end_time = datetime(2025, 9, 22, 5, 59, 0, tzinfo=timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
        start_rfc = to_rfc3339(start_time)
        end_rfc = to_rfc3339(end_time)
    except Exception as e:
        print(f"[WARN] : {e}")

    interval = _auto_bucket_interval(start_rfc, end_rfc)

    # Pull all points in the window for this system_id, grouped by signal name.
    q = (
        f'SELECT MEAN("value") FROM "{measurement}" '
        f'WHERE "system_id"=\'{system_id}\' AND time >= \'{start_rfc}\' AND time <= \'{end_rfc}\' '
        f'GROUP BY time({interval}), "name" fill(null)'
    )

    print(f"Reading.. {dbname}, {measurement}, {system_id}")

    res = client.query(q, database=dbname)
    # print("res (mean): ", res)

    # Occupancy special handling: use MAX so if any 1.0 exists in bucket => occupied
    q_occ = (
        f'SELECT MAX("value") FROM "{measurement}" '
        f'WHERE "system_id"=\'{system_id}\' AND "name"=\'Occupancy\' '
        f'AND time >= \'{start_rfc}\' AND time <= \'{end_rfc}\' '
        f'GROUP BY time({interval}), "name" fill(null)'
    )
    res_occ = client.query(q_occ, database=dbname)
    # print("res (occupancy max): ", res_occ)

    entries: List[Dict[str, Any]] = []
    for (_series_key, tags), points in res.items():
        if not points:
            continue

        name = (tags or {}).get("name", "")
        if not name:
            continue  # need 'name' to enrich from data_mapping

        # Enrich from data_mapping (label/type/unit not stored in Influx)
        meta = next((m for m in data_mapping.values() if m.get("name") == name), None)
        label = meta.get("label", name) if meta else name
        typ   = meta.get("type", "")     if meta else ""
        unit  = meta.get("unit", "")     if meta else ""

        history = [
            {"time": to_datetime_str(p.get("time")), "value": p.get("mean")}
            for p in points
            if ("mean" in p and p.get("mean") is not None)
        ]
        current_val = history[-1]["value"] if history else None

        if name == "Occupancy":
            # Replace mean-based occupancy with MAX-based occupancy (any occupied in bucket => occupied)
            occ_points = []
            for (_k2, tags2), points2 in res_occ.items():
                if (tags2 or {}).get("name") == "Occupancy":
                    occ_points = points2
                    break

            history = [
                {
                    "time": to_datetime_str(p.get("time")),
                    "value": "occupied" if (p.get("max") is not None and float(p.get("max")) > 0.0) else "unoccupied"
                }
                for p in occ_points
                if "max" in p
            ]

            current_val = history[-1]["value"] if history else None
        # elif name == "HVACMode":
        #     current_val = "occupied" if float(current_val) == 1.0 else "unoccupied" if float(current_val) == 0.0 else current_val
        #     for h in history:
        #         v = h.get("value")
        #         h["value"] = "occupied" if float(v) == 1.0 else "unoccupied" if float(v) == 0.0 else v          

        entries.append({
            "name": name,
            "label": label,
            "type": typ,
            "value": current_val,
            "unit": unit,
            "history": history
        })

    return entries

# ------------------ VOLTTRON AGENTS CONTROLLER ---------------
def set_temperature_setpoints(system_id: str, control_signals: Dict[str, Any]) -> Dict[str, Any]:
    """`    
    Updates control data in 'y' and sends control signals to the physical/emulated backend (e.g., BOPTEST).

    Args:
        y_ (dict): Current global y dictionary (zone data)
        system_id (str): System ID like "manager.bestest_air".
        control_signals (dict): Control setpoints as flat dictionary (e.g., {"SupplyFanSpeed": 0.8})
    
    Returns:
        tuple: (response dict, updated y dict)
    """    
    print("set_temperature_setpoints: ", control_signals)
    try:
        global u, u_o, u_uo, y

        # Update web-structured y first
        control_data = restructure_control_data(control_signals)
        y = update_zone_controls(y, system_id, control_data)

        name_to_key = {
            v["name"]: k
            for k, v in data_mapping.items()
            if v.get("type") == "control"
        }
        u[system_id] = {name_to_key[k]: v for k, v in control_signals.items() if k in name_to_key}
        u_frontend_updated.add(system_id)  # Protect from thermostat overwrite until delivered
        u_frontend_configured.add(system_id)  # Track zones configured by frontend
        u_o[system_id] = {k: v for k, v in control_signals.items() if k in ['ZoneAirCoolingSetpoint', 'ZoneAirHeatingSetpoint', 'ZoneOperativeCoolingSetpoint', 'ZoneOperativeHeatingSetpoint']}
        u_uo[system_id] = {k: v for k, v in control_signals.items() if k in ['UnoccupiedCoolingSetPoint', 'UnoccupiedHeatingSetPoint']}

    except Exception as e:
        return {'status': 400, 'message': f'Unexpected input: {str(e)}', 'payload': None}
    return {'status':200, 'message':'Success', 'payload':y}


# -------------- OCCUPANCY / HOLIDAY / SCHEDULE CONTROLLER --------------
def set_holidays(system_id: str, holidays: Dict[str, Dict[str, Any] | None]) -> Dict[str, Any]:

    """
    Set holiday schedule at building level using static and custom holidays.

    Args:
        system_id (str): System ID like "manager.103" (building derived via building_of).
        holidays (dict): {holiday_name: {} or {month, day, observance}}

    Returns:
        dict: Holiday list stored in `t_bldg[building_id]['holidays']`
    """
    try:
        global t_bldg
        building_id = building_of(system_id)
        t_bldg.setdefault(building_id, {'holidays': [], 'occupancies': {}})

        year = datetime.today().year
        start_date = datetime(year, 1, 1)
        end_date = datetime(year, 12, 31)

        holiday_rules = []
        for name, params in holidays.items():
            if not params and name in ALL_HOLIDAYS:
                holiday_rules.append(ALL_HOLIDAYS[name])
            elif isinstance(params, dict):
                try:
                    month = int(params.get('month'))
                    day = int(params.get('day'))
                    obs_key = params.get('observance', '').lower().replace(" ", "_")
                    observance = OBSERVANCE.get(obs_key)
                    rule = Holiday(name, month=month, day=day, observance=observance)
                    holiday_rules.append(rule)
                except Exception as e:
                    print(f"[WARNING] Failed to create holiday '{name}': {e}")
            else:
                print(f"[WARNING] Skipped unrecognized holiday: {name}")

        # Create a temporary holiday calendar with these rules        
        TempCalendar = type("TempCalendar", (AbstractHolidayCalendar,), {"rules": holiday_rules})

        holiday_dates = pd.to_datetime(TempCalendar().holidays(start=start_date, end=end_date)).sort_values().unique()

        t_bldg[building_id]["holidays"] = [str(date.date()) for date in holiday_dates]
        print(f"\nSet holidays for building {building_id}: {t_bldg[building_id]['holidays']}")

    except Exception as e:
        return {'status': 400, 'message': f'Unexpected input: {str(e)}', 'payload': None}
    return {'status': 200, 'message': 'Success', 'payload': t_bldg[building_id]}


def set_schedule(system_id: str, schedules: Dict[str, Any]) -> Dict[str, Any]:
    """
    Set a weekly schedule for the given system_id and store it in `t_sys`.

    Args:
        system_id (str): System ID like "manager.bestest_air".
        schedule (dict): Weekly schedule with either time range or "always_off".

    Returns:
        dict: API-style response with stored schedule.
    """
    try:
        global t_sys
        t_sys.setdefault(system_id, {'occupancies': {}, 'holidays': [], 'schedules': {}})

        parsed_schedule: Dict[str, Any] = {}

        # Ensure keys like Monday, Tuesday... are normalized
        for day, value in schedules.items():
            day_cap = day.capitalize()
            if isinstance(value, dict):
                # Validate time strings
                _ = datetime.strptime(value["start"], "%H:%M")
                _ = datetime.strptime(value["end"], "%H:%M")
                parsed_schedule[day_cap] = {
                    "start": value["start"],
                    "end": value["end"]
                }
            elif value == "always_off":
                parsed_schedule[day_cap] = "always_off"
            elif value == "always_on":
                parsed_schedule[day_cap] = "always_on"
            else:
                raise ValueError(f"Invalid value for {day}: {value}")

        t_sys[system_id]["schedules"] = parsed_schedule
        print(f"\nSet schedules for {system_id}: {t_sys[system_id]['schedules']}")

    except Exception as e:
        return {'status': 400, 'message': f'Unexpected input: {str(e)}', 'payload': None}
    return {'status': 200, 'message': 'Success', 'payload': t_sys[system_id]['schedules']}


def set_occupancy_override(system_id: str, occupancies: Dict[str, List[Dict[str, str]]]) -> Dict[str, Any]:
    """
    Sets manual occupancy override schedules for a zone/system and stores it under `t_sys`.

    Args:
        system_id (str): System ID like 'manager.bestest_air'
        occupancies (dict): Dict with dates as keys and list of {start, end} dicts as values.

    Returns:
        dict: Updated occupancy override info.
    """
    try:
        global t_sys
        t_sys.setdefault(system_id, {'occupancies': {}, 'holidays': [], 'schedules': {}})

        parsed_occupancies: Dict[str, List[Dict[str, str]]] = {}

        for day, value in occupancies.items():
            try:
                datetime.strptime(day, "%Y-%m-%d")  # Validate date format
            except ValueError:
                raise ValueError(f"Invalid date format: {day}. Expected YYYY-MM-DD.")

            parsed_periods = []
            for v in value:
                try:
                    # Validate time strings
                    datetime.strptime(v["start"], "%H:%M")
                    datetime.strptime(v["end"], "%H:%M")
                    parsed_periods.append({"start": v["start"], "end": v["end"]})
                except Exception as e:
                    raise ValueError(f"Invalid time format in date {day}: {e}")

            parsed_occupancies[day] = parsed_periods

        t_sys[system_id]["occupancies"] = parsed_occupancies
        print(f"\nSet override occupancies for {system_id}: {t_sys[system_id]['occupancies']}")

    except Exception as e:
        return {'status': 400, 'message': f'Unexpected input: {str(e)}', 'payload': None}
    return {'status': 200, 'message': 'Success', 'payload': t_sys[system_id]["occupancies"]}


def _parse_schedule_time(raw: str) -> time:
    """Parse 'HH:MM' schedule time, treating '24:00' as midnight (end-of-day)."""
    if raw.strip() in ("24:00", "24:0"):
        return time(0, 0)
    return datetime.strptime(raw, "%H:%M").time()


def _time_in_range(start: time, end: time, current: time) -> bool:
    """Check if *current* falls within [start, end].

    Special cases:
    - start == end (e.g. 00:00-00:00) → always True (occupied all day)
    - end is midnight and start is not  → range runs until 23:59:59
    """
    if start == end:
        return True                      # 00:00-00:00 means all day
    if end == time(0, 0):
        return current >= start          # midnight end → anything after start
    return start <= current <= end


def get_current_occupancy_state(system_id: str, t_state: Dict[str, Any]) -> str:
    """
    Check current occupancy state based on occupancy overrides, holidays, and schedules.

    Args:
        system_id (str): System ID like "manager.bestest_air".

    Returns:
        str: "occupied" or "unoccupied"
    """

    ts = timestamp if getattr(timestamp, "tzinfo", None) else timestamp.replace(tzinfo=timezone.utc)
    local_ts = ts.astimezone(ZoneInfo(timezone_of(building_of(system_id))))

    today_str = local_ts.strftime("%Y-%m-%d")
    current_time = local_ts.time()

    # 1. Check manual occupancy overrides
    occupancies = t_state.get(system_id, {}).get("occupancies", {})
    for entry in occupancies.get(today_str, []):
        start = _parse_schedule_time(entry["start"])
        end = _parse_schedule_time(entry["end"])
        print("start, current, end: ", start, current_time, end)
        if _time_in_range(start, end, current_time):
            return "occupied"

    # 2. Check holiday (building-level, from t_bldg)
    if today_str in t_bldg.get(building_of(system_id), {}).get("holidays", []):
        return "unoccupied"

    # 3. Check weekly schedule
    weekday = local_ts.strftime("%A")  # 'Monday', 'Tuesday', ...
    schedule = t_state.get(system_id, {}).get("schedules", {}).get(weekday)

    if schedule == "always_off":
        return "unoccupied"
    elif schedule == "always_on":
        return "occupied"

    if isinstance(schedule, dict):
        try:
            start = _parse_schedule_time(schedule["start"])
            end = _parse_schedule_time(schedule["end"])
            if _time_in_range(start, end, current_time):
                return "occupied"
        except Exception as e:
            print(f"[WARNING] Invalid schedule format for {weekday}: {e}")

    # Default to unoccupied
    return "unoccupied"


# ----------------- AUTHENTICATION ENDPOINT -----------------
class auth(Resource):

    """
    Authenticates incoming web clients prior to JSON-RPC interaction.

    Example code to access this endpoint (JavaScript):
    
    await fetch("https://localhost:8443/auth", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "admin" }),
    });
    
    """
    def post(self):
        body = request.get_json()
        username = body.get("username")
        password = body.get("password")
        
        # It could be replaced with secure token-based authentication
        if username == VALID_USERNAME and password == VALID_PASSWORD:
            return {"access_token": True}
        else:
            return {"access_token": False}


# ----------------- AGENT CONTROL (GET /get_point for InterfaceAgent) -----------------
class agent_control(Resource):
    """Returns control signals for VOLTTRON agents via GET /get_point."""

    def get(self):
        manager_id = request.args.get('manager_id', '')
        building_id = request.args.get('building_id', '3147')

        # InterfaceAgent: return occupancy-adjusted control signals for all known zones
        if manager_id in ['ecobee', 'schneider']:
            target_names = {
                "ZoneAirCoolingSetpoint", "ZoneAirHeatingSetpoint",
                "ZoneOperativeCoolingSetpoint", "ZoneOperativeHeatingSetpoint"
            }
            payload = {}
            for sid in list(u):
                if sid not in u_frontend_configured:
                    continue  # Skip zones not configured by frontend
                zone_id = sid.replace("manager.", "")
                if building_of(zone_id) != building_id:
                    continue
                if sid not in t_sys or not all(k in t_sys[sid] for k in ["schedules", "occupancies"]):
                    continue
                current_state = get_current_occupancy_state(sid, t_sys)
                zone_u = dict(u[sid])
                for k in list(zone_u):
                    if k not in data_mapping:
                        continue
                    setpoint_name = data_mapping[k]["name"]
                    if setpoint_name in target_names:
                        if current_state == "unoccupied":
                            if 'Cooling' in setpoint_name:
                                zone_u[k] = u_uo[sid]['UnoccupiedCoolingSetPoint']
                            elif 'Heating' in setpoint_name:
                                zone_u[k] = u_uo[sid]['UnoccupiedHeatingSetPoint']
                        else:
                            zone_u[k] = u_o[sid][setpoint_name]
                payload[zone_id] = zone_u
                u_frontend_updated.discard(sid)
            print(f"[agent_control - {manager_id}] payload: {payload}")
            return {
                'status': 200,
                'payload': payload or None,
            }
        else:
            # Single zone request
            system_id = f"manager.{manager_id}"
            u_frontend_updated.discard(system_id)
            return {
                'status': 200,
                'payload': u.get(system_id, {}),
            }


# ----------------- BUILDING CONTROL (VOLTTRON -> UI) -----------------
class building_control(Resource):
    """
    Receives and processes environmental data updates from the building/emulation layer.
    """

    def put(self):        
        try:
            global y, y_raw, u, u_uo, t_sys, occ_state, timestamp

            body = request.get_json()
            # print("[building_control] body: ", body)
            first_key = next(iter(body))
            body_data = body[first_key]

            # Weather data — save to InfluxDB only, no global variable updates
            if first_key == 'weather':
                system_meta = body_data[1]
                system_data = {first_key: body_data[0]}

                # print("system_meta: ", system_meta)
                # print("system_data: ", system_data)

                # Determine building from metadata
                first_meta_key = next(iter(system_meta))
                building = system_meta[first_meta_key].get('building', '3147')
                measurement = building
                dbname = _influx_db_for_measurement(measurement)

                print(f"[INFO] System 'manager.{first_key}' is currently: occupied")
                print(f"Writing.. {dbname} @ influxdb")
                print(f"system keys: {list(system_data.keys())}")

                if HISTORIAN_ENABLE:
                    # Build entries with name/value/building for each data point
                    entries = []
                    weather_values = system_data[first_key]
                    for key, value in weather_values.items():
                        meta = system_meta.get(key, {})
                        entries.append({
                            'name': meta.get('name', key),
                            'value': value,
                            'building': measurement,
                        })

                    ts = datetime.now(timezone.utc) if not time_accelerator else timestamp
                    points = points_from_entries(measurement, first_key, entries, ts)

                    clients = get_all_influx_clients(dbname)
                    for client, host_label in clients:
                        try:
                            _ensure_influx_database(client, dbname, _CREATED_DBS)
                            client.write_points(points=points, time_precision="s", database=dbname)
                        except Exception as ex:
                            print(f"[WARN] Influx write failed. db={dbname} @ {host_label}: {ex}")

                return {'status': 200, 'message': 'Success', 'payload': None}

            system_meta = body_data[1]
            system_data = body_data[0] if first_key in ['ecobee', 'modbus', 'egauge', 'schneider'] else {first_key: body_data[0]}

            # Sync timestamp with BOPTEST simulation clock (if present)
            # Coordinator uses TIMEZONE=UTC, so BOPTEST 'time' = seconds since Jan 1 UTC.
            # ui_gateway stores timestamp in UTC; local conversion happens in
            # get_current_occupancy_state() via timezone_of().
            _boptest_time_synced = False
            _sd_vals = next(iter(system_data.values()), {})
            if isinstance(_sd_vals, dict) and 'time' in _sd_vals:
                _sim_seconds = _sd_vals.pop('time')
                timestamp = datetime(_boptest_sim_year, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=_sim_seconds)
                _boptest_time_synced = True

            print("system_meta: ", system_meta)
            print("system_data: ", system_data)

            # Update sensor entries in y
            y_env = restructure_sensor_data_by_zone(system_data)
            y = update_zone_environment(y, y_env)

            # Update y_raw with raw thermostat sensor data (for InfluxDB)
            y_raw = update_zone_environment(y_raw, y_env)

            # print("y_env: ", y_env)
            # print("y: ", y)

            # Per-system updates (defaults, occupancy replacement, and mirrored y)
            for key in system_data.keys():
                if key in ['egauge', 'modbus']:
                    continue
                # system_id = f"manager.zone-{key}"
                system_id = f"manager.{key}"
                control_signals = system_data[key]

                # Update y_raw with raw control values from thermostat (for InfluxDB)
                raw_controls = {
                    data_mapping[k]["name"]: v
                    for k, v in control_signals.items()
                    if k in data_mapping and data_mapping[k].get("type") == "control"
                }
                
                if raw_controls:
                    raw_control_data = restructure_control_data(raw_controls)
                    y_raw = update_zone_controls(y_raw, system_id, raw_control_data)

                # Energy meters have no control data — skip control processing
                if first_key in ['egauge', 'modbus']:
                    continue

                # Only populate u when real thermostat control data exists (no defaults)
                real_controls = {k: v for k, v in control_signals.items() if k in data_mapping and data_mapping[k].get("type") == "control"}
                if not real_controls:
                    continue  # No control data — skip this zone

                # Only initialize u from thermostat data if frontend hasn't set values yet
                if system_id not in u:
                    u[system_id] = real_controls
                elif system_id not in u_frontend_updated:
                    # For zones configured by frontend, only update temperature
                    # setpoint keys (restored by occupancy logic below).
                    # Preserve non-setpoint controls (e.g. fcu_oveFan_u,
                    # fcu_oveTSup_u) so frontend values persist across cycles.
                    if system_id in u_frontend_configured:
                        _setpoint_names = {
                            "ZoneAirCoolingSetpoint", "ZoneAirHeatingSetpoint",
                            "ZoneOperativeCoolingSetpoint", "ZoneOperativeHeatingSetpoint",
                        }
                        for k, v in real_controls.items():
                            if k in data_mapping and data_mapping[k]["name"] in _setpoint_names:
                                u[system_id][k] = v
                    else:
                        u[system_id].update(real_controls)
                # If system_id is in u_frontend_updated, frontend values take priority

                u_o.setdefault(system_id, {'ZoneOperativeCoolingSetpoint': 80, 'ZoneOperativeHeatingSetpoint': 60, 'ZoneAirCoolingSetpoint': 80, 'ZoneAirHeatingSetpoint': 60})
                u_uo.setdefault(system_id, {'UnoccupiedCoolingSetPoint': 80, 'UnoccupiedHeatingSetPoint': 60})
                t_sys.setdefault(system_id, {'occupancies': {}, 'schedules': {'Monday': {'start': '06:30', 'end': '18:00'}, 'Tuesday': {'start': '06:30', 'end': '18:00'}, 'Wednesday': {'start': '06:30', 'end': '18:00'}, 'Thursday': {'start': '06:30', 'end': '18:00'}, 'Friday': {'start': '06:30', 'end': '18:00'}, 'Saturday': 'always_off', 'Sunday': 'always_off'}})
                occ_state.setdefault(system_id, 'unoccupied')

                # Check if holiday, schedule, and occupancy informaion is available.
                if system_id not in t_sys or not all(k in t_sys[system_id] for k in ["schedules", "occupancies"]):
                    print("[INFO] Schedule and occupancy information is currently unavailable.")

                else:
                    # Check an occupancy state at the current time
                    current_state = get_current_occupancy_state(system_id, t_sys)
                    occ_state[system_id] = current_state
                    print(f"[INFO] System '{system_id}' is currently: {current_state}")
                    
                    target_names = {
                        "ZoneAirCoolingSetpoint",
                        "ZoneAirHeatingSetpoint",
                        "ZoneOperativeCoolingSetpoint",
                        "ZoneOperativeHeatingSetpoint"
                    }

                    for key in u[system_id]:
                        setpoint_name = data_mapping[key]["name"]
                        if setpoint_name in target_names:
                            # Replace occupied temperature setpoints with unoccupied temperature setpoints within global u variable, vice versa
                            if current_state == "unoccupied":
                                if 'Cooling' in setpoint_name:
                                    u[system_id][key] = u_uo[system_id]['UnoccupiedCoolingSetPoint']
                                elif 'Heating' in setpoint_name:
                                    u[system_id][key] = u_uo[system_id]['UnoccupiedHeatingSetPoint']
                            else:
                                u[system_id][key] = u_o[system_id][setpoint_name]
            
                    # Update y controls from u (rename driver keys -> web names)
                    renamed_data = {
                        data_mapping[key]["name"]: value
                        for key, value in u[system_id].items()
                    }

                    # Update global y variable
                    control_data = restructure_control_data(renamed_data)
                    y = update_zone_controls(y, system_id, control_data)


            if first_key in ['egauge', 'modbus']: # Only update global environmental data and skip updating global control data
                updated_u = {} ; system_data = {}
            elif first_key in ['ecobee', 'schneider']:
                updated_u = {key: u.get(f"manager.{key}") for key in system_data.keys() if f"manager.{key}" in u_frontend_updated} or None
            else:
                updated_u = next((v for k, v in u.items() if k in [f"manager.{key}" for key in system_data.keys()]), None)

            if not _boptest_time_synced:
                if time_accelerator:
                    timestamp += timedelta(seconds=_time_step_seconds)
                else:
                    timestamp = datetime.now(timezone.utc)

            # Persist to InfluxDB (same version & pattern as Alfalfa)
            try:
                # print("body: ", body)
                # print("system_data: ", system_data)
                if system_data != {} : _write_influx_for_systems(list(system_data.keys())) 
            except Exception as e:
                print(f"[WARN] Influx logging skipped due to error: {e}")

        except Exception as e:
            return {'status': 400, 'message': f'Unexpected input: {str(e)}', 'payload': None}
        return {'status':200, 'message':'Success', 'payload': updated_u}
        

# ----------------- JSON-RPC INTERFACE -----------------
class ui_control(Resource):

    """
    Receives JSON-RPC requests from web.

    Supported Methods:
    - get_temperature_setpoints: Returns current environmental + control values
    - set_temperature_setpoints: Updates control values and forwards them to backend

    Returns:
        JSON-RPC-compliant dict with result and metadata
    """

    jsonrpc_to_ignore = ["set_optimal_start", "set_location", "set_configurations"]

    def post(self):
        body = request.get_json()
        try:
            params = Params(**body["params"])
            req = JSONRPCRequest(
                jsonrpc=body.get("jsonrpc"),
                _id=body.get("id"),
                method=body.get("method"),
                params=params
            )
        except Exception as e:
            return {'status': 400, 'message': f'Invalid input: {str(e)}', 'payload': None}

        # currentTimestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        if not req.params or not req.params.authentication:
            return {'status': 401, 'message': 'Unauthorized', 'payload': None}

        try:
            print(f"req.id: {req.id}, req.method: {req.method}")
            print("req.params.data: ", req.params.data)
            if req.method == "get_temperature_setpoints":
                payload = get_temperature_setpoints(req.id, req.params.data)# if (len(y) > 0) elsaee None
            elif req.method == "set_temperature_setpoints":
                payload = set_temperature_setpoints(req.id, req.params.data)
            elif req.method == "set_schedule":
                payload = set_schedule(req.id, req.params.data)
            elif req.method == "set_holidays":
                payload = set_holidays(req.id, req.params.data)
            elif req.method == "set_occupancy_override":
                payload = set_occupancy_override(req.id, req.params.data)
            elif req.method in self.jsonrpc_to_ignore:
                payload = {}
            else:
                return {'status': 400, 'message': f'Unexpected input: {e}', 'payload': None}
        except Exception as e:
            return {'status': 401, 'message': 'Unauthorized', 'payload': None}

        return {
            'status': 200,
            "result": {"status": "success"},
            'jsonrpc': req.jsonrpc,
            'id': req.id,
            'method': req.method,
            'timestamp': timestamp.strftime("%Y-%m-%d %H:%M:%S"),# currentTimestamp,
            'payload': payload
        }

# ----------------- ROUTES -----------------
api_web.add_resource(auth, '/auth')
api_web.add_resource(ui_control, '/gs')
api_middleware.add_resource(agent_control, '/get_point')
api_middleware.add_resource(building_control, '/set_point')

# parser = argparse.ArgumentParser(description="Run UI server with SSL.")
# parser.add_argument('--certfile', type=str, required=True, help='Path to SSL certificate file')
# parser.add_argument('--keyfile', type=str, required=True, help='Path to SSL private key file')
# args = parser.parse_args()


def run_middleware_server():
    print("[INFO] Starting middleware server on port 5100...")
    app_middleware.run(host='0.0.0.0', port=5100, threaded=True)

def run_web_server():
    ui_port = int(os.environ.get('UI_PORT', '8443'))
    print(f"[INFO] Starting web server on port {ui_port}...")
    # app_web.run(host='0.0.0.0', port=ui_port, ssl_context=(args.certfile, args.keyfile), threaded=True)
    app_web.run(host='0.0.0.0', port=ui_port, threaded=True)

if __name__ == '__main__':
    t1 = threading.Thread(target=run_middleware_server)
    t2 = threading.Thread(target=run_web_server)
    t1.start(); t2.start()
    t1.join(); t2.join()