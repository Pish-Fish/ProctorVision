import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "neoguard.db"


def utcnow():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS exam_sessions (
                id TEXT PRIMARY KEY,
                submission_id TEXT,
                exam_id TEXT NOT NULL,
                exam_title TEXT,
                student_name TEXT NOT NULL,
                joined_at TEXT NOT NULL,
                submitted_at TEXT,
                score INTEGER,
                total INTEGER,
                pct INTEGER,
                status TEXT NOT NULL DEFAULT 'active'
            );

            CREATE TABLE IF NOT EXISTS event_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                exam_id TEXT NOT NULL,
                student_name TEXT NOT NULL,
                event_type TEXT NOT NULL,
                details TEXT,
                weight INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES exam_sessions(id)
            );

            CREATE TABLE IF NOT EXISTS risk_scores (
                session_id TEXT PRIMARY KEY,
                suspicion_score INTEGER NOT NULL DEFAULT 0,
                risk_level TEXT NOT NULL DEFAULT 'low',
                event_count INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES exam_sessions(id)
            );

            CREATE TABLE IF NOT EXISTS ai_verdicts (
                session_id TEXT PRIMARY KEY,
                narrative TEXT NOT NULL,
                generated_at TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'template',
                FOREIGN KEY (session_id) REFERENCES exam_sessions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_events_session ON event_logs(session_id);
            CREATE INDEX IF NOT EXISTS idx_events_exam ON event_logs(exam_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_exam ON exam_sessions(exam_id);
            """
        )


def create_session(session_id, exam_id, exam_title, student_name):
    with get_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO exam_sessions
            (id, exam_id, exam_title, student_name, joined_at, status)
            VALUES (?, ?, ?, ?, ?, 'active')
            """,
            (session_id, exam_id, exam_title, student_name, utcnow()),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO risk_scores
            (session_id, suspicion_score, risk_level, event_count, updated_at)
            VALUES (?, 0, 'low', 0, ?)
            """,
            (session_id, utcnow()),
        )


def log_event(session_id, exam_id, student_name, event_type, details, weight):
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO event_logs
            (session_id, exam_id, student_name, event_type, details, weight, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (session_id, exam_id, student_name, event_type, details, weight, utcnow()),
        )


def update_risk_score(session_id, suspicion_score, risk_level, event_count):
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO risk_scores (session_id, suspicion_score, risk_level, event_count, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                suspicion_score = excluded.suspicion_score,
                risk_level = excluded.risk_level,
                event_count = excluded.event_count,
                updated_at = excluded.updated_at
            """,
            (session_id, suspicion_score, risk_level, event_count, utcnow()),
        )


def submit_session(session_id, submission_id, score, total, pct):
    with get_db() as conn:
        conn.execute(
            """
            UPDATE exam_sessions
            SET submission_id = ?, score = ?, total = ?, pct = ?,
                submitted_at = ?, status = 'submitted'
            WHERE id = ?
            """,
            (submission_id, score, total, pct, utcnow(), session_id),
        )


def save_verdict(session_id, narrative, source="template"):
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO ai_verdicts (session_id, narrative, generated_at, source)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                narrative = excluded.narrative,
                generated_at = excluded.generated_at,
                source = excluded.source
            """,
            (session_id, narrative, utcnow(), source),
        )


def get_session(session_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM exam_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        return dict(row) if row else None


def get_session_by_submission(submission_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM exam_sessions WHERE submission_id = ?", (submission_id,)
        ).fetchone()
        return dict(row) if row else None


def get_risk_score(session_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM risk_scores WHERE session_id = ?", (session_id,)
        ).fetchone()
        return dict(row) if row else None


def get_events(session_id, limit=500):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM event_logs
            WHERE session_id = ?
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (session_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def get_verdict(session_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM ai_verdicts WHERE session_id = ?", (session_id,)
        ).fetchone()
        return dict(row) if row else None


def get_recent_live_events(limit=50):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT e.*, r.suspicion_score, r.risk_level
            FROM event_logs e
            LEFT JOIN risk_scores r ON r.session_id = e.session_id
            ORDER BY e.created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_active_sessions():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT s.*, r.suspicion_score, r.risk_level, r.event_count
            FROM exam_sessions s
            LEFT JOIN risk_scores r ON r.session_id = s.id
            WHERE s.status = 'active'
            ORDER BY s.joined_at DESC
            """
        ).fetchall()
        return [dict(r) for r in rows]


def find_active_session(exam_id, student_name):
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT * FROM exam_sessions
            WHERE exam_id = ? AND student_name = ? AND status = 'active'
            ORDER BY joined_at DESC LIMIT 1
            """,
            (exam_id, student_name),
        ).fetchone()
        return dict(row) if row else None


def get_live_events_for_exam(exam_id, limit=50):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT e.*, r.suspicion_score, r.risk_level
            FROM event_logs e
            LEFT JOIN risk_scores r ON r.session_id = e.session_id
            WHERE e.exam_id = ?
            ORDER BY e.created_at DESC
            LIMIT ?
            """,
            (exam_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]
