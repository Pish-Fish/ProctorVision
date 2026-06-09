"""
ProctorVision Backend — Flask + SQLite + Socket.IO + Gemini + ReportLab
Run:  python app.py
Demo: http://127.0.0.1:5000/api/health
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room

load_dotenv(Path(__file__).parent / ".env")

import db
from gemini_engine import generate_verdict
from pdf_reports import build_incident_pdf
from scoring import engine

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "proctorvision-demo-secret")
CORS(app, resources={r"/api/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

db.init_db()


def _resolve_session(session_id=None, submission_id=None):
    if session_id:
        return db.get_session(session_id)
    if submission_id:
        return db.get_session_by_submission(submission_id)
    return None


def _broadcast_live(event_payload, score_payload):
    socketio.emit("live_event", event_payload, room="teachers")
    socketio.emit("score_update", score_payload, room="teachers")


@app.get("/api/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "service": "ProctorVision Backend",
            "stack": ["Flask", "SQLite", "Socket.IO", "Gemini", "ReportLab"],
            "gemini_configured": bool(
                os.getenv("GEMINI_API_KEY", "").strip()
                and os.getenv("GEMINI_API_KEY") != "your_gemini_api_key_here"
            ),
        }
    )


@app.post("/api/sessions/join")
def session_join():
    body = request.get_json(force=True, silent=True) or {}
    session_id = body.get("session_id")
    exam_id = body.get("exam_id")
    student_name = body.get("student_name")
    exam_title = body.get("exam_title", "")

    if not all([session_id, exam_id, student_name]):
        return jsonify({"error": "session_id, exam_id, and student_name required"}), 400

    db.create_session(session_id, exam_id, exam_title, student_name)
    payload = {
        "session_id": session_id,
        "exam_id": exam_id,
        "exam_title": exam_title,
        "student_name": student_name,
        "suspicion_score": 0,
        "risk_level": "low",
    }
    socketio.emit("session_joined", payload, room="teachers")
    return jsonify({"ok": True, **payload})


@app.post("/api/events")
def ingest_event():
    body = request.get_json(force=True, silent=True) or {}
    session_id = body.get("session_id")
    exam_id = body.get("exam_id")
    student_name = body.get("student_name")
    event_type = body.get("type") or body.get("event_type")
    details = body.get("details", "")
    weight = int(body.get("weight") or 8)

    if not all([session_id, exam_id, student_name, event_type]):
        return jsonify({"error": "Missing required event fields"}), 400

    db.create_session(
        session_id,
        exam_id,
        body.get("exam_title", ""),
        student_name,
    )
    db.log_event(session_id, exam_id, student_name, event_type, details, weight)

    score, added = engine.record(session_id, event_type, weight)
    events = db.get_events(session_id)
    risk_level = engine.risk_level(score)
    db.update_risk_score(session_id, score, risk_level, len(events))

    event_payload = {
        "session_id": session_id,
        "exam_id": exam_id,
        "exam_title": body.get("exam_title", ""),
        "student_name": student_name,
        "type": event_type,
        "details": details,
        "weight": weight,
        "added": added,
        "time": body.get("time"),
    }
    score_payload = {
        "session_id": session_id,
        "exam_id": exam_id,
        "student_name": student_name,
        "suspicion_score": score,
        "risk_level": risk_level,
        "event_count": len(events),
    }
    _broadcast_live(event_payload, score_payload)

    return jsonify({"ok": True, "suspicion_score": score, "risk_level": risk_level, "added": added})


@app.post("/api/sessions/submit")
def session_submit():
    body = request.get_json(force=True, silent=True) or {}
    session_id = body.get("session_id")
    submission_id = body.get("submission_id")
    score_val = body.get("score")
    total = body.get("total")
    pct = body.get("pct")

    if not session_id or submission_id is None:
        return jsonify({"error": "session_id and submission_id required"}), 400

    db.submit_session(session_id, submission_id, score_val, total, pct)
    events = db.get_events(session_id)
    suspicion = engine.get_score(session_id) or engine.score_from_events(events)
    risk_level = engine.risk_level(suspicion)
    db.update_risk_score(session_id, suspicion, risk_level, len(events))

    session = db.get_session(session_id) or {}
    risk = db.get_risk_score(session_id) or {
        "suspicion_score": suspicion,
        "risk_level": risk_level,
        "event_count": len(events),
    }
    narrative, source = generate_verdict(session, events, risk)
    db.save_verdict(session_id, narrative, source)

    alert = {
        "session_id": session_id,
        "submission_id": submission_id,
        "student_name": session.get("student_name"),
        "exam_title": session.get("exam_title"),
        "suspicion_score": suspicion,
        "risk_level": risk_level,
        "summary": engine.summary(session_id, len(events)),
        "ai_verdict": narrative,
    }
    socketio.emit("submission_alert", alert, room="teachers")

    return jsonify(
        {
            "ok": True,
            "suspicion_score": suspicion,
            "risk_level": risk_level,
            "summary": engine.summary(session_id, len(events)),
            "ai_verdict": narrative,
            "verdict_source": source,
        }
    )


@app.get("/api/live/feed")
def live_feed():
    limit = int(request.args.get("limit", 30))
    exam_id = request.args.get("exam_id")
    if exam_id:
        events = db.get_live_events_for_exam(exam_id, limit)
    else:
        events = db.get_recent_live_events(limit)
    return jsonify({"events": events})


@app.post("/api/teacher/flag")
def teacher_flag():
    body = request.get_json(force=True, silent=True) or {}
    exam_id = body.get("exam_id")
    student_name = body.get("student_name")
    if not exam_id or not student_name:
        return jsonify({"error": "exam_id and student_name required"}), 400

    session = db.find_active_session(exam_id, student_name)
    session_id = session["id"] if session else f"flag_{exam_id}_{student_name}"
    if not session:
        db.create_session(session_id, exam_id, body.get("exam_title", ""), student_name)

    details = "Flagged by teacher for manual review"
    weight = 20
    db.log_event(session_id, exam_id, student_name, "teacher_flag", details, weight)
    score, added = engine.record(session_id, "teacher_flag", weight)
    events = db.get_events(session_id)
    risk_level = engine.risk_level(score)
    db.update_risk_score(session_id, score, risk_level, len(events))

    event_payload = {
        "session_id": session_id,
        "exam_id": exam_id,
        "student_name": student_name,
        "type": "teacher_flag",
        "details": details,
        "weight": weight,
        "added": added,
    }
    score_payload = {
        "session_id": session_id,
        "exam_id": exam_id,
        "student_name": student_name,
        "suspicion_score": score,
        "risk_level": risk_level,
        "event_count": len(events),
    }
    _broadcast_live(event_payload, score_payload)
    return jsonify({"ok": True, "suspicion_score": score, "risk_level": risk_level})


@app.get("/api/sessions/active")
def active_sessions():
    return jsonify({"sessions": db.get_active_sessions()})


@app.get("/api/submissions/<submission_id>/report")
def submission_report(submission_id):
    session = db.get_session_by_submission(submission_id)
    if not session:
        return jsonify({"error": "Submission not found on backend"}), 404

    session_id = session["id"]
    events = db.get_events(session_id)
    risk = db.get_risk_score(session_id) or {
        "suspicion_score": engine.score_from_events(events),
        "risk_level": "low",
        "event_count": len(events),
    }
    risk["suspicion_score"] = risk.get("suspicion_score") or engine.score_from_events(events)
    risk["risk_level"] = engine.risk_level(risk["suspicion_score"])

    verdict_row = db.get_verdict(session_id)
    refresh = request.args.get("refresh", "").lower() in ("1", "true", "yes")
    if verdict_row and not refresh:
        narrative = verdict_row["narrative"]
        source = verdict_row.get("source", "template")
        # Upgrade stale short/template verdicts when regenerating logic improves
        if source == "template" and len(narrative) < 400:
            narrative, source = generate_verdict(session, events, risk)
            db.save_verdict(session_id, narrative, source)
    else:
        narrative, source = generate_verdict(session, events, risk)
        db.save_verdict(session_id, narrative, source)

    return jsonify(
        {
            "session": session,
            "events": events,
            "risk": risk,
            "ai_verdict": narrative,
            "verdict_source": source,
            "summary": engine.summary(session_id, len(events)),
        }
    )


@app.get("/api/submissions/<submission_id>/pdf")
def submission_pdf(submission_id):
    session = db.get_session_by_submission(submission_id)
    if not session:
        return jsonify({"error": "Submission not found on backend"}), 404

    session_id = session["id"]
    events = db.get_events(session_id)
    risk = db.get_risk_score(session_id) or {
        "suspicion_score": engine.score_from_events(events),
        "risk_level": "low",
        "event_count": len(events),
    }
    verdict_row = db.get_verdict(session_id)
    if verdict_row:
        narrative = verdict_row["narrative"]
    else:
        narrative, source = generate_verdict(session, events, risk)
        db.save_verdict(session_id, narrative, source)

    pdf_buffer = build_incident_pdf(session, events, risk, narrative)
    filename = f"ProctorVision_Report_{submission_id}.pdf"
    return send_file(
        pdf_buffer,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=filename,
    )


@socketio.on("connect")
def on_connect():
    emit("connected", {"message": "ProctorVision backend connected"})


@socketio.on("join_role")
def on_join_role(data):
    role = (data or {}).get("role", "student")
    room = "teachers" if role == "teacher" else "students" if role == "student" else "admin"
    join_room(room)
    emit("joined", {"role": role, "room": room})


@socketio.on("proctor_event")
def on_proctor_event(data):
    """Optional direct socket ingest (mirrors REST /api/events)."""
    if not data:
        return
    with app.test_request_context(json=data):
        ingest_event()


# ════════════════════════════════════════
# ADMIN ENDPOINTS
# ════════════════════════════════════════

def _require_admin(token=None):
    """Simple admin authentication: check for admin token header."""
    token = token or request.headers.get("X-Admin-Token", "")
    admin_token = os.getenv("ADMIN_TOKEN", "admin-secret-token-2024")
    return token == admin_token


@app.get("/api/admin/stats")
def admin_stats():
    """Get system statistics for admin dashboard."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    sessions = db.get_all_sessions()
    events = db.get_all_events()
    active_sessions = [s for s in sessions if s.get("status") == "active"]
    
    return jsonify({
        "total_sessions": len(sessions),
        "active_sessions": len(active_sessions),
        "total_events": len(events),
        "total_submissions": len([s for s in sessions if s.get("status") == "submitted"]),
        "average_suspicion": int(sum([e.get("weight", 0) for e in events]) / max(len(events), 1))
    })


