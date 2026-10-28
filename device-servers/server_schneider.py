# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

import asyncio
import argparse
import json
import random
import threading
from datetime import datetime
from time import gmtime, strftime
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
from bacpypes3.apdu import ErrorRejectAbortNack
from bacpypes3.app import Application
from bacpypes3.constructeddata import AnyAtomic
from bacpypes3.pdu import Address
from bacpypes3.primitivedata import Null, ObjectIdentifier, ObjectType
from bacpypes3.vendor import get_vendor_info

from flask import Flask, request
from flask_restful import Resource, Api

##############################################################################
# Network configuration (defaults)
LOCAL_ADDRESS = "0.0.0.0"

# Default single device (kept for backward compatibility with your original script)
DEFAULT_DEVICE_ADDRESS = ""
DEFAULT_DEVICE_INSTANCE = 86254

# BACnet priority: per Schneider SE8650 guide, priority 8 is recommended for
# temperature setpoints, fan-mode, system-mode, etc.
PRIORITY = 8

# CSV that enumerates points to read/write (per-thermostat point map).
TOPIC_CSV = "schneider_topic.csv"
DEVICES_CSV = "schneider_device.csv"
##############################################################################

SYSTEM_MODE_MAP = {
    "off": 1,
    "auto": 2,
    "cool": 3,
    "heat": 4,
}
SYSTEM_MODE_REV = {v: k for k, v in SYSTEM_MODE_MAP.items()}

FAN_MODE_MAP = {
    "on": 1,
    "auto": 2,
    "smart": 3,
}
FAN_MODE_REV = {v: k for k, v in FAN_MODE_MAP.items()}


# ----------------- API SERVER CONFIG -----------------
# Each thermostat must have a unique BACnet address + device instance.
# NOTE: Use whatever you consider a "zone id" as the key (e.g., "3147-102", "Zone-1", etc.)
THERMOSTATS: List[Dict[str, Any]] = [
    # {"zone_id": "zone_1", "device_address": DEFAULT_DEVICE_ADDRESS, "device_instance": DEFAULT_DEVICE_INSTANCE},
    # {"zone_id": "zone_2", "device_address": DEFAULT_DEVICE_ADDRESS, "device_instance": DEFAULT_DEVICE_INSTANCE},
]

# Feature flags (same semantics as your Ecobee example)
activate_get_point = True
activate_set_point = True

# Fake state seed (used when activate_get_point=False and/or activate_set_point=False)
_fake_state: Dict[str, Any] = {}


# Safe setpoint limits (°F)
MIN_SETPOINT = 55
MAX_SETPOINT = 90

def clamp_setpoint(value, min_temp=MIN_SETPOINT, max_temp=MAX_SETPOINT):
    """Clamp a temperature setpoint to safe bounds."""
    clamped = max(min_temp, min(max_temp, value))
    if clamped != value:
        print(f"[GUARDRAIL] Setpoint {value}°F clamped to {clamped}°F (bounds: {min_temp}-{max_temp}°F)")
    return clamped


def _norm(s: str) -> str:
    return (s or "").strip().lower()

# Temperature unit converters (Celsius / Fahrenheit)
def temp_f_to_c(f: float) -> float:
    return ((f - 32) * 5) / 9

def temp_c_to_f(c: float) -> float:
    return (c * 9) / 5 + 32

def _to_float(x: Any) -> Optional[float]:
    if x is None:
        return None
    return float(x)

def load_points(csv_path: str) -> List[Dict[str, Any]]:
    """
    Backward compatible loader:

    - New format (recommended):
        name, object_type, instance, property, ...

    - Old format:
        name, index
      In that case we assume object_type='analogInput', property='presentValue'.
    """
    tab = pd.read_csv(csv_path)

    if "instance" in tab.columns and "object_type" in tab.columns:
        points = []
        for _, row in tab.iterrows():
            points.append(
                {
                    "name": str(row.get("name", "")).strip(),
                    "object_type": str(row.get("object_type", "analogInput")).strip(),
                    "instance": int(row.get("instance")),
                    "property": str(row.get("property", "presentValue")).strip(),
                    "writable": str(row.get("writable", "")).strip(),
                }
            )
        return points

    # Fallback to old format
    points = []
    for _, row in tab.iterrows():
        points.append(
            {
                "name": str(row.get("name", "")).strip(),
                "object_type": "analogInput",
                "instance": int(row.get("index")),
                "property": "presentValue",
                "writable": "",
            }
        )
    return points

