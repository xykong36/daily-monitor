"""Configuration loading from .env and defaults."""

import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_DIR = Path(__file__).resolve().parent
load_dotenv(PROJECT_DIR / ".env")

# --- API Keys ---
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "")
BILIBILI_SESSDATA = os.environ.get("BILIBILI_SESSDATA", "")
GMAIL_USER = os.environ.get("GMAIL_USER", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
RECIPIENT_EMAIL = os.environ.get("RECIPIENT_EMAIL", "")

# --- Bilibili API ---
BILI_API_BASE = "https://api.bilibili.com"
BILI_APP_BASE = "https://app.bilibili.com"
BILI_REFERER = "https://www.bilibili.com/"
BILI_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

# --- Ranking categories to fetch ---
RANKING_RIDS = {
    0: "全站",
    36: "知识",
    188: "科技",
}

# --- BBDown ---
BBDOWN_BIN = PROJECT_DIR / "bin" / "BBDown"

# --- Paths ---
DATA_DIR = PROJECT_DIR / "data"
LOGS_DIR = PROJECT_DIR / "logs"
SUBTITLES_DIR = DATA_DIR / "subtitles"
DB_PATH = DATA_DIR / "seen.db"

# --- AI Filter ---
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"

# --- Limits ---
SUBTITLE_MAX_CHARS = 500  # Max chars of subtitle text sent to AI
POPULAR_PAGE_SIZE = 20
POPULAR_PAGES = 5

# Ensure directories exist
DATA_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)
SUBTITLES_DIR.mkdir(exist_ok=True)
