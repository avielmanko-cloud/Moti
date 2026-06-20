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

CACHE_PATH = ".spotify_cache"
SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing"

_auth_manager: Optional["SpotifyOAuth"] = None
_sp: Optional[object] = None  # spotipy.Spotify(auth=<token>) — no auth_manager


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
    """Exchange auth code for tokens and persist to cache."""
    global _auth_manager, _sp
    if not _auth_manager:
        _auth_manager = _make_auth_manager()
    try:
        token_info = _auth_manager.get_access_token(code, as_dict=True, check_cache=False)
        if token_info and token_info.get("access_token"):
            _sp = spotipy.Spotify(auth=token_info["access_token"])
            log.info("Spotify authenticated OK")
            return True
    except Exception as e:
        log.error("Spotify callback error: %s", e)
    return False


def _get_valid_access_token() -> Optional[str]:
    """
    Returns a live access token from cache without EVER triggering interactive auth.
    Handles refresh manually so spotipy never gets a chance to call get_auth_response().
    """
    if not SPOTIPY_AVAILABLE or not settings.SPOTIFY_CLIENT_ID:
        return None
    if not os.path.exists(CACHE_PATH):
        return None

    try:
        am = _make_auth_manager()
        cached = am.cache_handler.get_cached_token()
        if not cached or not cached.get("access_token"):
            return None

        if not am.is_token_expired(cached):
            return cached["access_token"]

        # Token expired — try refresh
        refresh_token = cached.get("refresh_token")
        if not refresh_token:
            log.warning("Spotify: no refresh_token in cache — re-auth required")
            _clear_cache()
            return None

        new_token = am.refresh_access_token(refresh_token)
        if new_token and new_token.get("access_token"):
            return new_token["access_token"]

        # Refresh rejected (e.g. wrong redirect_uri in old cache) — nuke stale cache
        log.warning("Spotify: token refresh failed — deleting stale cache, re-auth required")
        _clear_cache()
        return None

    except Exception as e:
        log.debug("Spotify token fetch error: %s", e)
        _clear_cache()
        return None


def _clear_cache():
    try:
        if os.path.exists(CACHE_PATH):
            os.remove(CACHE_PATH)
            log.info("Spotify: cleared stale .spotify_cache")
    except Exception:
        pass


def _ensure_client() -> bool:
    """Build/refresh the Spotify client from the cache token. Never blocks."""
    global _sp
    token = _get_valid_access_token()
    if not token:
        _sp = None
        return False
    # Always create with raw access token — no auth_manager so spotipy
    # can never fall back to interactive auth.
    _sp = spotipy.Spotify(auth=token)
    return True


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
        fn = _sp.pause_playback if pb and pb.get("is_playing") else _sp.start_playback
        await asyncio.get_event_loop().run_in_executor(None, fn)
        await refresh()
    except Exception as e:
        log.error("Spotify play/pause: %s", e)


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
    if mode in ("off", "track", "context"):
        await asyncio.get_event_loop().run_in_executor(None, _sp.repeat, mode)
        await push_update("spotify", {"repeat": mode})