def load_devices(csv_path: str) -> List[Dict[str, Any]]:
    """
    devices.csv format:
      zone_id, device_address, device_instance

    Returns:
      [{"zone_id": "...", "device_address": "...", "device_instance": int}, ...]
    """
    tab = pd.read_csv(csv_path)

    required = {"zone_id", "device_address", "device_instance"}
    missing = required - set(tab.columns)
    if missing:
        raise ValueError(f"{csv_path} missing required columns: {sorted(missing)}")

    devices: List[Dict[str, Any]] = []
    for _, row in tab.iterrows():
        zone_id = str(row["zone_id"]).strip()
        addr = str(row["device_address"]).strip()
        inst = int(row["device_instance"])
        if not zone_id or not addr:
            continue
        devices.append({"zone_id": zone_id, "device_address": addr, "device_instance": inst})

    if not devices:
        raise ValueError(f"No valid devices found in {csv_path}")

    return devices

class BACnetProxy:
    def __init__(
        self,
        local_address: str,
        bacnet_network: int = 1,
        vendor_id: int = 999,
        object_name: str = "Excelsior",
        device_info_cache=None,
        router_info_cache=None,
        ase_id=None,
    ):
        vendor_info = get_vendor_info(vendor_id)
        device_object_class = vendor_info.get_object_class(ObjectType.device)

        # This is the LOCAL client device object (not the thermostat's remote device object).
        # Keep it unique on your BACnet network.
        local_device_instance = 999001
        device_object = device_object_class(
            objectIdentifier=("device", local_device_instance), objectName=object_name
        )

        network_port_object_class = vendor_info.get_object_class(ObjectType.networkPort)
        network_port_object = network_port_object_class(
            local_address,
            objectIdentifier=("network-port", bacnet_network),
            objectName="NetworkPort-1",
            networkNumber=bacnet_network,
            networkNumberQuality="configured",
        )

        self.app = Application.from_object_list(
            [device_object, network_port_object],
            device_info_cache=device_info_cache,
            router_info_cache=router_info_cache,
            aseID=ase_id,
        )

    async def write(
        self,
        device_address: str,
        object_identifier: str,
        property_identifier: str,
        value: Any,
        priority: int,
        property_array_index: int | None = None,
    ):
        print(
            f"WRITING: address={device_address}, object={object_identifier}, "
            f"prop={property_identifier}, value={value}, priority={priority}"
        )

        if value is None or value == "null":
            value = Null(())

        try:
            return await self.app.write_property(
                Address(device_address),
                ObjectIdentifier(object_identifier),
                property_identifier,
                value,
                int(property_array_index) if property_array_index is not None else None,
                int(priority),
            )
        except ErrorRejectAbortNack as err:
            print(str(err))
            raise

    async def read(
        self,
        device_address: str,
        object_identifier: str,
        property_identifier: str,
        property_array_index: int | None = None,
    ):
        try:
            response = await self.app.read_property(
                Address(device_address),
                ObjectIdentifier(object_identifier),
                property_identifier,
                int(property_array_index) if property_array_index is not None else None,
            )
        except ErrorRejectAbortNack as err:
            response = err

        if isinstance(response, AnyAtomic):
            response = response.get_value()
        return response


def find_point(points: List[Dict[str, Any]], name: str) -> Dict[str, Any]:
    key = _norm(name)
    for p in points:
        if _norm(p.get("name", "")) == key:
            return p
    raise KeyError(f"Point '{name}' not found in {TOPIC_CSV}")


def try_find_point(points: List[Dict[str, Any]], name: str) -> Optional[Dict[str, Any]]:
    try:
        return find_point(points, name)
    except Exception:
        return None


def oid(point: Dict[str, Any]) -> str:
    return f"{point['object_type']}:{int(point['instance'])}"


