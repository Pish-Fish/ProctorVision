import os
from collections import Counter

from dotenv import load_dotenv

load_dotenv()

EVENT_LABELS = {
    "tab_switch": "browser tab or window switches",
    "focus_lost": "exam window focus loss",
    "focus_return": "returns to the exam tab",
    "focus_regained": "exam window focus regained",
    "copy_attempt": "copy actions",
    "paste_attempt": "paste actions",
    "gaze_away": "gaze-away from screen",
    "gaze_away_fallback": "gaze-away (fallback detection)",
    "no_face": "face not visible in camera",
    "camera_blocked": "camera blocked or covered",
    "multiple_people": "multiple people in frame",
    "speech_detected": "audio/speech during exam",
    "devtools_attempt": "developer tools access attempts",
    "head_tilt": "head tilt / turned away",
    "offscreen_device_look": "possible off-screen device or alternate display view",
    "movement_detected": "sudden movement in frame",
    "rapid_typing": "unusually rapid typing",
    "teacher_flag": "manual teacher flag",
    "multi_screen_look": "face oriented toward another screen",
    "face_turned_away": "sustained face turn away from camera",
    "restricted_object": "potential restricted object in view",
    "inspection_attempt": "browser inspection shortcuts",
}


def _risk_recommendation(score, level):
    if score >= 70:
        return (
            "Recommendation: Treat this session as high priority for academic integrity review. "
            "Schedule a follow-up with the student, compare answers against class norms, and "
            "consider withholding final grade approval until the session is investigated."
        )
    if score >= 40:
        return (
            "Recommendation: Moderate concern warrants instructor review before finalizing the grade. "
            "Review the event timeline below, note whether focus changes align with legitimate breaks, "
            "and document any follow-up conversation with the student."
        )
    return (
        "Recommendation: No immediate integrity action required. "
        "The session appears broadly consistent with normal proctored exam conduct; "
        "routine archival of this report is sufficient."
    )


