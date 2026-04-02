import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Paths
BASE_DIR = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / "output"
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = BASE_DIR / "logs"

for d in (OUTPUT_DIR, DATA_DIR, LOGS_DIR):
    d.mkdir(exist_ok=True)

# API Keys
ZHIPUAI_API_KEY = os.getenv("ZHIPUAI_API_KEY", "")
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")

# LLM
ZHIPUAI_MODEL = "glm-4.7"

# RSS
RSS_FEED_URL = "https://www.lennysnewsletter.com/feed"

# Limits
MAX_CHUNK_CHARS = 3000
MAX_ANALYSIS_WORDS = 5500  # 5000 front + 500 tail
MIN_CONTENT_CHARS = 200

# SQLite
DB_PATH = DATA_DIR / "processed.db"
