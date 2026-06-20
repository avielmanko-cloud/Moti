import asyncio
import logging
import colorlog
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from fastapi.websockets import WebSocket

from backend.core.config import settings
from backend.core.state import state
from backend.core.scheduler import start as start_scheduler
from backend.api.routes import router
from backend.api.websocket import ws_endpoint, broadcaster
from backend.integrations import xiaomi, whatsapp

# ── Logging ───────────────────────────────────────────────────────────────────
handler = colorlog.StreamHandler()
handler.setFormatter(colorlog.ColoredFormatter(
    "%(log_color)s%(levelname)-8s%(reset)s %(blue)s%(name)s%(reset)s — %(message)s"
))
logging.basicConfig(level=logging.INFO, handlers=[handler])
log = logging.getLogger("moti")

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Moti", version="1.0.0")

BASE = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE / "frontend" / "static"), name="static")
templates = Jinja2Templates(directory=str(BASE / "frontend" / "templates"))

app.include_router(router, prefix="/api")


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@app.websocket("/ws")
async def websocket_route(ws: WebSocket):
    await ws_endpoint(ws)


@app.on_event("startup")
async def startup():
    log.info("Moti starting up…")
    xiaomi.init()
    whatsapp.init()
    asyncio.create_task(broadcaster())
    await start_scheduler()
    log.info("Moti ready at http://%s:%d", settings.HOST, settings.PORT)