def _template_verdict(session, events, risk):
    score = risk.get("suspicion_score", 0)
    level = risk.get("risk_level", "low")
    student = session.get("student_name", "The student")
    exam = session.get("exam_title") or session.get("exam_id", "the exam")
    count = len(events)
    exam_score = session.get("score")
    exam_total = session.get("total")
    exam_pct = session.get("pct")
    joined = (session.get("joined_at") or "")[:19].replace("T", " ")
    submitted = (session.get("submitted_at") or "")[:19].replace("T", " ")

    score_line = (
        f"{exam_score}/{exam_total} ({exam_pct}%)"
        if exam_score is not None and exam_total
        else "not recorded"
    )

    if count == 0:
        return (
            f"Session overview\n"
            f"{student} completed \"{exam}\" under NeoGuard proctoring. "
            f"Exam performance: {score_line}. "
            f"Session window: {joined or '—'} to {submitted or '—'}.\n\n"
            f"Behavioral analysis\n"
            f"Across the full monitoring window, NeoGuard did not record any suspicious telemetry. "
            f"Camera, browser focus, and input signals remained within expected parameters for a solo proctored attempt.\n\n"
            f"Risk assessment\n"
            f"Dynamic suspicion score: 0% (low risk). "
            f"No integrity flags were raised during this session.\n\n"
            f"{_risk_recommendation(0, 'low')}"
        )

    type_counts = Counter(ev.get("event_type", "unknown") for ev in events)
    top_events = type_counts.most_common(6)

    breakdown_lines = []
    for etype, n in top_events:
        label = EVENT_LABELS.get(etype, etype.replace("_", " "))
        breakdown_lines.append(f"• {label}: {n} occurrence{'s' if n != 1 else ''}")
    breakdown = "\n".join(breakdown_lines)

    sample_events = []
    for ev in events[:5]:
        ts = (ev.get("created_at") or "")[11:19] or "—"
        detail = ev.get("details") or ev.get("event_type", "")
        sample_events.append(f"• [{ts}] {detail}")
    timeline = "\n".join(sample_events)
    if count > 5:
        timeline += f"\n• … and {count - 5} additional logged event(s)"

    pattern_notes = []
    if type_counts.get("tab_switch") or type_counts.get("focus_lost"):
        n = type_counts.get("tab_switch", 0) + type_counts.get("focus_lost", 0)
        pattern_notes.append(
            f"The student left or switched away from the exam context {n} time(s), "
            f"which may indicate reference to external materials or multitasking."
        )
    if type_counts.get("gaze_away") or type_counts.get("gaze_away_fallback"):
        pattern_notes.append(
            "Repeated gaze-away events suggest the student was not consistently oriented toward the screen."
        )
    if type_counts.get("copy_attempt") or type_counts.get("paste_attempt"):
        pattern_notes.append(
            "Clipboard activity was detected, which is uncommon during closed-book assessments."
        )
    if type_counts.get("no_face") or type_counts.get("camera_blocked"):
        pattern_notes.append(
            "Camera visibility was interrupted, reducing continuous identity and presence verification."
        )
    if type_counts.get("speech_detected"):
        pattern_notes.append(
            "Audio was detected during the session, raising the possibility of verbal communication."
        )
    if type_counts.get("devtools_attempt"):
        pattern_notes.append(
            "Attempts to access developer tools may indicate an effort to inspect or alter the exam environment."
        )

    if not pattern_notes:
        pattern_notes.append(
            "Events were distributed across several low-to-medium severity categories without a single dominant violation type."
        )

    analysis = " ".join(pattern_notes)

    return (
        f"Session overview\n"
        f"{student} completed \"{exam}\" under NeoGuard proctoring. "
        f"Exam performance: {score_line}. "
        f"Monitoring period: {joined or '—'} through {submitted or '—'}. "
        f"A total of {count} telemetry event(s) were captured and scored server-side.\n\n"
        f"Behavioral analysis\n"
        f"{analysis} "
        f"The composite dynamic suspicion score is {score}% ({level} risk), "
        f"computed from weighted event severity, frequency, and cooldown-adjusted accumulation.\n\n"
        f"Event breakdown\n"
        f"{breakdown}\n\n"
        f"Notable timeline\n"
        f"{timeline}\n\n"
        f"Risk assessment\n"
        f"NeoGuard classifies this session as {level.upper()} RISK ({score}%). "
        f"{'Multiple high-weight integrity signals were observed.' if score >= 40 else 'Observed signals remain below typical review thresholds.'}\n\n"
        f"{_risk_recommendation(score, level)}"
    )


def generate_verdict(session, events, risk):
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key or api_key == "your_gemini_api_key_here":
        return _template_verdict(session, events, risk), "template"

    try:
        import google.generativeai as genai

        genai.configure(api_key=api_key)
        model_name = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
        model = genai.GenerativeModel(model_name)

        event_lines = "\n".join(
            f"- [{ev.get('created_at', '')}] {ev.get('event_type')}: {ev.get('details')} (weight {ev.get('weight')})"
            for ev in events[:50]
        )
        prompt = f"""You are NeoGuard, an academic integrity analyst writing a formal proctoring report for a teacher.

Write a detailed AI verdict (6–10 sentences, plain prose paragraphs). Structure your response with these section headings on their own line, followed by content:
Session overview
Behavioral analysis
Event breakdown
Risk assessment
Recommendation

Student: {session.get('student_name')}
Exam: {session.get('exam_title')}
Exam score: {session.get('score')}/{session.get('total')} ({session.get('pct')}%)
Suspicion score: {risk.get('suspicion_score')}% ({risk.get('risk_level')} risk)
Total events: {len(events)}

Event log:
{event_lines or 'No events recorded.'}

Be specific about patterns, severity, and whether the instructor should investigate. Do not use bullet points in the Recommendation section."""

        response = model.generate_content(prompt)
        text = (response.text or "").strip()
        if text:
            return text, "gemini"
    except Exception as exc:
        print(f"[NeoGuard] Gemini unavailable: {exc}")

    return _template_verdict(session, events, risk), "template"
