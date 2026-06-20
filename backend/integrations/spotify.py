import asyncio
import logging
import os
from typing import Optional
from backend.core.config import settings
from backend.core.state import push_update

log = logging.getLogger("moti.spotify")

try:
    import spotipy
    from spotipy.oauth2 import SpotifyOAuth
    SPOTIPY_AVAILABLE = True
except ImportError:
    SPOTIPY_AVAILABLE = False

_sp: Optional[object] = None
_auth_manager = None
CACHE_PATH = ".spotify_cache"
SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing"


def _make_auth_manager() -> "SpotifyOAuth":
    return SpotifyOAuth(
        client_id=settings.SPOTIFY_CLIENT_ID,
        client_secret=settings.SPOTIFY_CLIENT_SECRET,
        redirect_uri=settings.SPOTIFY_REDIRECT_URI,
        scope=SCOPE,
        cache_path=CACHE_PATH,
        open_browser=False,
    )


def get_auth_url() -> Optional[str]:
    if not SPOTIPY_AVAILABLE or not settings.SPOTIFY_CLIENT_ID:
        return None
    global _auth_manager
    _auth_manager = _make_auth_manager()
    return _auth_manager.get_authorize_url()


def handle_callback(code: str) -> bool:
    global _sp, _auth_manager
    if not _auth_manager:
        _auth_manager = _make_auth_manager()
    try:
        token = _auth_manager.get_access_token(code, as_dict=False)
        if token:
            _sp = spotipy.Spotify(auth_manager=_auth_manager)
            log.info("Spotify authenticated successfully")
            return True
    except Exception as e:
        log.error("Spotify callback error: %s", e)
    return False


def _ensure_client() -> bool:
    """Return True only if we have a valid, cached Spotify session.
    Never triggers interactive auth — that requires an explicit /api/spotify/auth call."""
    global _sp, _auth_manager
    if _sp:
        return True
    if not SPOTIPY_AVAILABLE or not settings.SPOTIFY_CLIENT_ID:
        return False
    # Only auto-restore from cache; don't prompt for a new auth flow here
    if not os.path.exists(CACHE_PATH):
        return False
    try:
        _auth_manager = _make_auth_manager()
        token_info = _auth_manager.get_cached_token()
        if not token_info:
            return False
        _sp = spotipy.Spotify(auth_manager=_auth_manager)
        log.info("Spotify restored from cache")
        return True
    except Exception as e:
        log.debug("Spotify cache restore failed: %s", e)
        return False


async def refresh():
    if not _ensure_client():
        return
    try:
        pb = await asyncio.get_event_loop().run_in_executor(None, _sp.current_playback)
        if pb and pb.get("item"):
            item = pb["item"]
            artists = ", ".join(a["name"] for a in item.get("artists", []))
            images = item.get("album", {}).get("images", [])
            album_art = images[0]["url"] if images else None
            await push_update("spotify", {
                "connected": True,
                "playing": pb.get("is_playing", False),
                "track": item.get("name"),
                "artist": artists,
                "album_art": album_art,
                "volume": pb.get("device", {}).get("volume_percent", 50),
                "progress_ms": pb.get("progress_ms", 0),
                "duration_ms": item.get("duration_ms", 0),
                "shuffle": pb.get("shuffle_state", False),
                "repeat": pb.get("repeat_state", "off"),
            })
        elif pb:
            await push_update("spotify", {"connected": True, "playing": False, "track": None})
        else:
            await push_update("spotify", {"connected": True, "playing": False})
    except Exception as e:
        log.debug("Spotify refresh error: %s", e)
        await push_update("spotify", {"connected": False})


async def play_pause():
    if not _ensure_client():
        return
    try:
        pb = await asyncio.get_event_loop().run_in_executor(None, _sp.current_playback)
        if pb and pb.get("is_playing"):
            await asyncio.get_event_loop().run_in_executor(None, _sp.pause_playback)
        else:
            await asyncio.get_event_loop().run_in_executor(None, _sp.start_playback)
        await refresh()
    except Exception as e:
        log.error("Spotify play/pause error: %s", e)


async def next_track():
    if not _ensure_client():
        return
    await asyncio.get_event_loop().run_in_executor(None, _sp.next_track)
    await asyncio.sleep(0.5)
    await refresh()


async def prev_track():
    if not _ensure_client():
        return
    await asyncio.get_event_loop().run_in_executor(None, _sp.previous_track)
    await asyncio.sleep(0.5)
    await refresh()


async def set_volume(volume: int):
    if not _ensure_client():
        return
    volume = max(0, min(100, volume))
    await asyncio.get_event_loop().run_in_executor(None, _sp.volume, volume)
    await push_update("spotify", {"volume": volume})


async def toggle_shuffle():
    if not _ensure_client():
        return
    pb = await asyncio.get_event_loop().run_in_executor(None, _sp.current_playback)
    if pb:
        new_state = not pb.get("shuffle_state", False)
        await asyncio.get_event_loop().run_in_executor(None, _sp.shuffle, new_state)
        await push_update("spotify", {"shuffle": new_state})


async def set_repeat(mode: str):
    if not _ensure_client():
        return
    modes = ["off", "track", "context"]
    if mode in modes:
        await asyncio.get_event_loop().run_in_executor(None, _sp.repeat, mode)
        await push_update("spotify", {"repeat": mode})
