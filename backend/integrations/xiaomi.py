import asyncio
import logging
from typing import Optional
from backend.core.config import settings
from backend.core.state import push_update, state

log = logging.getLogger("moti.xiaomi")

try:
    from yeelight import Bulb, BulbException
    YEELIGHT_AVAILABLE = True
except ImportError:
    YEELIGHT_AVAILABLE = False
    log.warning("yeelight not installed — run: pip install yeelight")

# (dev_id, ip, friendly_name)
_light_configs: list[tuple[str, str, str]] = []


def init():
    global _light_configs
    _light_configs = []
    if not YEELIGHT_AVAILABLE:
        return

    pairs = [
        ("light_1", settings.XIAOMI_LIGHT_IP,  "Light 1"),
        ("light_2", settings.XIAOMI_LIGHT_2_IP, "Light 2"),
    ]
    for dev_id, ip, name in pairs:
        if not ip:
            continue
        _light_configs.append((dev_id, ip, name))
        if dev_id not in state["lights"]:
            state["lights"][dev_id] = {
                "name": name,
                "on": False,
                "brightness": 100,
                "color_temp": 4000,
                "color": "#ffffff",
                "reachable": False,
            }

    log.info("Xiaomi: %d light(s) configured (yeelight LAN)", len(_light_configs))


def _bulb(ip: str) -> "Bulb":
    # auto_on=False → don't automatically power on when sending commands
    return Bulb(ip, auto_on=False)


async def refresh_all():
    for dev_id, ip, name in _light_configs:
        try:
            props = await asyncio.get_event_loop().run_in_executor(
                None, lambda b=ip: _bulb(b).get_properties(
                    ["power", "bright", "ct", "color_mode", "rgb"]
                )
            )
            on = props.get("power") == "on"
            brightness = int(props.get("bright") or 100)
            color_temp = int(props.get("ct") or 4000)
            cur = state["lights"].get(dev_id, {})
            await push_update("lights", {
                dev_id: {**cur, "on": on, "brightness": brightness,
                          "color_temp": color_temp, "reachable": True}
            })
        except Exception as e:
            log.debug("Light %s unreachable: %s", dev_id, e)
            cur = state["lights"].get(dev_id, {})
            await push_update("lights", {dev_id: {**cur, "reachable": False}})


async def set_power(dev_id: str, on: bool):
    ip = _ip(dev_id)
    cur = state["lights"].get(dev_id, {})
    if ip:
        try:
            fn = (lambda: _bulb(ip).turn_on()) if on else (lambda: _bulb(ip).turn_off())
            await asyncio.get_event_loop().run_in_executor(None, fn)
        except Exception as e:
            log.error("set_power %s: %s", dev_id, e)
    await push_update("lights", {dev_id: {**cur, "on": on}})


async def set_brightness(dev_id: str, value: int):
    ip = _ip(dev_id)
    value = max(1, min(100, value))
    cur = state["lights"].get(dev_id, {})
    if ip:
        try:
            await asyncio.get_event_loop().run_in_executor(
                None, lambda: _bulb(ip).set_brightness(value)
            )
        except Exception as e:
            log.error("set_brightness %s: %s", dev_id, e)
    await push_update("lights", {dev_id: {**cur, "brightness": value}})


async def set_color_temp(dev_id: str, kelvin: int):
    ip = _ip(dev_id)
    kelvin = max(1700, min(6500, kelvin))
    cur = state["lights"].get(dev_id, {})
    if ip:
        try:
            await asyncio.get_event_loop().run_in_executor(
                None, lambda: _bulb(ip).set_color_temp(kelvin)
            )
        except Exception as e:
            log.error("set_color_temp %s: %s", dev_id, e)
    await push_update("lights", {dev_id: {**cur, "color_temp": kelvin}})


def _ip(dev_id: str) -> Optional[str]:
    for d, ip, _ in _light_configs:
        if d == dev_id:
            return ip
    return None
