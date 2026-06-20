from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    SECRET_KEY: str = "moti-secret-key-change-me"

    # Spotify
    SPOTIFY_CLIENT_ID: Optional[str] = None
    SPOTIFY_CLIENT_SECRET: Optional[str] = None
    SPOTIFY_REDIRECT_URI: str = "http://127.0.0.1:8000/callback/spotify"

    # Yeelight (no token needed — just IP + LAN Control enabled in app)
    XIAOMI_LIGHT_IP: Optional[str] = None
    XIAOMI_LIGHT_2_IP: Optional[str] = None

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()