async def verify_target_device(proxy: BACnetProxy, device_address: str, device_instance: int):
    """
    Minimal connectivity / identity check:
    read objectName from the thermostat device object (device:<instance>).
    """
    device_oid = f"device:{int(device_instance)}"
    print(f"Verifying target device at {device_address} using {device_oid} ...")
    name = await proxy.read(device_address, device_oid, "objectName")
    print(f"Target device objectName: {name}")


async def read_named_point(proxy: BACnetProxy, points: List[Dict[str, Any]], device_address: str, name: str) -> Any:
    p = find_point(points, name)
    return await proxy.read(device_address, oid(p), p["property"])


async def write_named_point(
    proxy: BACnetProxy,
    points: List[Dict[str, Any]],
    device_address: str,
    name: str,
    value: Any,
    priority: int,
):
    p = find_point(points, name)

    # Convert some common types
    if p["object_type"].lower().startswith("multi"):
        value = int(value)
    else:
        value = float(value)

    await proxy.write(device_address, oid(p), p["property"], value, priority)


def _ensure_fake_state():
    """
    Initialize fake state per thermostat if it doesn't exist yet.
    """
    global _fake_state
    for t in THERMOSTATS:
        rid = str(t["zone_id"])
        if rid not in _fake_state:
            _fake_state[rid] = {
                "RoomTemperature": round(random.uniform(20.0, 26.0), 1),
                "RoomHumidity": round(random.uniform(40.0, 70.0), 1),
                "Co2Level": round(random.uniform(400.0, 800.0), 0),
                "OccupiedSetpoint": {"desiredHeat": 21.1, "desiredCool": 23.3},
                "UnoccupiedSetpoint": {"desiredHeat": 21.1, "desiredCool": 23.3},
                "StandbySetpoint": {"desiredHeat": 21.1, "desiredCool": 23.3},
                "HVACMode": "auto",
                "FanMode": "auto",
            }


def _fake_get_all() -> Dict[str, Any]:
    """
    Generate fake sensor readings + setpoints/modes (random walk on temperature).
    """
    _ensure_fake_state()
    out: Dict[str, Any] = {}
    for rid, st in _fake_state.items():
        # random walk temperature
        delta = 0.5
        st["RoomTemperature"] = round(float(st["RoomTemperature"]) + random.uniform(-1*delta, delta), 1)
        delta = 5
        st["RoomHumidity"] = round(float(st["RoomHumidity"]) + random.uniform(-1*delta, delta), 1)
        delta = 50
        st["Co2Level"] = round(float(st["Co2Level"]) + random.uniform(-1*delta, delta), 0)
        out[rid] = {
            **st,
            "RoomTemperature": round(float(st["RoomTemperature"]), 1),
            "OccupiedSetpoint": {
                "desiredHeat": round(float(st["OccupiedSetpoint"]["desiredHeat"]), 1),
                "desiredCool": round(float(st["OccupiedSetpoint"]["desiredCool"]), 1),
            },
            "StandbySetpoint": {
                "desiredHeat": round(float(st["StandbySetpoint"]["desiredHeat"]), 1),
                "desiredCool": round(float(st["StandbySetpoint"]["desiredCool"]), 1),
            },
            "UnoccupiedSetpoint": {
                "desiredHeat": round(float(st["UnoccupiedSetpoint"]["desiredHeat"]), 1),
                "desiredCool": round(float(st["UnoccupiedSetpoint"]["desiredCool"]), 1),
            },
        }
    return out


