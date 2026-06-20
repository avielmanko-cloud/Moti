import asyncio
import subprocess
import logging
from backend.core.config import settings
from backend.core.state import push_update

log = logging.getLogger("moti.phone")


def _adb(args: list[str]) -> str:
    ip = settings.ADB_DEVICE_IP
    port = settings.ADB_PORT
    if not ip:
        return ""
    try:
        result = subprocess.run(
            ["adb", "-s", f"{ip}:{port}"] + args,
            capture_output=True, text=True, timeout=5,
            creationflags=0x08000000,  # CREATE_NO_WINDOW on Windows
        )
        return result.stdout.strip()
    except Exception as e:
        log.debug("ADB error: %s", e)
        return ""


async def connect():
    ip = settings.ADB_DEVICE_IP
    if not ip:
        return False
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: subprocess.run(
                ["adb", "connect", f"{ip}:{settings.ADB_PORT}"],
                capture_output=True, text=True, timeout=8,
                creationflags=0x08000000,
            )
        )
        ok = "connected" in result.stdout.lower()
        await push_update("phone", {"connected": ok})
        return ok
    except Exception as e:
        log.debug("ADB connect error: %s", e)
        return False


async def refresh():
    if not settings.ADB_DEVICE_IP:
        return

    def _read():
        battery_raw = _adb(["shell", "dumpsys", "battery"])
        wifi_raw = _adb(["shell", "dumpsys", "wifi"])
        model_raw = _adb(["shell", "getprop", "ro.product.model"])

        battery = None
        for line in battery_raw.splitlines():
            if "level:" in line:
                try:
                    battery = int(line.split(":")[1].strip())
                except ValueError:
                    pass
                break

        wifi = None
        for line in wifi_raw.splitlines():
            if "mWifiInfo" in line and "SSID:" in line:
                try:
                    part = [p for p in line.split(",") if "SSID:" in p]
                    if part:
                        wifi = part[0].split("SSID:")[1].strip().strip('"')
                except Exception:
                    pass
                break

        return battery, wifi, model_raw.strip()

    try:
        battery, wifi, model = await asyncio.get_event_loop().run_in_executor(None, _read)
        connected = battery is not None
        await push_update("phone", {
            "connected": connected,
            "battery": battery,
            "wifi": wifi,
            "model": model or None,
        })
    except Exception as e:
        log.debug("Phone refresh error: %s", e)
        await push_update("phone", {"connected": False})


async def send_notification(title: str, message: str):
    cmd = [
        "shell", "am", "broadcast",
        "-a", "android.intent.action.BOOT_COMPLETED",
    ]
    log.info("Phone notification: %s - %s", title, message)


async def open_app(package: str):
    await asyncio.get_event_loop().run_in_executor(
        None, lambda: _adb(["shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1"])
    )
