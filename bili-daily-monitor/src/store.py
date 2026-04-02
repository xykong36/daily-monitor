"""SQLite-based dedup store for processed videos."""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime

from config import DB_PATH

logger = logging.getLogger(__name__)

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS seen (
    bvid TEXT PRIMARY KEY,
    title TEXT,
    first_seen TEXT,
    notified INTEGER DEFAULT 0
)
"""


class SeenStore:
    """Track which videos have already been processed."""

    def __init__(self, db_path: str | None = None):
        self.db_path = db_path or str(DB_PATH)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.execute(_CREATE_SQL)
        self.conn.commit()

    def is_seen(self, bvid: str) -> bool:
        row = self.conn.execute("SELECT 1 FROM seen WHERE bvid = ?", (bvid,)).fetchone()
        return row is not None

    def filter_new(self, bvids: list[str]) -> list[str]:
        """Return only bvids not yet in the store."""
        if not bvids:
            return []
        placeholders = ",".join("?" for _ in bvids)
        rows = self.conn.execute(
            f"SELECT bvid FROM seen WHERE bvid IN ({placeholders})", bvids
        ).fetchall()
        existing = {r[0] for r in rows}
        return [b for b in bvids if b not in existing]

    def mark_seen(self, bvid: str, title: str = "") -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO seen (bvid, title, first_seen) VALUES (?, ?, ?)",
            (bvid, title, datetime.now().isoformat()),
        )
        self.conn.commit()

    def mark_notified(self, bvid: str) -> None:
        self.conn.execute("UPDATE seen SET notified = 1 WHERE bvid = ?", (bvid,))
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
