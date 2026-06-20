import asyncio
import logging
from typing import Optional
from backend.core.config import settings
from backend.core.state import push_update

log = logging.getLogger("moti.whatsapp")

try:
    from twilio.rest import Client as TwilioClient
    TWILIO_AVAILABLE = True
except ImportError:
    TWILIO_AVAILABLE = False

_client: Optional[object] = None
_messages: list[dict] = []


def init():
    global _client
    if not TWILIO_AVAILABLE:
        log.warning("twilio not installed — WhatsApp disabled")
        return
    if settings.TWILIO_ACCOUNT_SID and settings.TWILIO_AUTH_TOKEN:
        _client = TwilioClient(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)
        log.info("WhatsApp (Twilio) initialized")


async def send_message(to: str, body: str) -> bool:
    if not _client:
        log.warning("WhatsApp not configured")
        return False
    to_number = f"whatsapp:{to}" if not to.startswith("whatsapp:") else to
    try:
        await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: _client.messages.create(
                body=body,
                from_=settings.TWILIO_WHATSAPP_FROM,
                to=to_number,
            ),
        )
        _messages.append({"to": to, "body": body, "direction": "out"})
        await push_update("whatsapp", {"connected": True, "last_message": {"body": body, "to": to}})
        return True
    except Exception as e:
        log.error("WhatsApp send error: %s", e)
        return False


def ingest_incoming(from_: str, body: str):
    _messages.append({"from": from_, "body": body, "direction": "in"})
    asyncio.create_task(push_update("whatsapp", {
        "connected": True,
        "unread": len([m for m in _messages if m["direction"] == "in"]),
        "last_message": {"body": body, "from": from_},
    }))


def get_messages() -> list[dict]:
    return list(_messages)
