"""Dynamic suspicion score engine for NeoGuard telemetry."""

WEIGHT_MULTIPLIER = 0.6
EVENT_COOLDOWN_MS = 10000

HIGH_RISK_TYPES = {
    "devtools_attempt",
    "paste_attempt",
    "copy_attempt",
    "focus_lost",
    "tab_switch",
    "multiple_people",
    "camera_blocked",
}


class SuspicionEngine:
    def __init__(self):
        self._scores = {}
        self._last_event_at = {}

    def _ensure(self, session_id):
        if session_id not in self._scores:
            self._scores[session_id] = 0
            self._last_event_at[session_id] = {}

    def record(self, session_id, event_type, weight):
        self._ensure(session_id)
        now_ms = __import__("time").time() * 1000
        last = self._last_event_at[session_id].get(event_type)
        if last and (now_ms - last) < EVENT_COOLDOWN_MS:
            return self._scores[session_id], 0
        self._last_event_at[session_id][event_type] = now_ms
        added = round((weight or 8) * WEIGHT_MULTIPLIER)
        self._scores[session_id] = min(100, self._scores[session_id] + added)
        return self._scores[session_id], added

    def score_from_events(self, events):
        score = 0
        last_by_type = {}
        for ev in events:
            etype = ev.get("event_type") or ev.get("type", "")
            weight = ev.get("weight") or 8
            ts = ev.get("created_at") or ev.get("time", "")
            key = (etype, ts)
            if key in last_by_type:
                continue
            last_by_type[key] = True
            score = min(100, score + round(weight * WEIGHT_MULTIPLIER))
        return score

    def get_score(self, session_id):
        return self._scores.get(session_id, 0)

    def risk_level(self, score):
        if score >= 70:
            return "high"
        if score >= 40:
            return "moderate"
        return "low"

    def summary(self, session_id, event_count):
        score = self.get_score(session_id)
        if not event_count:
            return "No suspicious browser behavior detected during this exam."
        return (
            f"{event_count} suspicious event(s) detected with a "
            f"dynamic risk score of {score}%."
        )


engine = SuspicionEngine()