def _fake_apply_inputs(inputs: Dict[str, Any]) -> None:
    _ensure_fake_state()
    for rid, cmd in inputs.items():
        rid = str(rid)
        if rid not in _fake_state:
            _fake_state[rid] = {
                "RoomTemperature": round(random.uniform(20.0, 26.0), 1),
                "RoomHumidity": round(random.uniform(40.0, 70.0), 1),
                "Co2Level": round(random.uniform(400.0, 800.0), 0),
                "OccupiedSetpoint": {"desiredHeat": 21.1, "desiredCool": 23.3},
                "UnoccupiedSetpoint": {"desiredHeat": 21.1, "desiredCool": 23.3},
                "StandbySetpoint": {"desiredHeat": 21.1, "desiredCool": 23.3},
                "HVACMode": "auto",
                "FanMode": "auto",
            }
        st = _fake_state[rid]

        # Ensure per-situation setpoints exist (minimal additive state)
        # st.setdefault("OccupiedSetpoint", dict(st["Setpoint"]))
        # st.setdefault("StandbySetpoint", dict(st["Setpoint"]))
        # st.setdefault("UnoccupiedSetpoint", dict(st["Setpoint"]))

        # Accept either your Ecobee-style schema or direct setpoint fields.
        sp = cmd.get("OccupiedSetpoint") or cmd.get("occupiedsetpoint") or {}
        desired_heat = sp.get("desiredHeat", cmd.get("desiredHeat", None))
        desired_cool = sp.get("desiredCool", cmd.get("desiredCool", None))

        # Clamp to safe bounds
        if desired_heat is not None:
            desired_heat = clamp_setpoint(float(desired_heat))
        if desired_cool is not None:
            desired_cool = clamp_setpoint(float(desired_cool))

        # Apply to ALL situations to avoid unwanted setpoints
        if desired_heat is not None:
            v_c = float(desired_heat)
            st["OccupiedSetpoint"]["desiredHeat"] = v_c
            st["StandbySetpoint"]["desiredHeat"] = v_c
            st["UnoccupiedSetpoint"]["desiredHeat"] = v_c

        if desired_cool is not None:
            v_c = float(desired_cool)
            st["OccupiedSetpoint"]["desiredCool"] = v_c
            st["StandbySetpoint"]["desiredCool"] = v_c
            st["UnoccupiedSetpoint"]["desiredCool"] = v_c

        if "HVACMode" in cmd:
            st["HVACMode"] = str(cmd["HVACMode"]).lower()
        if "FanMode" in cmd:
            st["FanMode"] = str(cmd["FanMode"]).lower()

