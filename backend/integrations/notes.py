import asyncio
import time
from backend.core.state import push_update

_notes: list[dict] = []
_next_id = 1


def _sync_state():
    asyncio.create_task(push_update("notes", {"items": list(_notes)}))


def get_all() -> list[dict]:
    return list(_notes)


def add(text: str) -> dict:
    global _next_id
    note = {"id": _next_id, "text": text, "ts": int(time.time())}
    _next_id += 1
    _notes.insert(0, note)
    _sync_state()
    return note


def delete(note_id: int) -> bool:
    global _notes
    before = len(_notes)
    _notes = [n for n in _notes if n["id"] != note_id]
    if len(_notes) != before:
        _sync_state()
        return True
    return False


def clear_all():
    global _notes
    _notes = []
    _sync_state()
