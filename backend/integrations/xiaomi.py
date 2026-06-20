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


def _get_bulbs() -> list[tuple[str, object]]:
    if not MIIO_AVAILABLE:
        return []
    bulbs = []
    if settings.XIAOMI_LIGHT_IP and settings.XIAOMI_LIGHT_TOKEN:
        try:
            b = Yeelight(settings.XIAOMI_LIGHT_IP, settings.XIAOMI_LIGHT_TOKEN)
            bulbs.append(("light_1", b))
        except Exception as e:
            log.error("Light 1 init error: %s", e)
    if settings.XIAOMI_LIGHT_2_IP and settings.XIAOMI_LIGHT_2_TOKEN:
        try:
            b = Yeelight(settings.XIAOMI_LIGHT_2_IP, settings.XIAOMI_LIGHT_2_TOKEN)
            bulbs.append(("light_2", b))
        except Exception as e:
            log.error("Light 2 init error: %s", e)
    return bulbs


_bulbs: list[tuple[str, object]] = []


def init():
    global _bulbs
    _bulbs = _get_bulbs()
    for dev_id, _ in _bulbs:
        if dev_id not in state["lights"]:
            state["lights"][dev_id] = {
                "name": dev_id.replace("_", " ").title(),
                "on": False,
                "brightness": 100,
                "color_temp": 4000,
                "color": "#ffffff",
                "reachable": False,
            }
    log.info("Xiaomi: %d light(s) configured", len(_bulbs))


async def refresh_all():
    for dev_id, bulb in _bulbs:
        try:
            info = await asyncio.get_event_loop().run_in_executor(None, bulb.status)
            await push_update("lights", {
                dev_id: {
                    **state["lights"].get(dev_id, {}),
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
    bulb = _find(dev_id)
    if not bulb:
        return _mock_update(dev_id, {"on": on})
    fn = bulb.on if on else bulb.off
    await asyncio.get_event_loop().run_in_executor(None, fn)
    cur = state["lights"].get(dev_id, {})
    await push_update("lights", {dev_id: {**cur, "on": on}})


async def set_brightness(dev_id: str, value: int):
    bulb = _find(dev_id)
    value = max(1, min(100, value))
    if not bulb:
        return _mock_update(dev_id, {"brightness": value})
    await asyncio.get_event_loop().run_in_executor(None, bulb.set_brightness, value)
    cur = state["lights"].get(dev_id, {})
    await push_update("lights", {dev_id: {**cur, "brightness": value}})


async def set_color_temp(dev_id: str, kelvin: int):
    bulb = _find(dev_id)
    kelvin = max(1700, min(6500, kelvin))
    if not bulb:
        return _mock_update(dev_id, {"color_temp": kelvin})
    await asyncio.get_event_loop().run_in_executor(None, bulb.set_color_temp, kelvin)
    cur = state["lights"].get(dev_id, {})
    await push_update("lights", {dev_id: {**cur, "color_temp": kelvin}})


def _find(dev_id: str) -> Optional[object]:
    for d, b in _bulbs:
        if d == dev_id:
            return b
    return None


async def _mock_update(dev_id: str, patch: dict):
    cur = state["lights"].get(dev_id, {"name": dev_id, "on": False, "brightness": 100, "color_temp": 4000, "reachable": False})
    await push_update("lights", {dev_id: {**cur, **patch}})