async def _read_all_thermostats(proxy: BACnetProxy, points: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Read room_temperature, occupied heat/cool setpoints, system mode, fan mode from all thermostats.
    Returns {zone_id: {...}}.
    """
    out: Dict[str, Any] = {}

    for t in THERMOSTATS:
        rid = str(t["zone_id"])
        addr = str(t["device_address"])

        # Read points (sequential for robustness)
        temp_v = await read_named_point(proxy, points, addr, "room_temperature")
        humid_v = await read_named_point(proxy, points, addr, "room_humidity")
        co2_v = await read_named_point(proxy, points, addr, "co2_level")
        occ_heat = await read_named_point(proxy, points, addr, "occupied_heat_setpoint")
        occ_cool = await read_named_point(proxy, points, addr, "occupied_cool_setpoint")
        std_heat = await read_named_point(proxy, points, addr, "standby_heat_setpoint")
        std_cool = await read_named_point(proxy, points, addr, "standby_cool_setpoint")
        uno_heat = await read_named_point(proxy, points, addr, "unoccupied_heat_setpoint")
        uno_cool = await read_named_point(proxy, points, addr, "unoccupied_cool_setpoint")
        sys_v = await read_named_point(proxy, points, addr, "system_mode")
        fan_v = await read_named_point(proxy, points, addr, "fan_mode")

        # Convert numeric enums -> human strings when possible
        hvac_mode = SYSTEM_MODE_REV.get(int(sys_v), str(sys_v))
        fan_mode = FAN_MODE_REV.get(int(fan_v), str(fan_v))

        out[rid] = {
            "RoomTemperature": round(float(temp_v), 1),
            "RoomHumidity": float(humid_v),
            "Co2Level": float(co2_v),

            "OccupiedSetpoint": {
                "desiredHeat": round(float(occ_heat), 1),
                "desiredCool": round(float(occ_cool), 1),
            },
            "StandbySetpoint": {
                "desiredHeat": round(float(std_heat), 1),
                "desiredCool": round(float(std_cool), 1),
            },
            "UnoccupiedSetpoint": {
                "desiredHeat": round(float(uno_heat), 1),
                "desiredCool": round(float(uno_cool), 1),
            },

            "HVACMode": hvac_mode,
            "FanMode": fan_mode,
        }

    return out


def _parse_mode_to_int(mode_value: Any, mapping: Dict[str, int]) -> Optional[int]:
    """
    Accept either a number (1-4 etc) or a string ('heat', 'auto', ...).
    """
    if mode_value is None:
        return None
    if isinstance(mode_value, (int, float)) and int(mode_value) in set(mapping.values()):
        return int(mode_value)
    s = str(mode_value).strip().lower()
    return mapping.get(s)


async def _apply_setpoints_to_thermostats(
    proxy: BACnetProxy,
    points: List[Dict[str, Any]],
    inputs: Dict[str, Any],
    priority: int = PRIORITY,
) -> Dict[str, Any]:
    """
    Apply setpoints/modes to multiple thermostats.
    inputs schema (Ecobee-like):

      {
        "<zone_id>": {
          "Setpoint": {"desiredHeat": 68, "desiredCool": 72},
          "HVACMode": "heat",
          "FanMode": "auto"
        },
        ...
      }

    Returns per-zone write results for logging/debugging.
    """
    results: Dict[str, Any] = {}

    # Names from schneider_topic.csv
    HEAT_POINTS = ["occupied_heat_setpoint", "standby_heat_setpoint", "unoccupied_heat_setpoint"]
    COOL_POINTS = ["occupied_cool_setpoint", "standby_cool_setpoint", "unoccupied_cool_setpoint"]
    sys_name = "system_mode"
    fan_name = "fan_mode"

    # Build a map zone_id -> thermostat config
    by_zone = {str(t["zone_id"]): t for t in THERMOSTATS}

    for rid, cmd in inputs.items():
        rid = str(rid)
        if rid not in by_zone:
            results[rid] = {"status": "error", "message": "Unknown zone_id (not in THERMOSTATS config)."}
            continue

        addr = str(by_zone[rid]["device_address"])

        sp = cmd.get("OccupiedSetpoint") or cmd.get("occupiedsetpoint") or {}
        desired_heat = sp.get("desiredHeat", cmd.get("desiredHeat", None))
        desired_cool = sp.get("desiredCool", cmd.get("desiredCool", None))

        # Clamp to safe bounds
        if desired_heat is not None:
            desired_heat = float(clamp_setpoint(float(desired_heat)))
        if desired_cool is not None:
            desired_cool = float(clamp_setpoint(float(desired_cool)))

        hvac_mode_raw = cmd.get("HVACMode", cmd.get("hvac_mode", None))
        fan_mode_raw = cmd.get("FanMode", cmd.get("fan_mode", None))

        # Write only what is provided
        try:
            if desired_heat is not None:
                for heat_name in HEAT_POINTS:
                    await write_named_point(proxy, points, addr, heat_name, desired_heat, priority)

            if desired_cool is not None:
                for cool_name in COOL_POINTS:
                    await write_named_point(proxy, points, addr, cool_name, desired_cool, priority)

            sys_int = _parse_mode_to_int(hvac_mode_raw, SYSTEM_MODE_MAP)
            if sys_int is not None:
                await write_named_point(proxy, points, addr, sys_name, sys_int, priority)

            fan_int = _parse_mode_to_int(fan_mode_raw, FAN_MODE_MAP)
            if fan_int is not None:
                await write_named_point(proxy, points, addr, fan_name, fan_int, priority)

            results[rid] = {"status": "success"}
        except Exception as e:
            results[rid] = {"status": "error", "message": str(e)}

    return results


# ----------------- Async runner (BACpypes3 is asyncio-based) -----------------
_ASYNC_LOOP: Optional[asyncio.AbstractEventLoop] = None
_ASYNC_THREAD: Optional[threading.Thread] = None
_PROXY: Optional[BACnetProxy] = None


def _ensure_async_runtime() -> Tuple[asyncio.AbstractEventLoop, BACnetProxy]:
    """
    Create a dedicated asyncio loop thread once, and reuse it for all Flask requests.
    This avoids re-creating BACnet sockets per request.
    """
    global _ASYNC_LOOP, _ASYNC_THREAD, _PROXY

    if _ASYNC_LOOP and _PROXY:
        return _ASYNC_LOOP, _PROXY

    _ASYNC_LOOP = asyncio.new_event_loop()

    def _runner():
        asyncio.set_event_loop(_ASYNC_LOOP)
        _ASYNC_LOOP.run_forever()

    _ASYNC_THREAD = threading.Thread(target=_runner, daemon=True)
    _ASYNC_THREAD.start()

    async def _init_proxy():
        return BACnetProxy(LOCAL_ADDRESS)

    _PROXY = asyncio.run_coroutine_threadsafe(_init_proxy(), _ASYNC_LOOP).result(timeout=10)
    return _ASYNC_LOOP, _PROXY


def _run_async(coro, timeout: int = 20):
    loop, _ = _ensure_async_runtime()
    fut = asyncio.run_coroutine_threadsafe(coro, loop)
    return fut.result(timeout=timeout)


# ----------------- Flask API server (Ecobee-like pattern) -----------------
app = Flask(__name__)
api = Api(app)

# Load points once (schneider_topic.csv must be in cwd or pass --csv when launching server)
_POINTS: List[Dict[str, Any]] = []


class building_data(Resource):
    """Interface to get sensor/setpoint/mode information from multiple SE8650 thermostats."""
    def get(self):
        now = strftime("%Y-%m-%d-%H-%M-%S", gmtime())

        if activate_get_point:
            try:
                _, proxy = _ensure_async_runtime()
                data = _run_async(_read_all_thermostats(proxy, _POINTS), timeout=25)
                return {"status": 200, "message": None, "payload": {"output": data, "time": now}}
            except Exception as e:
                return {"status": 500, "message": str(e), "payload": {"output": None, "time": now}}
        else:
            data = _fake_get_all()
            return {"status": 200, "message": None, "payload": {"output": data, "time": now}}


class building_control(Resource):
    """Interface to set setpoints/modes on multiple thermostats in one request."""
    def put(self):
        now = strftime("%Y-%m-%d-%H-%M-%S", gmtime())
        try:
            print("request: ", request)
            inputs = request.get_json(force=True, silent=False)

            if isinstance(inputs, str):
                inputs = json.loads(inputs)

            if not isinstance(inputs, dict):
                raise ValueError("Input JSON must be an object like {<zone_id>: {...}, ...}")

            print("inputs from client: ", inputs)
        except Exception:
            return {"status": 400, "message": "Unexpected Input", "payload": {"output": None, "time": now}}

        if activate_set_point:
            try:
                _, proxy = _ensure_async_runtime()
                results = _run_async(_apply_setpoints_to_thermostats(proxy, _POINTS, inputs, PRIORITY), timeout=40)
                print(f"{now}: Set thermostat results:\n{json.dumps(results, indent=2)}")
                return {"status": 200, "message": None, "payload": {"output": results, "time": now}}
            except Exception as e:
                return {"status": 500, "message": str(e), "payload": {"output": None, "time": now}}
        else:
            # Do NOT write to thermostats; update the fake state instead
            _fake_apply_inputs(inputs)
            return {"status": 200, "message": None, "payload": {"output": {"status": "success"}, "time": now}}


class health(Resource):
    def get(self):
        ts_local = datetime.now().astimezone().isoformat()
        return {"status": 200, "message": None, "payload": {"time": ts_local}}


api.add_resource(building_data, "/get_point")
api.add_resource(building_control, "/set_point")
api.add_resource(health, "/ping")


# ----------------- CLI (kept) -----------------
async def read_all_once(proxy: BACnetProxy, points: List[Dict[str, Any]], device_address: str) -> Dict[str, Any]:
    results: Dict[str, Any] = {}
    for p in points:
        val = await proxy.read(device_address, oid(p), p["property"])
        results[p["name"]] = val
        print(f"{p['name']}: {val}")
    return results


async def main_cli():
    parser = argparse.ArgumentParser(description="SE8650 BACnet read/write + Flask API server")
    parser.add_argument("--csv", default=TOPIC_CSV, help="CSV file listing BACnet points")
    parser.add_argument("--devices-csv", default=DEVICES_CSV, help="CSV file listing thermostats/devices")
    parser.add_argument("--read", action="store_true", help="Read all points once (CLI mode)")
    parser.add_argument("--set", nargs=2, action="append", metavar=("POINT_NAME", "VALUE"),
                        help="Write a numeric value to a point by name (e.g., --set occupied_heat_setpoint 72)")
    parser.add_argument("--system-mode", choices=list(SYSTEM_MODE_MAP.keys()),
                        help="Convenience: set System Mode (off/auto/cool/heat)")
    parser.add_argument("--fan-mode", choices=list(FAN_MODE_MAP.keys()),
                        help="Convenience: set Fan Mode (on/auto/smart)")
    parser.add_argument("--priority", type=int, default=PRIORITY, help="BACnet write priority (default: 8)")
    parser.add_argument("--json", action="store_true", help="Print readback as JSON too")
    parser.add_argument("--skip-verify-device", action="store_true",
                        help="Skip reading device:<instance> objectName before point operations")
    parser.add_argument("--device-address", default=DEFAULT_DEVICE_ADDRESS, help="Target thermostat BACnet address")
    parser.add_argument("--device-instance", type=int, default=DEFAULT_DEVICE_INSTANCE, help="Target thermostat device instance")

    # Server options
    parser.add_argument("--server", action="store_true", help="Run Flask API server instead of CLI")
    parser.add_argument("--host", default="0.0.0.0", help="Server host (server mode)")
    parser.add_argument("--port", type=int, default=5004, help="Server port (server mode)")
    parser.add_argument("--activate-get-point", action="store_true", help="Enable real BACnet reads in /get_point")
    parser.add_argument("--activate-set-point", action="store_true", help="Enable real BACnet writes in /set_point")

    args = parser.parse_args()

    global activate_get_point, activate_set_point, _POINTS, THERMOSTATS
    activate_get_point = bool(args.activate_get_point)
    activate_set_point = bool(args.activate_set_point)
    _POINTS = load_points(args.csv)

    try:
        THERMOSTATS = load_devices(args.devices_csv)
    except Exception as e:
        print(f"[WARN] Could not load devices from {args.devices_csv}: {e}")
        print("[WARN] Falling back to default THERMOSTATS list embedded in the script.")

    if args.server:
            # Ensure fake state exists even if get_point isn't active
            _ensure_fake_state()

            print("[INFO] THERMOSTATS config:")
            print(json.dumps(THERMOSTATS, indent=2))

            # One-time provisioning: set Dual Setpoint mode on all thermostats
            if activate_set_point:
                        sp_func = try_find_point(_POINTS, "setpoint_function")
                        if sp_func:
                            _, proxy = _ensure_async_runtime()
                            for t in THERMOSTATS:
                                addr = str(t["device_address"])
                                try:
                                    _run_async(write_named_point(proxy, _POINTS, addr, "setpoint_function", 1, 1), timeout=10)
                                    print(f"[PROVISION] {t['zone_id']} ({addr}): setpoint_function=1 (Dual SP) at priority 1")
                                except Exception as e:
                                    print(f"[PROVISION] {t['zone_id']} ({addr}): FAILED to set setpoint_function: {e}")
                        else:
                            print("[WARN] 'setpoint_function' not found in topic CSV, skipping provisioning")

            print(f"[INFO] activate_get_point={activate_get_point}, activate_set_point={activate_set_point}")
            print(f"[INFO] Starting API server on http://{args.host}:{args.port}")
            app.run(host=args.host, port=args.port, debug=False, threaded=True)
            return

    # ---- CLI mode (backward compatible) ----
    points = _POINTS
    proxy = BACnetProxy(LOCAL_ADDRESS)

    if not args.skip_verify_device:
        await verify_target_device(proxy, args.device_address, args.device_instance)

    did_write = False

    if args.system_mode:
        await write_named_point(proxy, points, args.device_address, "system_mode", SYSTEM_MODE_MAP[args.system_mode], args.priority)
        did_write = True

    if args.fan_mode:
        await write_named_point(proxy, points, args.device_address, "fan_mode", FAN_MODE_MAP[args.fan_mode], args.priority)
        did_write = True

    if args.set:
        for point_name, val in args.set:
            await write_named_point(proxy, points, args.device_address, point_name, val, args.priority)
        did_write = True

    if args.read or not did_write:
        results = await read_all_once(proxy, points, args.device_address)
        if args.json:
            print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    asyncio.run(main_cli())
