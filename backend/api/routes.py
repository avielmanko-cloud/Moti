from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional
from backend.core.state import state
from backend.integrations import xiaomi, spotify, phone, whatsapp

router = APIRouter()


# ── Lights ──────────────────────────────────────────────────────────────────

class LightPowerBody(BaseModel):
    on: bool

class LightBrightnessBody(BaseModel):
    value: int

class LightColorTempBody(BaseModel):
    kelvin: int


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


@router.get("/lights")
async def get_lights():
    return state["lights"]


# ── Spotify ──────────────────────────────────────────────────────────────────

@router.get("/spotify")
async def get_spotify():
    return state["spotify"]


@router.post("/spotify/auth")
async def spotify_auth():
    url = spotify.get_auth_url()
    if not url:
        raise HTTPException(400, "Spotify not configured")
    return {"auth_url": url}


@router.get("/callback/spotify")
async def spotify_callback(code: str):
    ok = spotify.handle_callback(code)
    if ok:
        return RedirectResponse("/?spotify=connected")
    raise HTTPException(400, "Spotify auth failed")


@router.post("/spotify/play_pause")
async def spotify_play_pause():
    await spotify.play_pause()
    return {"ok": True}


@router.post("/spotify/next")
async def spotify_next():
    await spotify.next_track()
    return {"ok": True}


@router.post("/spotify/prev")
async def spotify_prev():
    await spotify.prev_track()
    return {"ok": True}


@router.post("/spotify/volume/{vol}")
async def spotify_volume(vol: int):
    await spotify.set_volume(vol)
    return {"ok": True}


@router.post("/spotify/shuffle")
async def spotify_shuffle():
    await spotify.toggle_shuffle()
    return {"ok": True}


@router.post("/spotify/repeat/{mode}")
async def spotify_repeat(mode: str):
    await spotify.set_repeat(mode)
    return {"ok": True}


# ── Phone ────────────────────────────────────────────────────────────────────

@router.get("/phone")
async def get_phone():
    return state["phone"]


@router.post("/phone/connect")
async def phone_connect():
    ok = await phone.connect()
    return {"ok": ok}


# ── WhatsApp ─────────────────────────────────────────────────────────────────

class WAMessageBody(BaseModel):
    to: str
    message: str


@router.get("/whatsapp")
async def get_whatsapp():
    return state["whatsapp"]


@router.post("/whatsapp/send")
async def wa_send(body: WAMessageBody):
    ok = await whatsapp.send_message(body.to, body.message)
    return {"ok": ok}


@router.get("/whatsapp/messages")
async def wa_messages():
    return whatsapp.get_messages()


@router.post("/whatsapp/webhook")
async def wa_webhook(request: Request):
    form = await request.form()
    from_ = form.get("From", "")
    body = form.get("Body", "")
    whatsapp.ingest_incoming(from_, body)
    return JSONResponse({"ok": True})


# ── Full state snapshot ───────────────────────────────────────────────────────

@router.get("/state")
async def full_state():
    return state
