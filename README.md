# ProctorVision

Browser-based exam platform for **Iloilo Merchant Marine School**. Teachers create and monitor assessments, students take exams on a mobile browser with session-integrity monitoring, and admins oversee the system.

## Portals

| Portal | Devices | Purpose |
|--------|---------|---------|
| **Admin** | Computer, tablet, and phone | Users, courses, exams, sessions, submissions, events, settings, reports |
| **Teacher** | Computer, tablet, and phone | Courses, exams, live watch, results, grades, students |
| **Student** | **Mobile browser only** (phone or tablet) | Courses, exams, results, profile |

### Student device rule

Students must open the Student Portal on a mobile device. If they try to enter from a computer, the app blocks access and shows:

> This account is registered as a student. Student access is limited to mobile devices. Please open the Student Portal on a smartphone or tablet.

Phones, Android tablets, iPads, and iPadOS devices (including those that report as Macintosh with touch) are treated as mobile. Chrome DevTools **device mode** also counts as mobile, which is useful for local testing.

Teacher and Admin portals stay multi-platform. On narrower screens they use a hamburger menu instead of a always-visible sidebar. The student app uses a bottom tab bar (Dashboard, Courses, Exams, Results, Profile).

## Quick start

**Terminal 1 — Backend (Flask + SQLite + Socket.IO)**
```powershell
cd backend
pip install -r requirements.txt
py -3 app.py
```

**Terminal 2 — Frontend**
```powershell
.\start-frontend.ps1
```

The frontend launcher always serves the project root (the folder containing `index.html`). Open http://localhost:8000 on the same computer, or use the computer's LAN IP (for example, `http://172.20.10.5:8000`) on another device.

Or run `.\start-backend.ps1` from the project root for the backend only.

## Demo flow

1. Open the site and pick a portal.
2. **Teacher** (any device) — Create a course with a join code, create/publish an exam, then watch **ProctorVision Live Watch** (backend must be running).
3. **Student** (mobile, or desktop Chrome with device mode) — Enroll with the course code, start the exam. Session monitoring starts automatically (no camera).
4. **Teacher** — **Student Results** → View Report / download PDF.
5. **Admin** (any device) — Review users, sessions, submissions, events, and reports.

## Features

### Admin
- Dashboard and system overview
- User, course, and assessment management
- Session, submission, and proctoring-event review
- Settings and reports

### Teacher
- Course creation with enrollment / join codes
- Assessment builder (questions can be randomized for students)
- Live exam monitoring via Socket.IO
- Results, grades, student lists, and PDF incident reports
- Flag a student during a live session

### Student
- Mobile-first layout in the browser
- Enroll in courses by code
- Take published exams in the mobile browser
- View results and profile (demo accounts can be switched in the top bar)

## Anti-cheating / proctoring

Student exams do **not** use the camera. Integrity checks are session-based so they work in a phone browser without HTTPS webcam access.

- Live activity events sent to the teacher dashboard
- Suspicion scoring and risk levels
- Tab switch / focus loss detection
- Copy, cut, paste, selection, drag, and right-click blocking during the exam
- DevTools / print / view-source shortcut blocking
- Teacher flagging, AI-assisted verdicts, and PDF reports

Screenshot detection is limited by the browser: desktop `PrintScreen` key presses can be logged when the browser reports them, but iOS does not notify web pages when a device screenshot is taken. Screenshots therefore cannot be reliably detected or blocked on iPhone/iPad in this web app.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | HTML, CSS, JavaScript (`index.html`, `app.js`, `styles.css`) |
| Backend | Flask + Python (`backend/app.py` and services) |
| Database | SQLite |
| Real-time | Socket.IO live monitoring |
| AI verdict | Gemini API via `backend/.env` (optional) |
| Reports | ReportLab PDF export |

## Optional: Gemini AI verdicts

Copy `backend/.env.example` to `backend/.env` and set `GEMINI_API_KEY`. Without it, the app still runs and uses template verdicts.
