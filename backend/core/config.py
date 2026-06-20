from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    SECRET_KEY: str = "moti-secret-key-change-me"

    # Spotify
    SPOTIFY_CLIENT_ID: Optional[str] = None
    SPOTIFY_CLIENT_SECRET: Optional[str] = None
    SPOTIFY_REDIRECT_URI: str = "http://localhost:8000/callback/spotify"

    # Xiaomi
    XIAOMI_LIGHT_IP: Optional[str] = None
    XIAOMI_LIGHT_TOKEN: Optional[str] = None
    XIAOMI_LIGHT_2_IP: Optional[str] = None
    XIAOMI_LIGHT_2_TOKEN: Optional[str] = None

    # Twilio / WhatsApp
    TWILIO_ACCOUNT_SID: Optional[str] = None
    TWILIO_AUTH_TOKEN: Optional[str] = None
    TWILIO_WHATSAPP_FROM: str = "whatsapp:+14155238886"

    # Phone ADB
    ADB_DEVICE_IP: Optional[str] = None
    ADB_PORT: int = 5555

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()
