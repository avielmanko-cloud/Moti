import asyncio
import logging
import psutil
from datetime import datetime
from backend.core.state import push_update
from backend.integrations import xiaomi, spotify

log = logging.getLogger("moti.scheduler")

SPOTIFY_INTERVAL = 5
XIAOMI_INTERVAL  = 15
PC_INTERVAL      = 3
_net_last = None


async def _loop(coro_fn, interval: float, name: str):
    while True:
        try:
            await coro_fn()
        except Exception as e:
            log.debug("%s tick error: %s", name, e)
        await asyncio.sleep(interval)


async def _pc_tick():
    global _net_last
    try:
        cpu  = psutil.cpu_percent(interval=None)
        ram  = psutil.virtual_memory().percent
        disk = psutil.disk_usage("/").percent
        net  = psutil.net_io_counters()
        sent = recv = 0
        if _net_last:
            sent = max(0, net.bytes_sent - _net_last.bytes_sent)
            recv = max(0, net.bytes_recv - _net_last.bytes_recv)
        _net_last = net
        now = datetime.now().strftime("%H:%M:%S")
        await push_update("system", {"cpu": cpu, "ram": ram, "time": now})
        await push_update("pc", {
            "cpu": cpu, "ram": ram, "disk": disk,
            "net_sent": sent // 1024,
            "net_recv": recv // 1024,
        })
    except Exception as e:
        log.debug("PC tick error: %s", e)


async def start():
    asyncio.create_task(_loop(spotify.refresh, SPOTIFY_INTERVAL, "spotify"))
    asyncio.create_task(_loop(xiaomi.refresh_all, XIAOMI_INTERVAL, "xiaomi"))
    asyncio.create_task(_loop(_pc_tick, PC_INTERVAL, "pc"))
    log.info("Scheduler started")