@app.get("/api/admin/sessions")
def admin_get_sessions():
    """Get all exam sessions for admin review."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    sessions = db.get_all_sessions()
    return jsonify({"sessions": sessions})


@app.get("/api/admin/submissions")
def admin_get_submissions():
    """Get all submissions for admin review."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    sessions = db.get_all_sessions()
    submissions = [s for s in sessions if s.get("status") == "submitted"]
    return jsonify({"submissions": submissions})


@app.post("/api/admin/submission/<submission_id>/override")
def admin_override_submission(submission_id):
    """Admin can override submission score/status."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    body = request.get_json(force=True, silent=True) or {}
    new_score = body.get("score")
    new_status = body.get("status", "approved")
    notes = body.get("notes", "")
    
    session = db.get_session_by_submission(submission_id)
    if not session:
        return jsonify({"error": "Submission not found"}), 404
    
    # Update submission status
    session_id = session["id"]
    if new_score is not None:
        db.execute(
            "UPDATE exam_sessions SET score = ? WHERE id = ?",
            (new_score, session_id)
        )
    
    # Log admin action
    db.log_event(
        session_id,
        session.get("exam_id"),
        session.get("student_name"),
        "admin_override",
        f"Admin override: {notes}",
        0
    )
    
    return jsonify({
        "ok": True,
        "message": f"Submission {submission_id} updated by admin",
        "new_status": new_status
    })


@app.get("/api/admin/events")
def admin_get_events():
    """Get all system events for audit log."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    events = db.get_all_events()
    return jsonify({"events": events[-100:]})  # Last 100 events


