from typing import Any
import asyncio

# Global runtime state — single source of truth for the UI
state: dict[str, Any] = {
    "lights": {},        # device_id -> {on, brightness, color, name}
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
    "phone": {
        "connected": False,
        "battery": None,
        "wifi": None,
        "model": None,
    },
    "whatsapp": {
        "connected": False,
        "unread": 0,
        "last_message": None,
    },
    "system": {
        "cpu": 0,
        "ram": 0,
        "time": "",
    },
}

# WebSocket broadcast queue
broadcast_queue: asyncio.Queue = asyncio.Queue()


async def push_update(topic: str, data: dict):
    state[topic].update(data)
    await broadcast_queue.put({"topic": topic, "data": state[topic]})
