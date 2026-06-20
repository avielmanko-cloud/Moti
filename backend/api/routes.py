from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from backend.core.state import state
from backend.integrations import xiaomi, spotify, notes

router = APIRouter()


# ── Lights ───────────────────────────────────────────────────────────────────

class LightPowerBody(BaseModel):
    on: bool

class LightBrightnessBody(BaseModel):
    value: int

class LightColorTempBody(BaseModel):
    kelvin: int


@router.get("/lights")
async def get_lights():
    return state["lights"]

@router.post("/lights/{dev_id}/power")
async def light_power(dev_id: str, body: LightPowerBody):
    await xiaomi.set_power(dev_id, body.on)
    return {"ok": True}

@router.post("/lights/{dev_id}/brightness")
async def light_brightness(dev_id: str, body: LightBrightnessBody):
    await xiaomi.set_brightness(dev_id, body.value)
    return {"ok": True}

@router.post("/lights/{dev_id}/color_temp")
async def light_color_temp(dev_id: str, body: LightColorTempBody):
    await xiaomi.set_color_temp(dev_id, body.kelvin)
    return {"ok": True}


# ── Spotify ───────────────────────────────────────────────────────────────────

@router.get("/spotify")
async def get_spotify():
    return state["spotify"]

@router.post("/spotify/auth")
async def spotify_auth():
    url = spotify.get_auth_url()
    if not url:
        raise HTTPException(400, "Spotify not configured — set SPOTIFY_CLIENT_ID in .env")
    return {"auth_url": url}

@router.get("/callback/spotify")
async def spotify_callback(code: str):
    ok = spotify.handle_callback(code)
    if ok:
        return RedirectResponse("/?spotify=connected")
    raise HTTPException(400, "Spotify auth failed")

@router.post("/spotify/play_pause")
async def spotify_play_pause():
    await spotify.play_pause(); return {"ok": True}

@router.post("/spotify/next")
async def spotify_next():
    await spotify.next_track(); return {"ok": True}

@router.post("/spotify/prev")
async def spotify_prev():
    await spotify.prev_track(); return {"ok": True}

@router.post("/spotify/volume/{vol}")
async def spotify_volume(vol: int):
    await spotify.set_volume(vol); return {"ok": True}

@router.post("/spotify/shuffle")
async def spotify_shuffle():
    await spotify.toggle_shuffle(); return {"ok": True}

@router.post("/spotify/repeat/{mode}")
async def spotify_repeat(mode: str):
    await spotify.set_repeat(mode); return {"ok": True}


# ── PC Stats ─────────────────────────────────────────────────────────────────

@router.get("/pc")
async def get_pc():
    return state["pc"]


# ── Notes ─────────────────────────────────────────────────────────────────────

class NoteBody(BaseModel):
    text: str

@router.get("/notes")
async def get_notes():
    return notes.get_all()

@router.post("/notes")
async def add_note(body: NoteBody):
    if not body.text.strip():
        raise HTTPException(400, "Note cannot be empty")
    return notes.add(body.text.strip())

@router.delete("/notes/{note_id}")
async def delete_note(note_id: int):
    ok = notes.delete(note_id)
    return {"ok": ok}

@router.delete("/notes")
async def clear_notes():
    notes.clear_all()
    return {"ok": True}


# ── Full state ────────────────────────────────────────────────────────────────

@router.get("/state")
async def full_state():
    return state