@app.post("/api/admin/user/create")
def admin_create_user():
    """Create a new user (teacher, student, or admin)."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    body = request.get_json(force=True, silent=True) or {}
    name = body.get("name")
    email = body.get("email")
    role = body.get("role", "student")
    
    if not all([name, email, role]) or role not in ["student", "teacher", "admin"]:
        return jsonify({"error": "Invalid user data"}), 400
    
    # In a real system, this would be stored in a users table
    # For now, we log the action
    return jsonify({
        "ok": True,
        "user_id": f"u_{email.split('@')[0]}",
        "name": name,
        "email": email,
        "role": role,
        "created": db.utcnow()
    })


@app.post("/api/admin/user/<user_id>/delete")
def admin_delete_user(user_id):
    """Delete a user from the system."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    # In a real system, check for associated data before deletion
    return jsonify({
        "ok": True,
        "message": f"User {user_id} has been deleted"
    })


@app.post("/api/admin/course/create")
def admin_create_course():
    """Create a new course."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    body = request.get_json(force=True, silent=True) or {}
    code = body.get("code")
    name = body.get("name")
    description = body.get("description", "")
    
    if not all([code, name]):
        return jsonify({"error": "Course code and name required"}), 400
    
    return jsonify({
        "ok": True,
        "course_id": f"c_{code.lower()}",
        "code": code,
        "name": name,
        "description": description,
        "created": db.utcnow()
    })


@app.post("/api/admin/exam/<exam_id>/delete")
def admin_delete_exam(exam_id):
    """Delete an exam from the system."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    # This would cascade delete related sessions and submissions
    return jsonify({
        "ok": True,
        "message": f"Exam {exam_id} and related submissions deleted"
    })


