# ProctorVision

## Quick start

**Terminal 1 — Backend (Flask + SQLite + Socket.IO)**
```powershell
cd backend
pip install -r requirements.txt
py -3 app.py
```

**Terminal 2 — Frontend**
```powershell
cd ..
py -3 -m http.server 8000
```

Open http://localhost:8000

Or use `.\start-backend.ps1` from the project root.

## Demo flow

1. **Teacher portal** — Create/publish an exam, watch **ProctorVision Live Watch** (needs backend running).
2. **Student portal** — Take the exam; camera + proctoring run automatically.
3. **Teacher portal** — **Student Results** → View Report / PDF.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | HTML, CSS, JavaScript, role-based portal UI |
| Backend | Flask + Python services |
| Database | SQLite (backend data store) |
| Real-time | Socket.IO for live monitoring and event updates |
| AI verdict | Gemini API via `backend/.env` |
| Reports | ReportLab PDF export |

## Optional: Gemini AI verdicts

Copy `backend/.env.example` to `backend/.env` and set `GEMINI_API_KEY`. Without it, detailed template verdicts are used.

## Anti-cheating features

- Webcam-based monitoring and face detection heuristics
- Exam session monitoring with live activity events
- Suspicion scoring and risk-based review
- Tab switch / focus loss detection
- Copy, cut, paste, and right-click blocking
- DevTools / print / view-source shortcut blocking
- Gaze-away and head-tilt heuristics
- Live teacher dashboard and student result review
- AI-assisted verdicts and PDF report generation
