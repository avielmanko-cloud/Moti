from typing import Any
import asyncio

state: dict[str, Any] = {
    "lights": {},
    "spotify": {
        "connected": False,
        "playing": False,
        "track": None,
        "artist": None,
        "album_art": None,
        "volume": 50,
        "progress_ms": 0,
        "duration_ms": 0,
        "shuffle": False,
        "repeat": "off",
    },
    "pc": {
        "cpu": 0,
        "ram": 0,
        "disk": 0,
        "net_sent": 0,
        "net_recv": 0,
    },
    "notes": {
        "items": [],
    },
    "system": {
        "cpu": 0,
        "ram": 0,
        "time": "",
    },
}

broadcast_queue: asyncio.Queue = asyncio.Queue()


async def push_update(topic: str, data: dict):
    if topic in state:
        state[topic].update(data)
    await broadcast_queue.put({"topic": topic, "data": state.get(topic, data)})