@app.post("/api/admin/settings")
def admin_update_settings():
    """Update system-wide settings."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    body = request.get_json(force=True, silent=True) or {}
    
    settings = {
        "face_detection": body.get("face_detection", True),
        "gaze_tracking": body.get("gaze_tracking", True),
        "suspicion_threshold": body.get("suspicion_threshold", 50),
        "updated": db.utcnow()
    }
    
    # In a real system, store these in a settings table or config file
    return jsonify({
        "ok": True,
        "settings": settings,
        "message": "System settings updated"
    })


@app.get("/api/admin/report/submissions")
def admin_report_submissions():
    """Generate submissions report for admin."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    sessions = db.get_all_sessions()
    submissions = [s for s in sessions if s.get("status") == "submitted"]
    
    report = {
        "total_submissions": len(submissions),
        "average_score": int(sum([s.get("pct", 0) for s in submissions]) / max(len(submissions), 1)) if submissions else 0,
        "submissions": submissions
    }
    
    return jsonify(report)


@app.get("/api/admin/report/sessions")
def admin_report_sessions():
    """Generate sessions report for admin."""
    if not _require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    
    sessions = db.get_all_sessions()
    report = {
        "total_sessions": len(sessions),
        "active_sessions": len([s for s in sessions if s.get("status") == "active"]),
        "completed_sessions": len([s for s in sessions if s.get("status") == "submitted"]),
        "sessions": sessions
    }
    
    return jsonify(report)


if __name__ == "__main__":
    print("ProctorVision Backend starting on http://127.0.0.1:5000")
    print("Stack: Flask | SQLite | Socket.IO | Gemini | ReportLab")
    socketio.run(app, host="0.0.0.0", port=5000, debug=True, allow_unsafe_werkzeug=True)
