import asyncio
import json
import logging
from fastapi import WebSocket, WebSocketDisconnect
from backend.core.state import broadcast_queue, state

log = logging.getLogger("moti.ws")

_connections: set[WebSocket] = set()


async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    _connections.add(ws)
    try:
        # Send full state on connect
        await ws.send_json({"topic": "full_state", "data": state})

        while True:
            try:
                await asyncio.wait_for(ws.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                await ws.send_json({"topic": "ping"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.debug("WS error: %s", e)
    finally:
        _connections.discard(ws)


async def broadcaster():
    """Drains the broadcast queue and fans out to all WebSocket connections."""
    while True:
        message = await broadcast_queue.get()
        if not _connections:
            continue
        dead = set()
        payload = json.dumps(message)
        for ws in list(_connections):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.add(ws)
        _connections.difference_update(dead)
