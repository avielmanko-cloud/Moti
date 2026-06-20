import asyncio
import logging
from typing import Optional
from backend.core.config import settings
from backend.core.state import push_update, state

log = logging.getLogger("moti.xiaomi")

try:
    from miio import Yeelight
    MIIO_AVAILABLE = True
except ImportError:
    MIIO_AVAILABLE = False
    log.warning("python-miio not installed — Xiaomi lights disabled")

# Store config separately from device objects so we can recreate them on demand
_light_configs: list[tuple[str, str, str]] = []  # (dev_id, ip, token)
_bulbs: dict[str, object] = {}


def _make_bulb(ip: str, token: str) -> Optional[object]:
    """Create a Yeelight device object without triggering network discovery."""
    try:
        # lazy_discover=True (default) skips the UDP broadcast discovery.
        # On Windows, the broadcast socket gets WinError 10054 (ICMP port unreachable)
        # which python-miio can mishandle — we also pass model to skip model detection.
        bulb = Yeelight(ip, token, lazy_discover=True, model="yeelink.light.color1")
        return bulb
    except Exception:
        # Fallback: try without model hint
        try:
            return Yeelight(ip, token, lazy_discover=True)
        except Exception as e:
            log.debug("Yeelight init error for %s: %s", ip, e)
            return None


def init():
    global _light_configs, _bulbs
    _light_configs = []
    _bulbs = {}

    if not MIIO_AVAILABLE:
        return

    pairs = [
        ("light_1", settings.XIAOMI_LIGHT_IP,   settings.XIAOMI_LIGHT_TOKEN),
        ("light_2", settings.XIAOMI_LIGHT_2_IP,  settings.XIAOMI_LIGHT_2_TOKEN),
    ]
    for dev_id, ip, token in pairs:
        if not ip or not token:
            continue
        _light_configs.append((dev_id, ip, token))
        bulb = _make_bulb(ip, token)
        if bulb:
            _bulbs[dev_id] = bulb
        # Register in state even if device is currently unreachable
        if dev_id not in state["lights"]:
            state["lights"][dev_id] = {
                "name": dev_id.replace("_", " ").title(),
                "on": False,
                "brightness": 100,
                "color_temp": 4000,
                "color": "#ffffff",
                "reachable": False,
            }

    log.info("Xiaomi: %d light(s) configured (%d object(s) created)",
             len(_light_configs), len(_bulbs))


def _get_bulb(dev_id: str) -> Optional[object]:
    """Return cached bulb or recreate it if missing."""
    if dev_id in _bulbs:
        return _bulbs[dev_id]
    for d, ip, token in _light_configs:
        if d == dev_id:
            bulb = _make_bulb(ip, token)
            if bulb:
                _bulbs[dev_id] = bulb
            return bulb
    return None


async def refresh_all():
    for dev_id, ip, token in _light_configs:
        bulb = _get_bulb(dev_id)
        if not bulb:
            continue
        try:
            info = await asyncio.get_event_loop().run_in_executor(None, bulb.status)
            cur = state["lights"].get(dev_id, {})
            await push_update("lights", {
                dev_id: {
                    **cur,
                    "on": info.is_on,
                    "brightness": info.brightness or 100,
                    "color_temp": info.color_temp or 4000,
                    "reachable": True,
                }
            })
        except Exception as e:
            log.debug("Light %s unreachable: %s", dev_id, e)
            cur = state["lights"].get(dev_id, {})
            await push_update("lights", {dev_id: {**cur, "reachable": False}})


async def set_power(dev_id: str, on: bool):
    bulb = _get_bulb(dev_id)
    if not bulb:
        return await _mock_update(dev_id, {"on": on})
    fn = bulb.on if on else bulb.off
    try:
        await asyncio.get_event_loop().run_in_executor(None, fn)
    except Exception as e:
        log.error("set_power %s error: %s", dev_id, e)
    cur = state["lights"].get(dev_id, {})
    await push_update("lights", {dev_id: {**cur, "on": on}})


async def set_brightness(dev_id: str, value: int):
    bulb = _get_bulb(dev_id)
    value = max(1, min(100, value))
    if not bulb:
        return await _mock_update(dev_id, {"brightness": value})
    try:
        await asyncio.get_event_loop().run_in_executor(None, bulb.set_brightness, value)
    except Exception as e:
        log.error("set_brightness %s error: %s", dev_id, e)
    cur = state["lights"].get(dev_id, {})
    await push_update("lights", {dev_id: {**cur, "brightness": value}})


async def set_color_temp(dev_id: str, kelvin: int):
    bulb = _get_bulb(dev_id)
    kelvin = max(1700, min(6500, kelvin))
    if not bulb:
        return await _mock_update(dev_id, {"color_temp": kelvin})
    try:
        await asyncio.get_event_loop().run_in_executor(None, bulb.set_color_temp, kelvin)
    except Exception as e:
        log.error("set_color_temp %s error: %s", dev_id, e)
    cur = state["lights"].get(dev_id, {})
    await push_update("lights", {dev_id: {**cur, "color_temp": kelvin}})


async def _mock_update(dev_id: str, patch: dict):
    cur = state["lights"].get(dev_id, {
        "name": dev_id, "on": False, "brightness": 100,
        "color_temp": 4000, "reachable": False,
    })
    await push_update("lights", {dev_id: {**cur, **patch}})
