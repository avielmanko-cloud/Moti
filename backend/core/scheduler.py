import asyncio
import logging
import psutil
from datetime import datetime
from backend.core.state import push_update
from backend.integrations import xiaomi, spotify, phone

log = logging.getLogger("moti.scheduler")

SPOTIFY_INTERVAL = 5    # seconds
XIAOMI_INTERVAL = 30
PHONE_INTERVAL = 20
SYSTEM_INTERVAL = 3


async def _loop(coro_fn, interval: float, name: str):
    while True:
        try:
            await coro_fn()
        except Exception as e:
            log.debug("%s tick error: %s", name, e)
        await asyncio.sleep(interval)


async def _system_tick():
    try:
        cpu = psutil.cpu_percent(interval=None)
        ram = psutil.virtual_memory().percent
        now = datetime.now().strftime("%H:%M:%S")
        await push_update("system", {"cpu": cpu, "ram": ram, "time": now})
    except Exception:
        pass


async def start():
    asyncio.create_task(_loop(spotify.refresh, SPOTIFY_INTERVAL, "spotify"))
    asyncio.create_task(_loop(xiaomi.refresh_all, XIAOMI_INTERVAL, "xiaomi"))
    asyncio.create_task(_loop(phone.refresh, PHONE_INTERVAL, "phone"))
    asyncio.create_task(_loop(_system_tick, SYSTEM_INTERVAL, "system"))
    log.info("Scheduler started")
