// ════════════════════════════════════════
// SHARED DATA
// ════════════════════════════════════════
const STORAGE_KEY = 'lms_data_v2';
const STUDENT_NAME = 'Juan Dela Cruz';
const STUDENT_COURSES = ['c1','c2','c3'];

let currentRole = null;
let data = loadData();
let proctorSession = null;
let monitorInterval = null, monitorExamId = null;
// Live event buffering to reduce localStorage churn
let liveEventBuffer = [];
let liveEventFlushTimer = null;
const LIVE_EVENT_FLUSH_MS = 2000;
const BACKEND_URL = 'http://127.0.0.1:5000';
let backendSocket = null;
let backendSessionId = null;
let backendConnected = false;
let backendLiveEvents = [];
let backendLiveScores = {};
let currentReportSubmissionId = null;

// Exam-taking state
let activeExam = null, answers = {}, currentQ = 0, timerInterval = null, timeLeft = 0;
let cameraStream = null, cameraAnalysisHandle = null, cameraAnalysisInFlight = false, audioContext = null, analyserNode = null, audioDataArray = null, lastFrameData = null;
let audioAvailable = false;
let faceDetector = null, examPausedDueCamera = false, pauseReason = '';
let gazeHistory = [];
let lastFaceAspect = null;
let lastFaceAreaRatio = null;
// Gaze + motion tuning (added to reduce false positives)
let lastMotionFrame = null;
let motionHistory = [];
const motionHistoryLen = 10;
const motionHighThreshold = 0.03; // above this => ignore gaze checks
const motionLowThreshold = 0.007; // below this => stable
let isHighMotion = false;
let motionLevel = 0;

const gazeAwayConsecutiveRequired = 3; // require fewer consecutive "away" frames for better detection
const gazeAwayThreshold = 0.58; // per-frame away confidence threshold
let gazeAwayConsecutive = 0;
let lastGazeState = 'on';
// Scoring and robustness tuning
const PROCTOR_WEIGHT_MULTIPLIER = 0.6; // reduce raw weights to make scoring less aggressive
const EVENT_COOLDOWN_MS = 10000; // ignore identical events for this duration to avoid rapid repeats
const GAZE_UNCERTAIN_REQUIRED = 5; // require more sustained fallback evidence
let gazeUncertainConsecutive = 0;
// Face-center tracking to detect looking at other screens/devices
let faceCenterHistory = [];
const FACE_HISTORY_LEN = 12;
const FACE_AWAY_THRESHOLD = 0.16; // normalized (0..1) displacement from center (more sensitive)
const FACE_AWAY_CONSECUTIVE_REQUIRED = 2; // fewer consecutive frames required
let faceAwayConsecutive = 0;
let calibrationPassed = false;
let calibrationHistory = [];
let calibrationConsecutive = 0;
let autoStartedOnCalibration = false;
const CALIBRATION_HISTORY_LEN = 10;
const CALIBRATION_REQUIRED = 3; // short hold once a face is detected
const CALIBRATION_DECAY = 1; // only lose one step when face briefly lost
const GAZE_SAMPLE_SIZE = 10;
const GAZE_CONSECUTIVE_LIMIT = 4; // require more consecutive samples to trigger
const GAZE_THRESHOLD_X = 0.55; // stronger threshold for looking away
const GAZE_CONFIDENCE_MIN = 0.35;
let lastMotionAvg = 0;
// Teacher state
let editingExamId = null, qCount = 0;
// Disable answering when camera/exam is paused
let examInputsDisabled = false;

function setExamInputsDisabled(disabled){
  examInputsDisabled = !!disabled;
  try{
    ['btn-prev','btn-next','btn-submit'].forEach(id=>{ const b=document.getElementById(id); if(b) { b.disabled = disabled; b.style.opacity = disabled ? '0.6' : ''; } });
    document.querySelectorAll('#question-area textarea, #question-area input, #question-area select').forEach(el=>{ el.disabled = disabled; });
    // ensure overlay is visible when disabled
    const overlay = document.getElementById('camera-overlay');
    if(overlay){ overlay.style.display = disabled ? 'flex' : 'none'; const p = overlay.querySelector('p'); if(p) p.textContent = disabled ? (pauseReason || 'Camera paused') : ''; }
  }catch(e){ /* ignore UI update errors */ }
}

function loadData(){
  try{
    const d = localStorage.getItem(STORAGE_KEY);
    const parsed = d ? JSON.parse(d) : null;
    return {
      courses: parsed?.courses ?? [
        {id:'c1',name:'IT Fundamentals',code:'IT101',desc:'Basic computing concepts',icon:'IT'},
        {id:'c2',name:'Networking Basics',code:'NET102',desc:'Network fundamentals',icon:'NET'},
        {id:'c3',name:'Web Development',code:'WEB103',desc:'HTML, CSS, JavaScript',icon:'WEB'}
      ],
      exams: parsed?.exams ?? [],
      sessions: parsed?.sessions ?? [],
      studentJoins: parsed?.studentJoins ?? [],
      submissions: parsed?.submissions ?? [],
      liveEvents: parsed?.liveEvents ?? []
    };
  }catch(e){
    return {
      courses:[
        {id:'c1',name:'IT Fundamentals',code:'IT101',desc:'Basic computing concepts',icon:'IT'},
        {id:'c2',name:'Networking Basics',code:'NET102',desc:'Network fundamentals',icon:'NET'},
        {id:'c3',name:'Web Development',code:'WEB103',desc:'HTML, CSS, JavaScript',icon:'WEB'}
      ],
      exams:[],
      sessions:[],
      studentJoins:[],
      submissions:[],
      liveEvents:[],
      // legacy support: keep buffer if absent
      liveEventBuffer:[]
    };
  }
}
function saveData(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  window.dispatchEvent(new Event('lms-data-update'));
}
function handleRemoteDataUpdate(){
  data = loadData();
  if(currentRole==='teacher') renderTeacherDashboard();
  if(currentRole==='student') renderStudentDashboard();
}
window.addEventListener('storage', e => {
  if(e.key === STORAGE_KEY) handleRemoteDataUpdate();
});
window.addEventListener('lms-data-update', handleRemoteDataUpdate);
function toast(msg, d=2200){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), d);
}
function escHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ════════════════════════════════════════
// PROCTORVISION BACKEND (Flask + SQLite + Socket.IO)
// ════════════════════════════════════════
async function initBackend(role){
  try{
    const res = await fetch(`${BACKEND_URL}/api/health`);
    if(!res.ok) throw new Error('Backend unavailable');
    const health = await res.json();
    backendConnected = true;
    connectBackendSocket(role);
    if(role === 'teacher'){
      await refreshBackendLiveFeed();
      renderTeacherLiveFeed();
    }
    console.info('[ProctorVision]', health.service, 'connected', health.stack);
  }catch(e){
    backendConnected = false;
    console.warn('[ProctorVision] Backend offline — running in local-only mode');
  }
}

function connectBackendSocket(role){
  if(typeof io === 'undefined') return;
  if(backendSocket){ backendSocket.disconnect(); backendSocket = null; }
  backendSocket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });
  backendSocket.on('connect', ()=>{
    backendSocket.emit('join_role', { role });
  });
  backendSocket.on('live_event', ev=>{
    backendLiveEvents.unshift({ ...ev, time: ev.time || new Date().toISOString() });
    backendLiveEvents = backendLiveEvents.slice(0, 50);
    if(currentRole === 'teacher') renderTeacherLiveFeed();
  });
  backendSocket.on('score_update', sc=>{
    backendLiveScores[sc.student_name + '|' + sc.exam_id] = sc;
    if(currentRole === 'teacher') renderTeacherLiveFeed();
  });
  backendSocket.on('submission_alert', alert=>{
    backendLiveEvents.unshift({
      type: 'submission',
      student_name: alert.student_name,
      exam_title: alert.exam_title,
      details: `Submitted · ${alert.suspicion_score}% ${alert.risk_level} risk`,
      suspicion_score: alert.suspicion_score,
      time: new Date().toISOString(),
    });
    if(currentRole === 'teacher'){
      renderTeacherLiveFeed();
      toast(`ProctorVision: ${alert.student_name} submitted (${alert.suspicion_score}% risk)`);
    }
  });
  backendSocket.on('session_joined', info=>{
    backendLiveEvents.unshift({
      type: 'session_join',
      student_name: info.student_name,
      exam_title: info.exam_title,
      details: 'Joined monitored exam session',
      time: new Date().toISOString(),
    });
    if(currentRole === 'teacher') renderTeacherLiveFeed();
  });
}

async function refreshBackendLiveFeed(){
  if(!backendConnected) return;
  try{
    const res = await fetch(`${BACKEND_URL}/api/live/feed?limit=30`);
    if(!res.ok) return;
    const data = await res.json();
    backendLiveEvents = (data.events || []).map(ev=>({
      type: ev.event_type,
      student_name: ev.student_name,
      exam_id: ev.exam_id,
      details: ev.details,
      weight: ev.weight,
      suspicion_score: ev.suspicion_score,
      time: ev.created_at,
    }));
  }catch(e){ /* ignore */ }
}

function renderTeacherLiveFeed(){
  const liveFeed = document.getElementById('live-proctor-feed');
  if(!liveFeed) return;
  const backendStatus = document.getElementById('backend-status-pill');
  if(backendStatus){
    backendStatus.textContent = backendConnected ? 'Backend live' : 'Backend offline';
    backendStatus.className = 'pill ' + (backendConnected ? 'pill-green' : 'pill-yellow');
  }
  if(!backendLiveEvents.length){
    liveFeed.innerHTML = '<div class="empty-state" style="padding:1rem;box-shadow:none;background:transparent;border:none;color:var(--muted)"><div class="icon">Info</div><p>No live telemetry yet. Events appear here via Socket.IO when students take exams.</p></div>';
    return;
  }
  liveFeed.innerHTML = backendLiveEvents.slice(0, 12).map(ev=>{
    const score = ev.suspicion_score != null ? `<span style="font-weight:700;color:${ev.suspicion_score>=70?'#dc2626':ev.suspicion_score>=40?'#f59e0b':'#10b981'}">${ev.suspicion_score}%</span>` : '';
    return `<div style="padding:.85rem;border:1px solid var(--border);border-radius:10px;margin-bottom:.75rem;background:#f8fafc">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.35rem">
        <strong>${escHtml(ev.student_name||'Student')}</strong>
        <span style="font-size:.78rem;color:var(--muted)">${ev.time ? new Date(ev.time).toLocaleTimeString() : ''}</span>
      </div>
      <div style="font-size:.85rem;color:var(--text)">${escHtml(ev.type||'event')} ${score}</div>
      <div style="font-size:.78rem;color:var(--muted);margin-top:.25rem">${escHtml(ev.details||'')}</div>
    </div>`;
  }).join('');
}

async function backendJoinSession(exam){
  if(!backendConnected) return null;
  backendSessionId = 'sess_' + Date.now();
  try{
    await fetch(`${BACKEND_URL}/api/sessions/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: backendSessionId,
        exam_id: exam.id,
        exam_title: exam.title,
        student_name: STUDENT_NAME,
      }),
    });
    return backendSessionId;
  }catch(e){
    backendSessionId = null;
    return null;
  }
}

async function backendPostEvent(ev){
  if(!backendConnected || !backendSessionId || !activeExam) return;
  try{
    await fetch(`${BACKEND_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: backendSessionId,
        exam_id: activeExam.id,
        exam_title: activeExam.title,
        student_name: STUDENT_NAME,
        type: ev.type,
        details: ev.details,
        weight: ev.weight,
        time: ev.time,
      }),
    });
  }catch(e){ /* ignore */ }
}

async function backendSubmitExam(submissionId, score, total, pct){
  if(!backendConnected || !backendSessionId) return null;
  try{
    const res = await fetch(`${BACKEND_URL}/api/sessions/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: backendSessionId,
        submission_id: submissionId,
        score, total, pct,
      }),
    });
    if(!res.ok) return null;
    return await res.json();
  }catch(e){
    return null;
  }finally{
    backendSessionId = null;
  }
}

function getSubmissionSuspicion(sub){
  if(sub.backendScore != null) return sub.backendScore;
  return sub.proctorData ? sub.proctorData.score : 0;
}

async function fetchBackendReport(submissionId){
  if(!backendConnected) return null;
  try{
    const res = await fetch(`${BACKEND_URL}/api/submissions/${submissionId}/report`);
    if(!res.ok) return null;
    return await res.json();
  }catch(e){
    return null;
  }
}

function downloadBackendPdf(submissionId){
  const id = submissionId || currentReportSubmissionId;
  if(!id){ toast('No submission selected.'); return; }
  if(!backendConnected){ toast('Backend offline — cannot generate PDF.'); return; }
  window.open(`${BACKEND_URL}/api/submissions/${id}/pdf`, '_blank');
}

// ════════════════════════════════════════
// PORTAL SWITCHING
// ════════════════════════════════════════
function enterPortal(role){
  currentRole = role;
  data = loadData();
  document.getElementById('role-screen').style.display = 'none';
  const shell = document.getElementById('app-shell');
  shell.style.display = 'flex';

  if(role === 'admin'){
    // Theme
    document.documentElement.style.setProperty('--sidebar','#3f0f1f');
    document.documentElement.style.setProperty('--sidebar-hover','#5a1a31');
    document.documentElement.style.setProperty('--accent','#e11d48');
    document.documentElement.style.setProperty('--accent2','#dc2626');
    document.getElementById('topbar').style.background = '#3f0f1f';
    document.getElementById('portal-label').textContent = 'Admin Portal';
    document.getElementById('portal-label').style.color = '#fda4af';
    document.getElementById('user-avatar').textContent = 'AD';
    document.getElementById('user-avatar').style.background = '#e11d48';
    document.getElementById('user-name').textContent = 'System Administrator';
    buildAdminUI();
    navAdmin('dashboard', null);
    initBackend('admin');
  } else if(role === 'teacher'){
    // Theme
    document.documentElement.style.setProperty('--sidebar','#1a2744');
    document.documentElement.style.setProperty('--sidebar-hover','#243460');
    document.documentElement.style.setProperty('--accent','#2563eb');
    document.documentElement.style.setProperty('--accent2','#16a34a');
    document.getElementById('topbar').style.background = '#1a2744';
    document.getElementById('portal-label').textContent = 'Teacher Portal';
    document.getElementById('portal-label').style.color = '#93c5fd';
    document.getElementById('user-avatar').textContent = 'TR';
    document.getElementById('user-avatar').style.background = '#3b82f6';
    document.getElementById('user-name').textContent = 'Prof. Teacher';
    buildTeacherUI();
    navTeacher('dashboard', null);
    initBackend('teacher');
  } else {
    // Theme
    document.documentElement.style.setProperty('--sidebar','#0f4c35');
    document.documentElement.style.setProperty('--sidebar-hover','#1a6b4a');
    document.documentElement.style.setProperty('--accent','#16a34a');
    document.documentElement.style.setProperty('--accent2','#16a34a');
    document.getElementById('topbar').style.background = '#0f4c35';
    document.getElementById('portal-label').textContent = 'Student Portal';
    document.getElementById('portal-label').style.color = '#86efac';
    document.getElementById('user-avatar').textContent = 'JD';
    document.getElementById('user-avatar').style.background = '#16a34a';
    document.getElementById('user-name').textContent = 'Juan Dela Cruz';
    buildStudentUI();
    navStudent('dashboard', null);
    initBackend('student');
  }
}

function switchPortal(){
  data = loadData();
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('role-screen').style.display = 'flex';
  document.getElementById('sidebar').innerHTML = '';
  document.getElementById('main-content').innerHTML = '';
}

// ════════════════════════════════════════
// TEACHER UI
// ════════════════════════════════════════
function buildTeacherUI(){
  document.getElementById('sidebar').innerHTML = `
    <div class="section-label" style="color:#6b85b8">Main</div>
    <a href="#" class="active" style="color:#c7d2e8" onclick="return navTeacher('dashboard',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Dashboard</a>
    <a href="#" style="color:#c7d2e8" onclick="return navTeacher('courses',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>My Courses</a>
    <div class="section-label" style="color:#6b85b8">Assessments</div>
    <a href="#" style="color:#c7d2e8" onclick="return navTeacher('exams',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Exams &amp; Quizzes</a>
    <a href="#" style="color:#c7d2e8" onclick="return navTeacher('sessions',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18"/><path d="M7 7v14"/><path d="M17 7v14"/><path d="M3 21h18"/></svg>Monitored Exams</a>
    <a href="#" style="color:#c7d2e8" onclick="return navTeacher('results',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>Student Results</a>
    <div class="section-label" style="color:#6b85b8">Tools</div>
    <a href="#" style="color:#c7d2e8" onclick="return navTeacher('grades',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Grade Book</a>
    <a href="#" style="color:#c7d2e8" onclick="return navTeacher('students',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Students</a>
  `;
  // Apply active sidebar style
  document.querySelectorAll('#sidebar a').forEach(a=>{
    a.addEventListener('mouseenter',()=>{ if(!a.classList.contains('active')) a.style.background='#243460'; });
    a.addEventListener('mouseleave',()=>{ if(!a.classList.contains('active')) a.style.background=''; });
  });

  document.getElementById('main-content').innerHTML = `
    <!-- TEACHER DASHBOARD -->
    <div class="page active" id="page-dashboard">
      <div class="page-hdr"><div><h1>Good morning, Prof. Teacher</h1><p>Here's what's happening in your classes today.</p></div></div>
      <div class="stat-grid">
        <div class="stat-card"><div class="icon">Courses</div><div class="num" id="t-s-courses">0</div><div class="lbl">Active Courses</div></div>
        <div class="stat-card"><div class="icon">Assessments</div><div class="num" id="t-s-exams">0</div><div class="lbl">Published Assessments</div></div>
        <div class="stat-card"><div class="icon">Students</div><div class="num">28</div><div class="lbl">Total Students</div></div>
        <div class="stat-card"><div class="icon">Submissions</div><div class="num" id="t-s-submissions">0</div><div class="lbl">Submissions</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div class="card">
          <div class="card-title">Recent Activity</div>
          <div id="t-dash-activity">
            <div class="activity-item"><div class="act-icon blue">Note</div><div class="act-text"><div class="name">Course created: IT Fundamentals</div><div class="act-time">Today, 8:00 AM</div></div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Quick Stats</div>
          <div style="font-size:.85rem;color:var(--muted);margin-top:.5rem">
            <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Published exams</span><span id="qs-exams" style="font-weight:600;color:var(--text)">0</span></div>
            <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Draft assessments</span><span id="qs-drafts" style="font-weight:600;color:var(--text)">0</span></div>
            <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Avg. class score</span><span id="qs-avg" style="font-weight:600;color:var(--text)">—</span></div>
            <div style="display:flex;justify-content:space-between;padding:.4rem 0"><span>Pending submissions</span><span id="qs-pending" style="font-weight:600;color:var(--text)">0</span></div>
            <div style="display:flex;justify-content:space-between;padding:.4rem 0"><span>Suspicious submissions</span><span id="qs-suspicious" style="font-weight:600;color:var(--text)">0</span></div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>ProctorVision Live Watch</span>
          <span id="backend-status-pill" class="pill pill-yellow" style="font-size:.72rem">Checking…</span>
        </div>
          <div id="live-proctor-feed" style="font-size:.85rem;color:var(--muted);margin-top:.75rem">
          <div class="empty-state" style="padding:1rem;box-shadow:none;background:transparent;border:none;color:var(--muted)"><div class="icon">Info</div><p>No suspicious activity recorded yet.</p></div>
        </div>
      </div>
    </div>

    <!-- COURSES -->
    <div class="page" id="page-courses">
      <div class="page-hdr"><div><h1>My Courses</h1><p>Manage your course sections</p></div><button class="btn btn-primary" onclick="openCourseModal()">New Course</button></div>
      <div class="course-grid" id="course-grid"></div>
    </div>

    <!-- EXAMS -->
    <div class="page" id="page-exams">
      <div class="page-hdr"><div><h1>Exams &amp; Quizzes</h1><p>Create and publish assessments for your students</p></div><button class="btn btn-primary" onclick="openExamModal()">Create Assessment</button></div>
      <div class="card"><table><thead><tr><th>Title</th><th>Type</th><th>Course</th><th>Questions</th><th>Time Limit</th><th>Status</th><th>Actions</th></tr></thead><tbody id="exam-tbody"></tbody></table></div>
    </div>

    <!-- SESSIONS -->
    <div class="page" id="page-sessions">
      <div class="page-hdr"><div><h1>Monitored Exams</h1><p>Published exams that are being monitored in real time.</p></div></div>
      <div class="card"><table><thead><tr><th>Exam</th><th>Course</th><th>Published</th><th>Students</th><th>Actions</th></tr></thead><tbody id="session-tbody"></tbody></table></div>
    </div>

    <!-- RESULTS -->
    <div class="page" id="page-results">
      <div class="page-hdr"><div><h1>Student Results</h1><p>Review submissions and scores</p></div></div>
      <div class="card"><table><thead><tr><th>Student</th><th>Assessment</th><th>Score</th><th>Submitted</th><th>Suspicion</th><th>Status</th><th>Actions</th></tr></thead><tbody id="t-results-tbody"></tbody></table></div>
    </div>

    <!-- GRADES -->
    <div class="page" id="page-grades">
      <div class="page-hdr"><div><h1>Grade Book</h1><p>Overview of student performance</p></div></div>
      <div class="card"><div id="grade-content"><div class="empty-state"><div class="icon">Info</div><p>No graded submissions yet.</p></div></div></div>
    </div>

    <!-- STUDENTS -->
    <div class="page" id="page-students">
      <div class="page-hdr"><div><h1>Students</h1><p>Enrolled students across all courses</p></div></div>
      <div class="card"><table><thead><tr><th>#</th><th>Name</th><th>Student ID</th><th>Course</th><th>Submissions</th></tr></thead>
      <tbody id="student-tbody">
        <tr><td>1</td><td>Juan Dela Cruz</td><td>2024-0001</td><td>IT Fundamentals</td><td id="sub-count-jd">0</td></tr>
        <tr><td>2</td><td>Maria Santos</td><td>2024-0002</td><td>IT Fundamentals</td><td>0</td></tr>
        <tr><td>3</td><td>Pedro Reyes</td><td>2024-0003</td><td>Networking Basics</td><td>0</td></tr>
        <tr><td>4</td><td>Ana Lim</td><td>2024-0004</td><td>Web Development</td><td>0</td></tr>
      </tbody></table></div>
    </div>
  `;
}

function navTeacher(page, el){
  data = loadData();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('#sidebar a').forEach(a=>{ a.classList.remove('active'); a.style.background=''; });
  document.getElementById('page-'+page).classList.add('active');
  if(el){ el.classList.add('active'); el.style.background='#243460'; }
  if(page==='dashboard') renderTeacherDashboard();
  if(page==='courses') renderCourses();
  if(page==='exams') renderExams();
  if(page==='sessions') renderTeacherSessions();
  if(page==='results') renderTeacherResults();
  if(page==='grades') renderGrades();
  return false;
}

function renderTeacherDashboard(){
  const pub = data.exams.filter(e=>e.status==='published').length;
  const drafts = data.exams.filter(e=>e.status==='draft').length;
  const subs = data.submissions.length;
  document.getElementById('t-s-courses').textContent = data.courses.length;
  document.getElementById('t-s-exams').textContent = pub;
  document.getElementById('t-s-submissions').textContent = subs;
  document.getElementById('qs-exams').textContent = pub;
  document.getElementById('qs-drafts').textContent = drafts;
  document.getElementById('qs-pending').textContent = subs;
  if(subs>0){
    const avg = Math.round(data.submissions.reduce((a,s)=>a+s.pct,0)/subs);
    document.getElementById('qs-avg').textContent = avg+'%';
  }
  const suspiciousCount = data.submissions.filter(s=>getSubmissionSuspicion(s) >= 40).length;
  const suspiciousEl = document.getElementById('qs-suspicious');
  if(suspiciousEl) suspiciousEl.textContent = suspiciousCount;
  renderTeacherLiveFeed();
  const jdSubs = data.submissions.filter(s=>s.studentName===STUDENT_NAME).length;
  const el = document.getElementById('sub-count-jd');
  if(el) el.textContent = jdSubs;
}

function renderCourses(){
  const g = document.getElementById('course-grid');
  if(!data.courses.length){ g.innerHTML='<div class="empty-state" style="grid-column:1/-1"><div class="icon">Info</div><p>No courses yet. Create one!</p></div>'; return; }
  const colors = ['#dbeafe','#dcfce7','#fef9c3','#fce7f3','#e0e7ff'];
  g.innerHTML = data.courses.map((c,i)=>`
    <div class="course-card">
      <div class="cc-banner" style="background:${colors[i%colors.length]}">${c.icon||'Course'}</div>
      <div class="cc-body"><div class="cc-title">${c.name}</div><div class="cc-sub">${c.code||''} ${c.desc?'· '+c.desc:''}</div></div>
      <div class="cc-foot">
        <span style="font-size:.75rem;color:var(--muted)">${data.exams.filter(e=>e.course===c.id).length} assessments</span>
        <button class="btn btn-ghost btn-sm" onclick="deleteCourse('${c.id}')">Delete</button>
      </div>
    </div>`).join('');
}

function openCourseModal(){ document.getElementById('course-modal').classList.add('show'); }
function saveCourse(){
  const name = document.getElementById('c-name').value.trim();
  if(!name){ alert('Course name required'); return; }
  const course = {id:'c'+Date.now(),name,code:document.getElementById('c-code').value.trim(),desc:document.getElementById('c-desc').value.trim(),icon:document.getElementById('c-icon').value};
  data.courses.push(course); saveData();
  document.getElementById('course-modal').classList.remove('show');
  ['c-name','c-code','c-desc'].forEach(id=>document.getElementById(id).value='');
  renderCourses(); toast('Course created!');
}
function deleteCourse(id){
  if(!confirm('Delete this course?')) return;
  data.courses = data.courses.filter(c=>c.id!==id);
  data.exams = data.exams.filter(e=>e.course!==id);
  saveData(); renderCourses(); toast('Course deleted');
}

function renderExams(){
  const tb = document.getElementById('exam-tbody');
  if(!data.exams.length){ tb.innerHTML='<tr><td colspan="7"><div class="empty-state"><div class="icon">Info</div><p>No assessments yet. Create one!</p></div></td></tr>'; return; }
  tb.innerHTML = data.exams.map(e=>{
    const course = data.courses.find(c=>c.id===e.course);
    return `<tr>
      <td><strong>${e.title}</strong></td>
      <td><span class="pill pill-blue">${e.type}</span></td>
      <td>${course?course.name:'—'}</td>
      <td>${e.questions.length} Qs</td>
      <td>${e.timeLimit?e.timeLimit+' min':'—'}</td>
      <td><span class="pill ${e.status==='published'?'pill-green':'pill-yellow'}">${e.status}</span></td>
      <td style="display:flex;gap:.4rem;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="editExam('${e.id}')">Edit</button>
        ${e.status==='draft'
          ?`<button class="btn btn-success btn-sm" onclick="publishExam('${e.id}')">Publish</button>`
          :`<button class="btn btn-ghost btn-sm" onclick="unpublishExam('${e.id}')">Unpublish</button>`}
        <button class="btn btn-danger btn-sm" onclick="deleteExam('${e.id}')">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function openExamModal(){
  editingExamId = null;
  document.getElementById('exam-modal-title').textContent = 'Create Assessment';
  ['exam-title','exam-time','exam-instructions'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('exam-type').value = 'exam';
  document.getElementById('questions-container').innerHTML = '';
  qCount = 0;
  const sel = document.getElementById('exam-course');
  sel.innerHTML = '<option value="">Select course...</option>'+data.courses.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('exam-modal').classList.add('show');
  addQuestion();
}

function editExam(id){
  const exam = data.exams.find(e=>e.id===id); if(!exam) return;
  editingExamId = id;
  document.getElementById('exam-modal-title').textContent = 'Edit Assessment';
  document.getElementById('exam-title').value = exam.title;
  document.getElementById('exam-type').value = exam.type;
  document.getElementById('exam-time').value = exam.timeLimit||'';
  document.getElementById('exam-instructions').value = exam.instructions||'';
  const sel = document.getElementById('exam-course');
  sel.innerHTML = '<option value="">Select course...</option>'+data.courses.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  sel.value = exam.course||'';
  const qc = document.getElementById('questions-container'); qc.innerHTML=''; qCount=0;
  exam.questions.forEach(q=>addQuestion(q));
  document.getElementById('exam-modal').classList.add('show');
}

function closeExamModal(){ document.getElementById('exam-modal').classList.remove('show'); editingExamId=null; }

function addQuestion(existing){
  qCount++;
  const qi = qCount;
  const qc = document.getElementById('questions-container');
  const div = document.createElement('div'); div.className='q-card'; div.id='q-'+qi;
  div.innerHTML = `
    <div class="q-hdr"><span class="q-num">Question ${qi}</span><button class="btn btn-ghost btn-sm" onclick="removeQ(${qi})">Remove</button></div>
    <div class="form-group"><label>Question Text</label><input type="text" id="qt-${qi}" placeholder="Enter question..." value="${existing?escHtml(existing.text):''}"/></div>
    <div class="form-group"><label>Type</label>
      <select id="qtype-${qi}" onchange="renderChoices(${qi})">
        <option value="mcq"${existing&&existing.qtype==='mcq'?' selected':''}>Multiple Choice</option>
        <option value="tf"${existing&&existing.qtype==='tf'?' selected':''}>True / False</option>
        <option value="short"${existing&&existing.qtype==='short'?' selected':''}>Short Answer</option>
      </select>
    </div>
    <div id="choices-${qi}"></div>
    <div class="form-group"><label>Points</label><input type="number" id="qpts-${qi}" value="${existing?existing.points:1}" min="1" style="width:80px"/></div>
  `;
  qc.appendChild(div);
  renderChoices(qi, existing);
}

function renderChoices(qi, existing){
  const type = document.getElementById('qtype-'+qi).value;
  const cont = document.getElementById('choices-'+qi);
  if(type==='mcq'){
    const choices = existing&&existing.qtype==='mcq'?existing.choices:['','','',''];
    const correct = existing&&existing.qtype==='mcq'?existing.correct:0;
    cont.innerHTML = '<div style="font-size:.82rem;font-weight:500;margin-bottom:.4rem">Choices <small style="color:var(--muted)">(select the correct answer)</small></div>'+
      choices.map((c,i)=>`<div class="choice-row"><input type="radio" name="correct-${qi}" value="${i}"${i===correct?' checked':''}><input type="text" id="qc${qi}-${i}" placeholder="Choice ${String.fromCharCode(65+i)}" value="${escHtml(c)}"/></div>`).join('');
  }else if(type==='tf'){
    const correct = existing&&existing.qtype==='tf'?existing.correct:'true';
    cont.innerHTML = `<div style="display:flex;gap:1rem;font-size:.85rem"><label><input type="radio" name="correct-${qi}" value="true"${correct==='true'?' checked':''}/> True</label><label><input type="radio" name="correct-${qi}" value="false"${correct==='false'?' checked':''}/> False</label></div>`;
  }else{
    cont.innerHTML = '<div style="font-size:.78rem;color:var(--muted)">Students will type their answer.</div>';
  }
}

function removeQ(qi){ const el=document.getElementById('q-'+qi); if(el) el.remove(); }

function saveExam(status){
  const title = document.getElementById('exam-title').value.trim();
  const course = document.getElementById('exam-course').value;
  if(!title){ alert('Please enter a title.'); return; }
  if(!course){ alert('Please select a course.'); return; }
  const questions = [];
  document.querySelectorAll('.q-card').forEach(card=>{
    const qi = card.id.replace('q-','');
    const text = document.getElementById('qt-'+qi)?.value.trim();
    const qtype = document.getElementById('qtype-'+qi)?.value;
    const points = parseInt(document.getElementById('qpts-'+qi)?.value)||1;
    if(!text) return;
    let q = {text,qtype,points};
    if(qtype==='mcq'){
      q.choices = [0,1,2,3].map(i=>document.getElementById('qc'+qi+'-'+i)?.value.trim()||'');
      const r = card.querySelector('input[name="correct-'+qi+'"]:checked');
      q.correct = r?parseInt(r.value):0;
    }else if(qtype==='tf'){
      const r = card.querySelector('input[name="correct-'+qi+'"]:checked');
      q.correct = r?r.value:'true';
    }
    questions.push(q);
  });
  if(!questions.length&&status==='published'){ alert('Add at least one question.'); return; }
  const exam = {
    id:editingExamId||'e'+Date.now(), title,
    type:document.getElementById('exam-type').value, course,
    timeLimit:document.getElementById('exam-time').value,
    instructions:document.getElementById('exam-instructions').value,
    questions, status, createdAt:new Date().toISOString()
  };
  if(editingExamId){ data.exams = data.exams.map(e=>e.id===editingExamId?exam:e); }
  else{ data.exams.push(exam); }
  saveData(); closeExamModal(); renderExams(); renderTeacherDashboard();
  toast(status==='published'?'Assessment published! Students can now take it.':'Saved as draft.');
}

function publishExam(id){
  const e = data.exams.find(e=>e.id===id); if(!e) return;
  e.status = 'published';
  // Enable monitoring for this exam (automatic on open)
  e.monitor = true;
  saveData(); renderExams(); renderTeacherDashboard(); renderTeacherSessions();
  toast('Assessment published and monitoring enabled.');
}
function unpublishExam(id){ const e=data.exams.find(e=>e.id===id); if(!e) return; e.status='draft'; saveData(); renderExams(); renderTeacherDashboard(); toast('Assessment unpublished.'); }
function deleteExam(id){ if(!confirm('Delete this assessment?')) return; data.exams=data.exams.filter(e=>e.id!==id); data.submissions=data.submissions.filter(s=>s.examId!==id); saveData(); renderExams(); renderTeacherDashboard(); toast('Deleted.'); }

function renderTeacherResults(){
  const tb = document.getElementById('t-results-tbody');
  if(!data.submissions.length){ tb.innerHTML='<tr><td colspan="7"><div class="empty-state"><div class="icon">Info</div><p>No submissions yet.</p></div></td></tr>'; return; }
  tb.innerHTML = data.submissions.map(s=>{
    const exam = data.exams.find(e=>e.id===s.examId);
    const pct = s.pct||0;
    const suspicion = getSubmissionSuspicion(s);
    const riskClass = suspicion>=70 ? 'pill-red' : suspicion>=40 ? 'pill-yellow' : 'pill-green';
    const riskLabel = suspicion>=70 ? 'High' : suspicion>=40 ? 'Moderate' : 'Low';
    return `<tr>
      <td>${s.studentName||'Student'}</td>
      <td>${exam?exam.title:'Unknown'}</td>
      <td><div>${s.score}/${s.total} <span style="color:var(--muted);font-size:.8rem">(${pct}%)</span></div><div class="score-bar"><div class="score-fill" style="width:${pct}%"></div></div></td>
      <td style="font-size:.8rem;color:var(--muted)">${new Date(s.submittedAt).toLocaleString()}</td>
      <td><span class="pill ${riskClass}">${suspicion}% ${riskLabel}</span></td>
      <td><span class="pill ${pct>=75?'pill-green':pct>=50?'pill-yellow':'pill-red'}">${pct>=75?'Passed':'Failed'}</span></td>
      <td><button class="btn btn-ghost btn-sm" onclick="openProctorReport('${s.id}')">View Report</button>
        <button class="btn btn-ghost btn-sm" onclick="downloadBackendPdf('${s.id}')">PDF</button></td>
    </tr>`;
  }).join('');
}

function renderGrades(){
  const gc = document.getElementById('grade-content');
  if(!data.submissions.length){ gc.innerHTML='<div class="empty-state"><div class="icon">Info</div><p>No graded submissions yet.</p></div>'; return; }
  const byExam = {};
  data.submissions.forEach(s=>{ if(!byExam[s.examId]) byExam[s.examId]=[]; byExam[s.examId].push(s); });
  gc.innerHTML = Object.entries(byExam).map(([eid,subs])=>{
    const exam = data.exams.find(e=>e.id===eid);
    const avg = Math.round(subs.reduce((a,s)=>a+s.pct,0)/subs.length);
    return `<div style="margin-bottom:1.25rem">
      <div style="font-weight:600;margin-bottom:.6rem">${exam?exam.title:'Unknown'} <span style="font-size:.78rem;color:var(--muted)">${subs.length} submission(s) · Avg: ${avg}%</span></div>
      <table><thead><tr><th>Student</th><th>Score</th><th>%</th></tr></thead><tbody>
      ${subs.map(s=>`<tr><td>${s.studentName}</td><td>${s.score}/${s.total}</td><td>${s.pct}%</td></tr>`).join('')}
      </tbody></table></div>`;
  }).join('');
}

// ════════════════════════════════════════
// STUDENT UI
// ════════════════════════════════════════
function buildStudentUI(){
  document.getElementById('sidebar').innerHTML = `
    <div class="section-label" style="color:#6ba88a">Main</div>
    <a href="#" class="active" style="color:#a7d9c0" onclick="return navStudent('dashboard',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Dashboard</a>
    <a href="#" style="color:#a7d9c0" onclick="return navStudent('courses',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>My Courses</a>
    <div class="section-label" style="color:#6ba88a">Assessments</div>
    <!-- Enter Session removed: exams auto-join when opened -->
    <a href="#" style="color:#a7d9c0" onclick="return navStudent('exams',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Available Exams</a>
    <a href="#" style="color:#a7d9c0" onclick="return navStudent('results',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>My Results</a>
    <div class="section-label" style="color:#6ba88a">More</div>
    <a href="#" style="color:#a7d9c0" onclick="return navStudent('profile',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>My Profile</a>
  `;

  document.getElementById('main-content').innerHTML = `
    <!-- STUDENT DASHBOARD -->
    <div class="page active" id="page-dashboard">
      <div class="page-hdr"><div><h1>Welcome back, Juan!</h1><p>Here's your academic overview.</p></div></div>
      <div class="stat-grid">
        <div class="stat-card"><div class="icon">Courses</div><div class="num" id="sd-courses">3</div><div class="lbl">Enrolled Courses</div></div>
        <div class="stat-card"><div class="icon">Assessments</div><div class="num" id="sd-available">0</div><div class="lbl">Available Assessments</div></div>
        <div class="stat-card"><div class="icon">Completed</div><div class="num" id="sd-done">0</div><div class="lbl">Completed</div></div>
        <div class="stat-card"><div class="icon">Avg</div><div class="num" id="sd-avg">—</div><div class="lbl">Avg. Score</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div class="card"><div class="card-title">Pending Assessments</div><div id="dash-pending"></div></div>
        <div class="card"><div class="card-title">Recent Scores</div><div id="dash-scores"></div></div>
      </div>
    </div>

    <!-- Session join removed: exams auto-join when opened -->

    <!-- COURSES -->
    <div class="page" id="page-courses">
      <div class="page-hdr"><div><h1>My Courses</h1><p>Your enrolled courses this semester</p></div></div>
      <div class="course-grid" id="s-course-grid"></div>
    </div>

    <!-- AVAILABLE EXAMS -->
    <div class="page" id="page-exams">
      <div class="page-hdr"><div><h1>Available Assessments</h1><p>Exams and quizzes published by your teachers</p></div></div>
      <div class="card"><table><thead><tr><th>Title</th><th>Type</th><th>Course</th><th>Questions</th><th>Time Limit</th><th>Status</th><th>Action</th></tr></thead><tbody id="avail-tbody"></tbody></table></div>
    </div>

    <!-- RESULTS -->
    <div class="page" id="page-results">
      <div class="page-hdr"><div><h1>My Results</h1><p>Your submission history and scores</p></div></div>
      <div class="card"><table><thead><tr><th>Assessment</th><th>Course</th><th>Score</th><th>Submitted</th><th>Result</th></tr></thead><tbody id="s-results-tbody"></tbody></table></div>
    </div>

    <!-- PROFILE -->
    <div class="page" id="page-profile">
      <div class="page-hdr"><div><h1>My Profile</h1></div></div>
      <div class="card" style="max-width:480px">
        <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
          <div style="width:60px;height:60px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:700;color:#16a34a">JD</div>
          <div><div style="font-weight:600;font-size:1.05rem">Juan Dela Cruz</div><div style="color:var(--muted);font-size:.85rem">Student · IT Fundamentals</div></div>
        </div>
        <div style="display:grid;gap:.85rem;font-size:.86rem">
          <div style="display:flex;justify-content:space-between;padding:.55rem 0;border-bottom:1px solid var(--border)"><span style="color:var(--muted)">Student ID</span><span style="font-weight:500">2024-0001</span></div>
          <div style="display:flex;justify-content:space-between;padding:.55rem 0;border-bottom:1px solid var(--border)"><span style="color:var(--muted)">Email</span><span>juan.delacruz@student.usa.edu.ph</span></div>
          <div style="display:flex;justify-content:space-between;padding:.55rem 0;border-bottom:1px solid var(--border)"><span style="color:var(--muted)">Course</span><span>BS Information Technology</span></div>
          <div style="display:flex;justify-content:space-between;padding:.55rem 0"><span style="color:var(--muted)">Year Level</span><span>1st Year</span></div>
        </div>
      </div>
    </div>
  `;
}

function navStudent(page, el){
  data = loadData();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('#sidebar a').forEach(a=>{ a.classList.remove('active'); a.style.background=''; });
  document.getElementById('page-'+page).classList.add('active');
  if(el){ el.classList.add('active'); el.style.background='#1a6b4a'; }
  if(page==='dashboard') renderStudentDashboard();
  if(page==='courses') renderStudentCourses();
  // session page removed; monitoring is automatic when a student opens an exam
  if(page==='exams') renderAvailableExams();
  if(page==='results') renderStudentResults();
  return false;
}

function getJoinedSession(){
  return (data.studentJoins||[]).find(j=>j.studentName===STUDENT_NAME && j.status==='joined');
}
function getMyExams(){
  // Return all published exams for student's enrolled courses.
  return data.exams.filter(e=>e.status==='published' && STUDENT_COURSES.includes(e.course));
}
function getMySubmissions(){ return data.submissions.filter(s=>s.studentName===STUDENT_NAME); }
function hasSubmitted(examId){ return getMySubmissions().some(s=>s.examId===examId); }

function renderStudentDashboard(){
  const myExams = getMyExams(), mySubs = getMySubmissions();
  const pending = myExams.filter(e=>!hasSubmitted(e.id));
  document.getElementById('sd-available').textContent = myExams.length;
  document.getElementById('sd-done').textContent = mySubs.length;
  if(mySubs.length){
    const avg = Math.round(mySubs.reduce((a,s)=>a+s.pct,0)/mySubs.length);
    document.getElementById('sd-avg').textContent = avg+'%';
  }
  const pendingCard = document.getElementById('dash-pending');
  if(!myExams.length){
    pendingCard.innerHTML = '<div class="empty-state" style="padding:1.5rem"><div class="icon">Info</div><p>No assessments are available at the moment.</p></div>';
  } else if(!pending.length){
    pendingCard.innerHTML = '<div class="empty-state" style="padding:1.5rem"><div class="icon">Info</div><p>All caught up for the current exams!</p></div>';
  } else {
    pendingCard.innerHTML = pending.slice(0,4).map(e=>{
      const course = data.courses.find(c=>c.id===e.course);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:.55rem 0;border-bottom:1px solid var(--border)">
        <div><div style="font-size:.85rem;font-weight:500">${e.title}</div><div style="font-size:.75rem;color:var(--muted)">${course?course.name:''} · ${e.questions.length} questions</div></div>
        <button class="btn btn-primary btn-sm" onclick="openExamIntro('${e.id}')">Take Exam</button>
      </div>`;
    }).join('');
  }
  const ds = document.getElementById('dash-scores');
  if(!mySubs.length){ ds.innerHTML='<div class="empty-state" style="padding:1.5rem"><div class="icon">Info</div><p>No scores yet.</p></div>'; }
  else{
    ds.innerHTML = mySubs.slice(-4).reverse().map(s=>{
      const exam = data.exams.find(e=>e.id===s.examId);
      return `<div style="padding:.55rem 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;font-size:.84rem"><span style="font-weight:500">${exam?exam.title:'Exam'}</span><span style="color:${s.pct>=75?'var(--accent2)':'var(--warn)'};font-weight:600">${s.pct}%</span></div>
        <div class="score-bar"><div class="score-fill" style="width:${s.pct}%"></div></div>
      </div>`;
    }).join('');
  }
}

function renderStudentCourses(){
  const g = document.getElementById('s-course-grid');
  const myCourses = data.courses.filter(c=>STUDENT_COURSES.includes(c.id));
  const colors = ['#dbeafe','#dcfce7','#fef9c3'];
  g.innerHTML = myCourses.map((c,i)=>{
    const exams = getMyExams().filter(e=>e.course===c.id);
    const done = exams.filter(e=>hasSubmitted(e.id)).length;
    return `<div class="course-card-s">
      <div class="cc-banner" style="background:${colors[i%colors.length]}">${c.icon||'Course'}</div>
      <div class="cc-body">
        <div class="cc-title">${c.name}</div><div class="cc-sub">${c.code||''}</div>
        <div style="margin-top:.65rem">
          <div style="font-size:.75rem;color:var(--muted);margin-bottom:.3rem">${done}/${exams.length} assessments done</div>
          <div class="progress-bar"><div class="progress-fill" style="width:${exams.length?Math.round(done/exams.length*100):0}%"></div></div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderTeacherSessions(){
  const tb = document.getElementById('session-tbody');
  const exams = data.exams.filter(e=>e.status==='published');
  const joins = data.studentJoins || [];
  if(!exams.length){ tb.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="icon">Info</div><p>No published exams to monitor yet.</p></div></td></tr>'; return; }
  tb.innerHTML = exams.map(e=>{
    const course = data.courses.find(c=>c.id===e.course);
    const joinedCount = joins.filter(j=>j.examId===e.id && j.status==='joined').length;
    return `<tr>
      <td><strong>${escHtml(e.title)}</strong></td>
      <td>${course?escHtml(course.name):'—'}</td>
      <td>${new Date(e.createdAt).toLocaleDateString()}</td>
      <td>${joinedCount}</td>
      <td style="display:flex;gap:.4rem;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="openExamMonitor('${e.id}')">Monitor</button>
      </td>
    </tr>`;
  }).join('');
}

function openSessionModal(){ toast('Session workflow removed; monitoring is automatic on publish.'); }

function closeSessionModal(){ toast('Session modal removed.'); }
function saveSession(){ toast('Session workflow removed; monitoring is automatic on publish.'); }

function deleteSession(id){ toast('Session deletion removed; monitoring is exam-based now.'); }

function getSessionByCode(code){ return null; }
function joinSession(){ toast('Joining sessions removed; exams auto-join when you open them.'); }

function leaveSession(){ toast('Leaving sessions removed; monitoring is automatic.'); }

function renderStudentSession(){ /* no-op: session page removed; exam monitoring is automatic */ }

function renderAvailableExams(){
  const tb = document.getElementById('avail-tbody');
  const myExams = getMyExams();
  if(!myExams.length){ tb.innerHTML='<tr><td colspan="7"><div class="empty-state"><div class="icon">Info</div><p>No assessments are currently published.</p></div></td></tr>'; return; }
  tb.innerHTML = myExams.map(e=>{
    const course = data.courses.find(c=>c.id===e.course);
    const done = hasSubmitted(e.id);
    return `<tr>
      <td><strong>${e.title}</strong></td>
      <td><span class="pill pill-blue">${e.type}</span></td>
      <td>${course?course.name:'—'}</td>
      <td>${e.questions.length} Qs</td>
      <td>${e.timeLimit?e.timeLimit+' min':'No limit'}</td>
      <td>${done?'<span class="pill pill-green">✓ Done</span>':'<span class="pill pill-yellow">Pending</span>'}</td>
      <td>${done
        ?`<button class="btn btn-ghost btn-sm" disabled style="opacity:.5">Submitted</button>`
        :`<button class="btn btn-primary btn-sm" onclick="openExamIntro('${e.id}')">Take Exam</button>`}</td>
    </tr>`;
  }).join('');
}

function renderStudentResults(){
  const tb = document.getElementById('s-results-tbody');
  const mySubs = getMySubmissions();
  if(!mySubs.length){ tb.innerHTML='<tr><td colspan="5"><div class="empty-state"><div class="icon">Info</div><p>No submissions yet.</p></div></td></tr>'; return; }
  tb.innerHTML = mySubs.slice().reverse().map(s=>{
    const exam = data.exams.find(e=>e.id===s.examId);
    const course = exam?data.courses.find(c=>c.id===exam.course):null;
    return `<tr>
      <td><strong>${exam?exam.title:'Exam'}</strong></td>
      <td>${course?course.name:'—'}</td>
      <td><div>${s.score}/${s.total} <span style="color:var(--muted);font-size:.8rem">(${s.pct}%)</span></div><div class="score-bar"><div class="score-fill" style="width:${s.pct}%;background:${s.pct>=75?'var(--accent2)':'var(--warn)'}"></div></div></td>
      <td style="font-size:.8rem;color:var(--muted)">${new Date(s.submittedAt).toLocaleString()}</td>
      <td><span class="pill ${s.pct>=75?'pill-green':'pill-red'}">${s.pct>=75?'Passed':'Failed'}</span></td>
    </tr>`;
  }).join('');
}

// ════════════════════════════════════════
// ADMIN UI
// ════════════════════════════════════════
function buildAdminUI(){
  document.getElementById('sidebar').innerHTML = `
    <div class="section-label" style="color:#f5a6bb">System</div>
    <a href="#" class="active" style="color:#fbcfe8" onclick="return navAdmin('dashboard',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Dashboard</a>
    <a href="#" style="color:#fbcfe8" onclick="return navAdmin('users',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>User Management</a>
    <a href="#" style="color:#fbcfe8" onclick="return navAdmin('courses',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>Courses</a>
    <a href="#" style="color:#fbcfe8" onclick="return navAdmin('exams',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>All Assessments</a>
    <div class="section-label" style="color:#f5a6bb">Monitoring</div>
    <a href="#" style="color:#fbcfe8" onclick="return navAdmin('sessions',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18"/><path d="M7 7v14"/><path d="M17 7v14"/><path d="M3 21h18"/></svg>Active Sessions</a>
    <a href="#" style="color:#fbcfe8" onclick="return navAdmin('submissions',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>Submissions</a>
    <a href="#" style="color:#fbcfe8" onclick="return navAdmin('events',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>Audit Log</a>
    <div class="section-label" style="color:#f5a6bb">Settings</div>
    <a href="#" style="color:#fbcfe8" onclick="return navAdmin('settings',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m5.08 0l4.24-4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m5.08 0l4.24 4.24"/></svg>System Settings</a>
    <a href="#" style="color:#fbcfe8" onclick="return navAdmin('reports',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3z"/><path d="M9 9h6v6H9z"/><line x1="9" y1="5" x2="9" y2="3"/><line x1="15" y1="5" x2="15" y2="3"/></svg>Reports</a>
  `;

  document.getElementById('main-content').innerHTML = `
    <!-- ADMIN DASHBOARD -->
    <div class="page active" id="page-dashboard">
      <div class="page-hdr"><div><h1>System Dashboard</h1><p>ProctorVision Administration & Control</p></div></div>
      <div class="stat-grid">
        <div class="stat-card"><div class="icon">Users</div><div class="num" id="a-stat-users">0</div><div class="lbl">Total Users</div></div>
        <div class="stat-card"><div class="icon">Courses</div><div class="num" id="a-stat-courses">0</div><div class="lbl">Active Courses</div></div>
        <div class="stat-card"><div class="icon">Assessments</div><div class="num" id="a-stat-exams">0</div><div class="lbl">Total Assessments</div></div>
        <div class="stat-card"><div class="icon">Sessions</div><div class="num" id="a-stat-sessions">0</div><div class="lbl">Active Sessions</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div class="card">
          <div class="card-title">System Status</div>
          <div style="font-size:.85rem;color:var(--muted);margin-top:.5rem">
            <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Backend Status</span><span id="a-backend-status" class="pill pill-green" style="font-size:.72rem">Online</span></div>
            <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Database</span><span class="pill pill-green" style="font-size:.72rem">Connected</span></div>
            <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Proctoring Engine</span><span id="a-proctor-status" class="pill pill-green" style="font-size:.72rem">Active</span></div>
            <div style="display:flex;justify-content:space-between;padding:.4rem 0"><span>API Endpoints</span><span class="pill pill-green" style="font-size:.72rem">Operational</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Quick Actions</div>
          <div style="display:flex;flex-direction:column;gap:.5rem;margin-top:.5rem">
            <button class="btn btn-primary" onclick="navAdmin('users',null);return false" style="justify-content:center">Create New User</button>
            <button class="btn btn-primary" onclick="navAdmin('courses',null);return false" style="justify-content:center">Manage Courses</button>
            <button class="btn btn-primary" onclick="navAdmin('exams',null);return false" style="justify-content:center">View All Assessments</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Recent Activity</div>
        <div id="admin-activity" style="font-size:.85rem;color:var(--muted)">
          <div style="padding:1rem;text-align:center">System initialized</div>
        </div>
      </div>
    </div>

    <!-- USER MANAGEMENT -->
    <div class="page" id="page-users">
      <div class="page-hdr"><div><h1>User Management</h1><p>Create, edit, and delete system users</p></div><button class="btn btn-primary" onclick="openAdminUserModal('new')">Add New User</button></div>
      <div class="card"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody id="admin-users-tbody"></tbody></table></div>
    </div>

    <!-- COURSES -->
    <div class="page" id="page-courses">
      <div class="page-hdr"><div><h1>Course Management</h1><p>Manage all courses in the system</p></div><button class="btn btn-primary" onclick="openAdminCourseModal('new')">Add Course</button></div>
      <div class="card"><table><thead><tr><th>Code</th><th>Name</th><th>Description</th><th>Students</th><th>Exams</th><th>Actions</th></tr></thead><tbody id="admin-courses-tbody"></tbody></table></div>
    </div>

    <!-- EXAMS -->
    <div class="page" id="page-exams">
      <div class="page-hdr"><div><h1>Assessment Management</h1><p>View and manage all assessments</p></div><button class="btn btn-primary" onclick="navTeacher('exams',null)">Create New Assessment</button></div>
      <div class="card"><table><thead><tr><th>Title</th><th>Course</th><th>Type</th><th>Questions</th><th>Status</th><th>Created By</th><th>Actions</th></tr></thead><tbody id="admin-exams-tbody"></tbody></table></div>
    </div>

    <!-- SESSIONS -->
    <div class="page" id="page-sessions">
      <div class="page-hdr"><div><h1>Active Sessions</h1><p>Monitor all ongoing exam sessions</p></div></div>
      <div class="card"><table><thead><tr><th>Student</th><th>Exam</th><th>Course</th><th>Joined</th><th>Duration</th><th>Risk Level</th><th>Actions</th></tr></thead><tbody id="admin-sessions-tbody"></tbody></table></div>
    </div>

    <!-- SUBMISSIONS -->
    <div class="page" id="page-submissions">
      <div class="page-hdr"><div><h1>All Submissions</h1><p>View and manage student submissions</p></div></div>
      <div class="card"><table><thead><tr><th>Student</th><th>Assessment</th><th>Score</th><th>Submitted</th><th>Suspicion</th><th>Status</th><th>Actions</th></tr></thead><tbody id="admin-submissions-tbody"></tbody></table></div>
    </div>

    <!-- AUDIT LOG -->
    <div class="page" id="page-events">
      <div class="page-hdr"><div><h1>Audit Log</h1><p>System events and activities</p></div></div>
      <div class="card"><table><thead><tr><th>Event</th><th>User</th><th>Type</th><th>Details</th><th>Timestamp</th></tr></thead><tbody id="admin-events-tbody"></tbody></table></div>
    </div>

    <!-- SETTINGS -->
    <div class="page" id="page-settings">
      <div class="page-hdr"><div><h1>System Settings</h1></div></div>
      <div class="card">
        <div class="card-title">Proctoring Configuration</div>
        <div style="display:grid;gap:1rem;margin-top:.75rem">
          <div class="form-group">
            <label><input type="checkbox" id="a-setting-face" checked style="margin-right:.5rem"/>Face Detection Enabled</label>
          </div>
          <div class="form-group">
            <label><input type="checkbox" id="a-setting-gaze" checked style="margin-right:.5rem"/>Gaze Tracking Enabled</label>
          </div>
          <div class="form-group">
            <label><input type="checkbox" id="a-setting-audio" checked style="margin-right:.5rem"/>Audio Monitoring Enabled</label>
          </div>
          <div class="form-group">
            <label>Suspicion Score Threshold: <input type="number" id="a-setting-threshold" value="50" min="0" max="100" style="width:100px;margin-left:.5rem"/></label>
          </div>
          <button class="btn btn-primary" style="width:fit-content" onclick="saveAdminSettings()">Save Settings</button>
        </div>
      </div>
    </div>

    <!-- REPORTS -->
    <div class="page" id="page-reports">
      <div class="page-hdr"><div><h1>Reports</h1></div></div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem">
        <div class="card">
          <div class="card-title">Export Reports</div>
          <div style="display:flex;flex-direction:column;gap:.5rem;margin-top:.75rem">
            <button class="btn btn-ghost" style="justify-content:center" onclick="exportSubmissionsReport()">Export Submissions (CSV)</button>
            <button class="btn btn-ghost" style="justify-content:center" onclick="exportSessionsReport()">Export Sessions (CSV)</button>
            <button class="btn btn-ghost" style="justify-content:center" onclick="exportEventsReport()">Export Audit Log (CSV)</button>
          </div>
        </div>
        <div class="card">
          <div class="card-title">System Info</div>
          <div style="font-size:.85rem;color:var(--muted);margin-top:.5rem">
            <div style="padding:.4rem 0;border-bottom:1px solid var(--border)"><span style="font-weight:500">ProctorVision v1.0</span></div>
            <div style="padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Database: SQLite</span></div>
            <div style="padding:.4rem 0"><span>Backend: Flask + Socket.IO</span></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.querySelectorAll('#sidebar a').forEach(a=>{
    a.addEventListener('mouseenter',()=>{ if(!a.classList.contains('active')) a.style.background='#5a1a31'; });
    a.addEventListener('mouseleave',()=>{ if(!a.classList.contains('active')) a.style.background=''; });
  });
}

function navAdmin(page, el){
  data = loadData();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('#sidebar a').forEach(a=>{ a.classList.remove('active'); a.style.background=''; });
  document.getElementById('page-'+page).classList.add('active');
  if(el){ el.classList.add('active'); el.style.background='#5a1a31'; }
  if(page==='dashboard') renderAdminDashboard();
  if(page==='users') renderAdminUsers();
  if(page==='courses') renderAdminCourses();
  if(page==='exams') renderAdminExams();
  if(page==='sessions') renderAdminSessions();
  if(page==='submissions') renderAdminSubmissions();
  if(page==='events') renderAdminEvents();
  return false;
}

function renderAdminDashboard(){
  document.getElementById('a-stat-users').textContent = '4';
  document.getElementById('a-stat-courses').textContent = data.courses.length;
  document.getElementById('a-stat-exams').textContent = data.exams.length;
  document.getElementById('a-stat-sessions').textContent = (data.studentJoins||[]).filter(j=>j.status==='joined').length;
}

function renderAdminUsers(){
  const tb = document.getElementById('admin-users-tbody');
  // Sample users data
  const users = [
    {id:'u1', name:'Prof. Teacher', email:'teacher@school.edu', role:'teacher', status:'active', created:'2024-01-15'},
    {id:'u2', name:'Juan Dela Cruz', email:'juan@student.edu', role:'student', status:'active', created:'2024-02-01'},
    {id:'u3', name:'Maria Santos', email:'maria@student.edu', role:'student', status:'active', created:'2024-02-01'},
    {id:'u4', name:'System Administrator', email:'admin@school.edu', role:'admin', status:'active', created:'2024-01-01'}
  ];
  tb.innerHTML = users.map(u=>`<tr>
    <td><strong>${u.name}</strong></td>
    <td>${u.email}</td>
    <td><span class="pill ${u.role==='admin'?'pill-red':u.role==='teacher'?'pill-blue':'pill-green'}">${u.role}</span></td>
    <td><span class="pill pill-green">${u.status}</span></td>
    <td style="font-size:.8rem;color:var(--muted)">${u.created}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="openAdminUserModal('${u.id}')">Edit</button>
      <button class="btn btn-ghost btn-sm" onclick="deleteAdminUser('${u.id}')" style="color:var(--warn)">Delete</button></td>
  </tr>`).join('');
}

function renderAdminCourses(){
  const tb = document.getElementById('admin-courses-tbody');
  tb.innerHTML = data.courses.map(c=>{
    const exams = data.exams.filter(e=>e.course===c.id).length;
    return `<tr>
    <td><strong>${c.code||'—'}</strong></td>
    <td>${c.name}</td>
    <td style="font-size:.8rem;color:var(--muted)">${c.desc||'—'}</td>
    <td>2</td>
    <td>${exams}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="openAdminCourseModal('${c.id}')">Edit</button>
      <button class="btn btn-ghost btn-sm" onclick="deleteAdminCourse('${c.id}')" style="color:var(--warn)">Delete</button></td>
  </tr>`;
  }).join('');
}

function renderAdminExams(){
  const tb = document.getElementById('admin-exams-tbody');
  if(!data.exams.length){
    tb.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">Info</div><p>No assessments created yet.</p></div></td></tr>';
    return;
  }
  tb.innerHTML = data.exams.map(e=>{
    const course = data.courses.find(c=>c.id===e.course);
    return `<tr>
    <td><strong>${e.title}</strong></td>
    <td>${course?course.name:'—'}</td>
    <td><span class="pill pill-blue">${e.type}</span></td>
    <td>${e.questions.length}</td>
    <td><span class="pill ${e.status==='published'?'pill-green':'pill-yellow'}">${e.status}</span></td>
    <td>Prof. Teacher</td>
    <td><button class="btn btn-ghost btn-sm" onclick="openAdminExamModal('${e.id}')">View</button>
      <button class="btn btn-ghost btn-sm" onclick="deleteAdminExam('${e.id}')" style="color:var(--warn)">Delete</button></td>
  </tr>`;
  }).join('');
}

function renderAdminSessions(){
  const tb = document.getElementById('admin-sessions-tbody');
  const joins = data.studentJoins || [];
  const active = joins.filter(j=>j.status==='joined');
  if(!active.length){
    tb.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">Info</div><p>No active sessions.</p></div></td></tr>';
    return;
  }
  tb.innerHTML = active.map(j=>{
    const exam = data.exams.find(e=>e.id===j.examId);
    const course = exam?data.courses.find(c=>c.id===exam.course):null;
    const joinTime = new Date(j.joinedAt);
    const now = new Date();
    const duration = Math.round((now - joinTime) / 1000 / 60);
    return `<tr>
    <td>${j.studentName}</td>
    <td>${exam?exam.title:'—'}</td>
    <td>${course?course.name:'—'}</td>
    <td style="font-size:.8rem;color:var(--muted)">${joinTime.toLocaleTimeString()}</td>
    <td>${duration} min</td>
    <td><span class="pill pill-green">Low</span></td>
    <td><button class="btn btn-ghost btn-sm" onclick="viewAdminSession('${j.id}')">Monitor</button></td>
  </tr>`;
  }).join('');
}

function renderAdminSubmissions(){
  const tb = document.getElementById('admin-submissions-tbody');
  if(!data.submissions.length){
    tb.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">Info</div><p>No submissions yet.</p></div></td></tr>';
    return;
  }
  tb.innerHTML = data.submissions.slice().reverse().map(s=>{
    const exam = data.exams.find(e=>e.id===s.examId);
    const suspicion = getSubmissionSuspicion(s);
    const riskClass = suspicion>=70 ? 'pill-red' : suspicion>=40 ? 'pill-yellow' : 'pill-green';
    const riskLabel = suspicion>=70 ? 'High' : suspicion>=40 ? 'Moderate' : 'Low';
    return `<tr>
    <td>${s.studentName}</td>
    <td>${exam?exam.title:'—'}</td>
    <td><div>${s.score}/${s.total} (${s.pct}%)</div><div class="score-bar"><div class="score-fill" style="width:${s.pct}%"></div></div></td>
    <td style="font-size:.8rem;color:var(--muted)">${new Date(s.submittedAt).toLocaleString()}</td>
    <td><span class="pill ${riskClass}">${suspicion}% ${riskLabel}</span></td>
    <td><span class="pill ${s.pct>=75?'pill-green':'pill-red'}">${s.pct>=75?'Passed':'Failed'}</span></td>
    <td><button class="btn btn-ghost btn-sm" onclick="openAdminSubmissionModal('${s.id}')">Review</button></td>
  </tr>`;
  }).join('');
}

function renderAdminEvents(){
  const tb = document.getElementById('admin-events-tbody');
  const events = data.liveEvents ? data.liveEvents.slice(-20).reverse() : [];
  if(!events.length){
    tb.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="icon">Info</div><p>No events logged yet.</p></div></td></tr>';
    return;
  }
  tb.innerHTML = events.map(e=>`<tr>
    <td><strong>${e.type||'system'}</strong></td>
    <td>${e.student_name||e.studentName||'System'}</td>
    <td>${e.event_type||e.type||'—'}</td>
    <td style="font-size:.8rem;color:var(--muted)">${e.details||'—'}</td>
    <td style="font-size:.8rem;color:var(--muted)">${new Date(e.time||e.created_at).toLocaleString()}</td>
  </tr>`).join('');
}

function openAdminUserModal(userId){
  toast('User editing modal - click to implement full user management');
}

function openAdminCourseModal(courseId){
  toast('Course editing modal - click to implement full course management');
}

function openAdminExamModal(examId){
  toast('Exam viewing modal - shows detailed exam information');
}

function openAdminSubmissionModal(subId){
  const sub = data.submissions.find(s=>s.id===subId);
  if(sub){
    toast(`Reviewing ${sub.studentName}'s submission: ${sub.pct}% (${sub.score}/${sub.total})`);
    openProctorReport(subId);
  }
}

function deleteAdminUser(userId){
  if(!confirm('Delete this user? This action cannot be undone.')) return;
  toast('User deleted successfully.');
  renderAdminUsers();
}

function deleteAdminCourse(courseId){
  if(!confirm('Delete this course? Associated exams will not be deleted.')) return;
  data.courses = data.courses.filter(c=>c.id!==courseId);
  saveData();
  renderAdminCourses();
  toast('Course deleted.');
}

function deleteAdminExam(examId){
  if(!confirm('Delete this assessment? This cannot be undone.')) return;
  data.exams = data.exams.filter(e=>e.id!==examId);
  data.submissions = data.submissions.filter(s=>s.examId!==examId);
  saveData();
  renderAdminExams();
  toast('Assessment deleted.');
}

function viewAdminSession(sessionId){
  toast('Monitoring session - real-time proctor data would display here');
}

function saveAdminSettings(){
  const settings = {
    faceDetection: document.getElementById('a-setting-face').checked,
    gazeTracking: document.getElementById('a-setting-gaze').checked,
    audioMonitoring: document.getElementById('a-setting-audio').checked,
    suspicionThreshold: parseInt(document.getElementById('a-setting-threshold').value)
  };
  localStorage.setItem('admin_settings', JSON.stringify(settings));
  toast('Settings saved successfully.');
}

function exportSubmissionsReport(){
  if(!data.submissions.length){ toast('No submissions to export.'); return; }
  let csv = 'Student,Exam,Score,Total,Percentage,Submitted,Risk Level\n';
  data.submissions.forEach(s=>{
    const exam = data.exams.find(e=>e.id===s.examId);
    const risk = getSubmissionSuspicion(s);
    csv += `"${s.studentName}","${exam?exam.title:'Unknown'}",${s.score},${s.total},${s.pct}%,"${new Date(s.submittedAt).toLocaleString()}","${risk}%"\n`;
  });
  downloadCSV(csv, 'submissions-report.csv');
  toast('Report exported.');
}

function exportSessionsReport(){
  let csv = 'Student,Exam,Course,Joined At,Duration (min),Risk\n';
  const joins = data.studentJoins || [];
  joins.forEach(j=>{
    const exam = data.exams.find(e=>e.id===j.examId);
    const course = exam?data.courses.find(c=>c.id===exam.course):null;
    const joinTime = new Date(j.joinedAt);
    const now = new Date();
    const duration = Math.round((now - joinTime) / 1000 / 60);
    csv += `"${j.studentName}","${exam?exam.title:'Unknown'}","${course?course.name:'Unknown'}","${joinTime.toLocaleString()}",${duration},"Low"\n`;
  });
  downloadCSV(csv, 'sessions-report.csv');
  toast('Report exported.');
}

function exportEventsReport(){
  let csv = 'Event Type,User,Details,Timestamp\n';
  const events = data.liveEvents || [];
  events.forEach(e=>{
    const time = new Date(e.time||e.created_at).toLocaleString();
    csv += `"${e.type||'system'}","${e.student_name||e.studentName||'System'}","${(e.details||'').replace(/"/g, '\"')}","${time}"\n`;
  });
  downloadCSV(csv, 'events-report.csv');
  toast('Report exported.');
}

function downloadCSV(csv, filename){
  const blob = new Blob([csv], {type:'text/csv'});
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}

// ════════════════════════════════════════
// EXAM TAKING
// ════════════════════════════════════════
async function openExamIntro(examId){
  data = loadData();
  const exam = data.exams.find(e=>e.id===examId);
  if(!exam){ toast('Exam not found.'); return; }
  resetCameraExamState();
  closeCameraStream();
  backendJoinSession(exam);
  let camOk = false;
  try{ camOk = await ensureCameraAccess(); }catch(e){ camOk = false; }
  // Auto-join the student to this exam for monitoring (no manual sessions required)
  data.studentJoins = data.studentJoins || [];
  const existing = data.studentJoins.find(j=>j.studentName===STUDENT_NAME && j.examId===examId && j.status==='joined');
  if(!existing){
    // mark any previous joined as left
    data.studentJoins.forEach(j=>{ if(j.studentName===STUDENT_NAME && j.status==='joined') j.status='left'; });
    data.studentJoins.push({ id:'join'+Date.now(), studentName:STUDENT_NAME, examId:examId, status:'joined', joinedAt:new Date().toISOString() });
    saveData();
  }
  if(hasSubmitted(examId)){ toast('Already submitted!'); return; }
  activeExam=exam; answers={}; currentQ=0;
  const course = data.courses.find(c=>c.id===exam.course);
  document.getElementById('es-title').textContent = exam.title;
  document.getElementById('intro-title').textContent = exam.title;
  document.getElementById('intro-instructions').textContent = exam.instructions||'Answer all questions to the best of your ability.';
  document.getElementById('intro-qcount').textContent = exam.questions.length;
  document.getElementById('intro-time').textContent = exam.timeLimit?exam.timeLimit+' minutes':'No time limit';
  document.getElementById('intro-course').textContent = course?course.name:'Unknown';
  document.getElementById('intro-screen').style.display='block';
  document.getElementById('questions-screen').style.display='none';
  document.getElementById('result-screen-wrap').style.display='none';
  document.getElementById('exam-shell').classList.add('show');
  disableCalibration();
  updateStartButtonState();
}

async function beginExam(){
  if(!calibrationPassed && !proctorSession){ toast('Please wait while your face is detected.'); return; }
  if(!await ensureCameraAccess()) return;
  document.getElementById('intro-screen').style.display='none';
  document.getElementById('questions-screen').style.display='flex';
  document.getElementById('qs-exam-title').textContent=activeExam.title;
  document.getElementById('exam-shell').classList.add('proctoring-active');
  if(timerInterval) clearInterval(timerInterval);
  startProctoring();
  timeLeft = activeExam.timeLimit?parseInt(activeExam.timeLimit)*60:0;
  if(timeLeft>0){
    updateTimerDisplay();
    timerInterval = setInterval(()=>{ timeLeft--; updateTimerDisplay(); if(timeLeft<=0){ clearInterval(timerInterval); submitExam(true); }},1000);
  }else{ document.getElementById('timer-display').textContent='No limit'; }
  renderQuestion(0);
}

function updateTimerDisplay(){
  const el = document.getElementById('timer-display');
  const m=Math.floor(timeLeft/60), s=timeLeft%60;
  el.textContent=m+':'+(s<10?'0':'')+s;
  el.classList.toggle('warn',timeLeft<=60);
}

function renderQuestion(idx){
  const qs = activeExam.questions;
  currentQ = idx;
  document.getElementById('q-progress').textContent=(idx+1)+'/'+qs.length;
  const answered = Object.keys(answers).filter(k=>answers[k]!==undefined&&answers[k]!=='').length;
  document.getElementById('q-prog-label').textContent=answered+' answered';
  document.getElementById('q-prog-fill').style.width=Math.round(answered/qs.length*100)+'%';
  document.getElementById('btn-prev').style.display=idx===0?'none':'';
  document.getElementById('btn-next').style.display=idx===qs.length-1?'none':'';
  document.getElementById('btn-submit').style.display=idx===qs.length-1?'':'none';
  const q = qs[idx];
  let html = `<div class="q-block"><span class="q-num-badge">Q${idx+1} of ${qs.length}</span><div class="q-text">${escHtml(q.text)}</div>`;
  if(q.qtype==='mcq'){
    html += q.choices.map((c,i)=>`
      <div class="choice-opt ${answers[idx]===i?'selected':''}" onclick="selectAnswer(${idx},${i})">
        <input type="radio" name="q${idx}" value="${i}" ${answers[idx]===i?'checked':''} onchange="selectAnswer(${idx},${i})"/>
        <span>${String.fromCharCode(65+i)}. ${escHtml(c)}</span>
      </div>`).join('');
  }else if(q.qtype==='tf'){
    html += ['True','False'].map((c,i)=>`
      <div class="choice-opt ${answers[idx]===c.toLowerCase()?'selected':''}" onclick="selectAnswer(${idx},'${c.toLowerCase()}')">
        <input type="radio" name="q${idx}" value="${c.toLowerCase()}" ${answers[idx]===c.toLowerCase()?'checked':''}/>
        <span>${c}</span>
      </div>`).join('');
  }else{
    html += `<textarea class="short-answer" placeholder="Type your answer here..." onchange="selectAnswer(${idx},this.value)" oninput="selectAnswer(${idx},this.value)">${answers[idx]||''}</textarea>`;
  }
  html += '</div>';
  document.getElementById('question-area').innerHTML = html;
}

function selectAnswer(qi,val){
  if(examInputsDisabled){ toast('Exam paused: cannot change answers while camera is unavailable.'); return; }
  answers[qi]=val; renderQuestion(qi);
}
function prevQ(){ if(currentQ>0) renderQuestion(currentQ-1); }
function nextQ(){ if(currentQ<activeExam.questions.length-1) renderQuestion(currentQ+1); }

function submitExam(auto){
  if(examPausedDueCamera){ toast('Cannot submit while camera is paused. Please restore camera to continue.'); return; }
  if(!auto&&!confirm('Submit your exam? You cannot change your answers after submitting.')) return;
  if(timerInterval) clearInterval(timerInterval);
  const proctorData = proctorSession ? finalizeProctoring() : null;
  stopProctoring();
  let score=0, total=0;
  const review = [];
  activeExam.questions.forEach((q,i)=>{
    const pts=q.points||1; total+=pts;
    const ans=answers[i];
    let correct=false;
    if(q.qtype==='mcq') correct=ans===q.correct;
    else if(q.qtype==='tf') correct=ans===q.correct;
    else correct=ans&&ans.trim().length>0;
    if(correct) score+=pts;
    review.push({q:q.text,qtype:q.qtype,correct,userAns:ans,correctAns:q.correct,choices:q.choices,pts});
  });
  const pct = total?Math.round(score/total*100):0;
  data = loadData();
  const submissionId = 's'+Date.now();
  data.submissions.push({id:submissionId,examId:activeExam.id,studentName:STUDENT_NAME,score,total,pct,submittedAt:new Date().toISOString(),proctorData,backendSessionId});
  saveData();
  backendSubmitExam(submissionId, score, total, pct).then(result=>{
    if(!result) return;
    data = loadData();
    const sub = data.submissions.find(s=>s.id===submissionId);
    if(sub){
      sub.backendScore = result.suspicion_score;
      sub.backendVerdict = result.ai_verdict;
      sub.backendRisk = result.risk_level;
      saveData();
    }
  });
  showResult(score,total,pct,review);
}

function showResult(score,total,pct,review){
  document.getElementById('questions-screen').style.display='none';
  document.getElementById('result-screen-wrap').style.display='block';
  document.getElementById('result-pct').textContent=pct+'%';
  const circle=document.getElementById('result-circle');
  circle.style.borderColor=pct>=75?'var(--accent2)':'var(--warn)';
  circle.querySelector('.pct').style.color=pct>=75?'var(--accent2)':'var(--warn)';
  document.getElementById('result-verdict').textContent=pct>=90?'Excellent!':pct>=75?'Good job!':pct>=50?'Keep practicing':'Need improvement';
  document.getElementById('result-sub').textContent=`You scored ${score} out of ${total} points.`;
  
  document.getElementById('answer-review').innerHTML='<div style="font-weight:600;font-size:.95rem;margin-bottom:.75rem">Answer Review</div>'+
    review.map((r,i)=>`
      <div class="ar-item">
        <div class="ar-q">Q${i+1}. ${escHtml(r.q)}</div>
        <div class="${r.correct?'ar-correct':'ar-wrong'}">${r.correct?'Correct':'Incorrect'} (${r.pts} pt${r.pts>1?'s':''})</div>
        ${!r.correct&&r.qtype!=='short'?`<div class="ar-ans">Your answer: ${formatAns(r.userAns,r)}  ·  Correct: ${formatAns(r.correctAns,r)}</div>`:''}
      </div>`).join('');
}

function startProctoring(){
  proctorSession = {startedAt:new Date().toISOString(),events:[],score:0,typingHistory:[],lastKeyTime:null,alerted:false};
  window.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('blur', handleBlur);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('copy', handleCopy);
  window.addEventListener('cut', handleCut);
  window.addEventListener('paste', handlePaste);
  window.addEventListener('contextmenu', handleContextMenu);
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('beforeunload', handleBeforeUnload);
  ensureCameraAccess();
  updateProctoringBadge(true);
}

function stopProctoring(){
  window.removeEventListener('visibilitychange', handleVisibility);
  window.removeEventListener('blur', handleBlur);
  window.removeEventListener('focus', handleFocus);
  window.removeEventListener('copy', handleCopy);
  window.removeEventListener('cut', handleCut);
  window.removeEventListener('paste', handlePaste);
  window.removeEventListener('contextmenu', handleContextMenu);
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  document.getElementById('exam-shell')?.classList.remove('proctoring-active');
  updateProctoringBadge(false);
  closeCameraStream();
}

function finalizeProctoring(){
  if(!proctorSession) return null;
  const score = Math.min(100, proctorSession.score);
  const summary = proctorSession.events.length
    ? `${proctorSession.events.length} suspicious event(s) detected with a risk score of ${score}%.`
    : 'No suspicious browser behavior detected during this exam.';
  const verdict = generateProctorVerdict(proctorSession);
  const result = {...proctorSession,score,summary,verdict,completedAt:new Date().toISOString()};
  proctorSession = null;
  return result;
}

function recordProctorEvent(type, details, weight){
  if(!proctorSession) return;
  const now = new Date();
  const event = {time: now.toLocaleTimeString(), type, details, weight};
  proctorSession.events.push(event);
  // apply weight with multiplier and per-type cooldown to reduce noisy scoring
  const added = addProctorWeight(weight || 8, type);
  if(added > 0 && !proctorSession.alerted && proctorSession.score >= 40){
    toast('ProctorVision flagged suspicious activity for teacher review.');
    proctorSession.alerted = true;
  }
  // Buffer live events to reduce localStorage writes; flush periodically
  try{
    if(activeExam && activeExam.id){
      liveEventBuffer.push({ examId: activeExam.id, studentName: STUDENT_NAME, time: now.toISOString(), type, details, weight, added });
      // schedule flush
      if(liveEventFlushTimer) clearTimeout(liveEventFlushTimer);
      liveEventFlushTimer = setTimeout(flushLiveEvents, LIVE_EVENT_FLUSH_MS);
      backendPostEvent({ type, details, weight, time: now.toISOString() });
    }
  }catch(e){ /* ignore transient errors */ }
}

function addProctorWeight(weight, type){
  if(!proctorSession) return 0;
  proctorSession.lastEventAtByType = proctorSession.lastEventAtByType || {};
  const nowMs = Date.now();
  if(proctorSession.lastEventAtByType[type] && (nowMs - proctorSession.lastEventAtByType[type]) < EVENT_COOLDOWN_MS){
    return 0; // ignore rapid repeats
  }
  proctorSession.lastEventAtByType[type] = nowMs;
  const adj = Math.round((weight || 8) * PROCTOR_WEIGHT_MULTIPLIER);
  proctorSession.score = Math.min(100, (proctorSession.score || 0) + adj);
  return adj;
}

function flushLiveEvents(){
  if(!liveEventBuffer.length) return;
  try{
    data.liveEvents = data.liveEvents || [];
    // move buffer into persisted liveEvents
    data.liveEvents = data.liveEvents.concat(liveEventBuffer.splice(0));
    saveData();
  }catch(e){ /* ignore */ }
  if(liveEventFlushTimer){ clearTimeout(liveEventFlushTimer); liveEventFlushTimer = null; }
}

function handleVisibility(){
  if(!proctorSession) return;
  if(document.visibilityState === 'hidden'){
    recordProctorEvent('tab_switch','Student switched browser tab or window',12);
  } else {
    recordProctorEvent('focus_return','Student returned to exam tab',2);
  }
}

function handleBlur(){ if(proctorSession) recordProctorEvent('focus_lost','Exam window lost focus',10); }
function handleFocus(){ if(!proctorSession) return; recordProctorEvent('focus_regained','Exam window regained focus',2); }
function handleCopy(e){
  if(!proctorSession) return;
  if(document.activeElement?.tagName === 'TEXTAREA') return;
  e.preventDefault();
  recordProctorEvent('copy_attempt','Copy action blocked during exam',14);
}
function handleCut(e){
  if(!proctorSession) return;
  if(document.activeElement?.tagName === 'TEXTAREA') return;
  e.preventDefault();
  recordProctorEvent('copy_attempt','Cut action blocked during exam',14);
}
function handlePaste(e){ if(!proctorSession) return; e.preventDefault(); recordProctorEvent('paste_attempt','Paste action blocked during exam',14); }
function handleContextMenu(e){ if(!proctorSession) return; e.preventDefault(); recordProctorEvent('context_menu','Right-click context menu blocked',8); }
function handleBeforeUnload(e){ if(!proctorSession) return; e.preventDefault(); e.returnValue = ''; }

function updateProctoringBadge(active){
  const el = document.getElementById('proctoring-badge');
  if(el) el.style.display = active ? 'inline-flex' : 'none';
}

function resetCameraExamState(){
  examPausedDueCamera = false;
  pauseReason = '';
  autoStartedOnCalibration = false;
  faceCenterHistory = [];
  faceAwayConsecutive = 0;
  gazeHistory = [];
  gazeAwayConsecutive = 0;
  gazeUncertainConsecutive = 0;
  lastMotionFrame = null;
  motionHistory = [];
  isHighMotion = false;
  motionLevel = 0;
  hideCameraOverlay();
  setExamInputsDisabled(false);
}

function isCameraStreamLive(){
  if(!cameraStream) return false;
  const track = cameraStream.getVideoTracks()[0];
  return !!(track && track.readyState === 'live');
}

async function ensureCameraAccess(){
  try{
    if(isCameraStreamLive()){
      startCameraAnalysis();
      return true;
    }
    if(cameraStream) closeCameraStream();
    // Ensure we're on a secure context
    if(location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
      const msg = 'Camera requires a secure context (HTTPS) or localhost. Open the app over https or run on localhost.';
      updateCameraStatus('Insecure origin', msg);
      showCameraOverlay(msg);
      setStartButtonEnabled(false);
      return false;
    }
    await openCameraStream();
    return true;
  }catch(e){
    const em = (e && e.message) ? e.message : String(e);
    console.error('openCameraStream error', e);
    updateCameraStatus('Camera error', em);
    const overlayMsg = document.getElementById('camera-overlay-msg');
    if(overlayMsg) overlayMsg.textContent = 'Camera access failed: '+em;
    const diag = document.getElementById('camera-diagnostics'); if(diag) diag.textContent = em;
    showCameraOverlay('Camera access is required to continue the exam. See diagnostics.');
    setStartButtonEnabled(false);
    try{ listMediaDevices(); }catch(_){}
    return false;
  }
}

async function openCameraStream(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera not supported');
  let stream;
  try{
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:640,height:480},audio:true});
  }catch(err){
    console.warn('getUserMedia(video+audio) failed, trying video-only', err);
    // try video-only fallback
    try{
      stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:640,height:480},audio:false});
      // surface diagnostic about audio failure
      const diag = document.getElementById('camera-diagnostics'); if(diag) diag.textContent = 'Could not start audio source';
      updateCameraStatus('Camera active (no audio)','Microphone unavailable or permission denied');
      audioAvailable = false;
    }catch(err2){
      console.error('getUserMedia(video-only) failed', err2);
      throw err2;
    }
  }
  cameraStream = stream;
  try{ listMediaDevices(); }catch(e){}
  const video = document.getElementById('camera-video');
  video.srcObject = stream;
  await video.play().catch(()=>{});
  initializeFaceDetector();
  try{ initializeAudioAnalysis(stream); }catch(e){
    console.warn('initializeAudioAnalysis failed', e);
    const diag = document.getElementById('camera-diagnostics'); if(diag) diag.textContent = 'Could not start audio source';
    audioAvailable = false;
  }
  startCameraAnalysis();
  disableCalibration();
  updateCameraStatus('Camera active','');
  hideCameraOverlay();
}

function initializeFaceDetector(){
  if('FaceDetector' in window){
    if(!faceDetector) faceDetector = new FaceDetector({fastMode:true,maxDetectedFaces:2});
  } else {
    faceDetector = null;
  }
}

function initializeAudioAnalysis(stream){
  if(!window.AudioContext && !window.webkitAudioContext) { audioAvailable = false; return; }
  if(audioContext){
    try{ audioContext.close(); }catch(e){}
    audioContext = null;
    analyserNode = null;
    audioDataArray = null;
  }
  // if stream has no audio tracks, skip audio setup
  if(!stream || !stream.getAudioTracks || stream.getAudioTracks().length === 0){ audioAvailable = false; return; }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  try{
    audioContext = new AudioCtx();
    const source = audioContext.createMediaStreamSource(stream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 512;
    source.connect(analyserNode);
    audioDataArray = new Uint8Array(analyserNode.frequencyBinCount);
    audioAvailable = true;
  }catch(e){
    console.warn('audio init failed', e);
    audioAvailable = false;
    try{ if(audioContext){ audioContext.close(); audioContext = null; } }catch(e){}
  }
}

function startCameraAnalysis(){
  stopCameraAnalysis();
  const analyzeLoop = async ()=>{
    cameraAnalysisHandle = requestAnimationFrame(analyzeLoop);
    if(cameraAnalysisInFlight) return;
    cameraAnalysisInFlight = true;
    try{ await analyzeCameraFrame(); }catch(e){} finally{ cameraAnalysisInFlight = false; }
  };
  cameraAnalysisHandle = requestAnimationFrame(analyzeLoop);
}

// Simple fallback face detection when the Face Detection API isn't available.
// This is a heuristic: it finds the largest contiguous region of mid-range luminance
// which often corresponds to a face in webcam frames. Returns a bbox or null.
function detectFaceFallback(frame, width, height){
  const data = frame.data;
  const step = 4; // sample every 4th pixel for speed
  let minX = width, minY = height, maxX = 0, maxY = 0, count = 0;
  for(let y=0;y<height;y+=step){
    for(let x=0;x<width;x+=step){
      const i = (y*width + x)*4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const l = 0.2126*r + 0.7152*g + 0.0722*b;
      // skin/face pixels usually fall in mid-range luminance for webcams
      if(l > 30 && l < 220){
        // additional simple heuristic: more likely near center horizontally
        if(x > width*0.1 && x < width*0.9){
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          count++;
        }
      }
    }
  }
  if(count < 20) return null; // not enough pixels
  // pad bbox a bit
  const padX = Math.max(8, Math.floor((maxX-minX)*0.12));
  const padY = Math.max(8, Math.floor((maxY-minY)*0.18));
  const bx = Math.max(0, minX - padX);
  const by = Math.max(0, minY - padY);
  const bw = Math.min(width - bx, (maxX - minX) + padX*2);
  const bh = Math.min(height - by, (maxY - minY) + padY*2);
  // sanity: require reasonable size
  if(bw < 30 || bh < 30) return null;
  return { x: bx, y: by, width: bw, height: bh };
}

function stopCameraAnalysis(){
  if(cameraAnalysisHandle){ cancelAnimationFrame(cameraAnalysisHandle); cameraAnalysisHandle = null; }
  cameraAnalysisInFlight = false;
}

function closeCameraStream(){
  stopCameraAnalysis();
  if(cameraStream){ cameraStream.getTracks().forEach(track=>track.stop()); cameraStream = null; }
  if(audioContext){ try{ audioContext.close(); }catch(e){} audioContext = null; analyserNode = null; audioDataArray = null; }
  audioAvailable = false;
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  if(video) video.srcObject = null;
  if(canvas){
    const ctx = canvas.getContext('2d');
    if(ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  updateCameraStatus('Camera stopped','');
  setStartButtonEnabled(false);
}

async function analyzeCameraFrame(){
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  if(!video || video.readyState < 2) return;
  const width = 320, height = 240;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video,0,0,width,height);
  const frame = ctx.getImageData(0,0,width,height);
  const brightness = calculateFrameBrightness(frame.data);
  const variance = calculateFrameVariance(frame.data, brightness);
  const cameraBlocked = brightness < 22 || variance < 280;
  if(cameraBlocked){
    if(proctorSession) recordProctorEvent('camera_blocked','Camera appears covered or blocked',20);
    if(proctorSession) pauseExam('Camera blocked or covered');
    return;
  }
  if(examPausedDueCamera && proctorSession){
    resumeExam();
  }
  let scaledFaceBox = null;
  if(faceDetector){
    try{
      const faces = await faceDetector.detect(video);
      if(faces.length === 0){
        if(proctorSession){
          pauseReason = 'Face not detected';
          recordProctorEvent('no_face','Unable to detect a face in camera view',18);
          pauseExam(pauseReason);
        } else {
          updateCalibrationProgress(false);
        }
        return;
      }
      if(faces.length > 1){ recordProctorEvent('multiple_people','More than one person detected in the camera view',24); }
      const faceBox = faces[0].boundingBox;
      // scale detector bbox to our analysis canvas size (video may be different resolution)
      const scaleX = (video.videoWidth && video.videoWidth > 0) ? (width / video.videoWidth) : 1;
      const scaleY = (video.videoHeight && video.videoHeight > 0) ? (height / video.videoHeight) : 1;
      scaledFaceBox = {
        x: Math.max(0, Math.floor(faceBox.x * scaleX)),
        y: Math.max(0, Math.floor(faceBox.y * scaleY)),
        width: Math.max(1, Math.floor(faceBox.width * scaleX)),
        height: Math.max(1, Math.floor(faceBox.height * scaleY))
      };
    }catch(err){
      console.warn('FaceDetector failed', err);
    }
  }
  // fallback detection if FaceDetector not available or failed
  if(!scaledFaceBox){
    const fb = detectFaceFallback(frame, width, height);
    if(!fb){
      if(proctorSession){
        pauseReason = 'Face not detected';
        recordProctorEvent('no_face','Unable to detect a face in camera view (fallback)',18);
        pauseExam(pauseReason);
      } else {
        updateCalibrationProgress(false);
      }
      return;
    }
    scaledFaceBox = fb;
  }
  if(!proctorSession) updateCalibrationProgress(true);
  analyzeFacePosition(scaledFaceBox, width, height);
  // Track face center to detect sustained head turns / looking at other screens
  try{
    const faceCenterX = scaledFaceBox.x + scaledFaceBox.width/2;
    const faceCenterY = scaledFaceBox.y + scaledFaceBox.height/2;
    const dxNorm = Math.abs(faceCenterX - width/2) / (width/2);
    const dyNorm = Math.abs(faceCenterY - height/2) / (height/2);
    faceCenterHistory.push({dx: dxNorm, dy: dyNorm, t: Date.now()});
    if(faceCenterHistory.length > FACE_HISTORY_LEN) faceCenterHistory.shift();
    const recent = faceCenterHistory.slice(-6);
    const avgDx = recent.reduce((a,b)=>a+b.dx,0)/recent.length;
    const avgDy = recent.reduce((a,b)=>a+b.dy,0)/recent.length;
    if(avgDx > FACE_AWAY_THRESHOLD || avgDy > FACE_AWAY_THRESHOLD){
      faceAwayConsecutive++;
    } else {
      faceAwayConsecutive = 0;
    }
    if(faceAwayConsecutive >= FACE_AWAY_CONSECUTIVE_REQUIRED){
      const predominant = avgDx > avgDy ? 'horizontal' : 'vertical';
      const evType = predominant === 'horizontal' ? 'multi_screen_look' : 'face_turned_away';
      recordProctorEvent(evType, `Face center shifted (${(avgDx*100).toFixed(1)}%, ${(avgDy*100).toFixed(1)}%)`, 10);
      recordProctorEvent('offscreen_device_look', 'Student is looking toward a device or another display outside the camera field', 16);
      faceAwayConsecutive = 0;
      faceCenterHistory = [];
    }
  }catch(e){ /* ignore face-center tracking errors */ }
      // compute scene motion first so we can gate gaze checks during high motion
      try{ analyzeFrameMotion(frame.data, width, height, scaledFaceBox); }catch(e){ /* ignore motion errors */ }
      // estimate gaze from the face region (best-effort heuristic)
      try{
        const gaze = estimateGazeFromFace(frame, scaledFaceBox, width, height);
        if(gaze){
          // keep legacy gaze history for smoothing and existing checks
          if(gaze.confidence >= GAZE_CONFIDENCE_MIN){ updateGazeHistory(gaze.gx, gaze.gy); checkGazeBehavior(); }

          // If the scene is in strong motion, skip gaze-away detection to avoid false positives.
          if(isHighMotion){
            gazeAwayConsecutive = Math.max(0, gazeAwayConsecutive - 1);
            gazeUncertainConsecutive = 0;
            lastGazeState = 'motion';
            const diagEl = document.getElementById('camera-diagnostics'); if(diagEl) diagEl.textContent = `High motion: ${(motionLevel*100).toFixed(1)}% — pausing gaze checks.`;
          } else {
            // Primary away detection when confidence is strong
            const isAwayFrame = gaze && (gaze.confidence >= gazeAwayThreshold) && gaze.isLookingAway;
            if(isAwayFrame){
              gazeAwayConsecutive++; gazeUncertainConsecutive = 0;
            } else {
              // Low-confidence frames may occur with glasses or poor cameras; use face-center fallback
              if(gaze.confidence < 0.45){
                gazeUncertainConsecutive++;
                const faceCenterX = scaledFaceBox.x + scaledFaceBox.width/2;
                const faceCenterY = scaledFaceBox.y + scaledFaceBox.height/2;
                const dxNorm = Math.abs(faceCenterX - width/2) / (width/2);
                const dyNorm = Math.abs(faceCenterY - height/2) / (height/2);
                if((dxNorm > 0.22 || dyNorm > 0.22) && gazeUncertainConsecutive >= GAZE_UNCERTAIN_REQUIRED){
                  recordProctorEvent('gaze_away_fallback','Student appears to be looking away (low-confidence fallback)',10);
                  recordProctorEvent('offscreen_device_look', 'Student appears to be focusing on a phone or other device outside the camera view', 16);
                  gazeHistory = [];
                  gazeUncertainConsecutive = 0;
                  gazeAwayConsecutive = 0;
                }
              } else {
                gazeAwayConsecutive = 0; gazeUncertainConsecutive = 0;
              }
            }

            if(gazeAwayConsecutive >= gazeAwayConsecutiveRequired){
              recordProctorEvent('gaze_away','Student appears to be looking away from the screen repeatedly',14);
              recordProctorEvent('offscreen_device_look', 'Student appears to be looking at something outside the camera view', 16);
              gazeHistory = [];
              gazeAwayConsecutive = 0;
            }
          }
        }
        }catch(e){ /* ignore gaze estimation errors */ }
      analyzeAudio();
  detectRestrictedItems(frame.data,width,height);
}

function calculateFrameBrightness(data){
  let sum = 0;
  for(let i=0;i<data.length;i+=4){ sum += 0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2]; }
  return sum / (data.length/4);
}

function calculateFrameVariance(data, mean){
  let sum = 0;
  for(let i=0;i<data.length;i+=4){ const l = 0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2]; sum += (l-mean)*(l-mean); }
  return sum / (data.length/4);
}

function analyzeFacePosition(face,width,height){
  if(!proctorSession) return;
  const centerX = face.x + face.width/2;
  const centerY = face.y + face.height/2;
  const dx = Math.abs(centerX - width/2);
  const dy = Math.abs(centerY - height/2);
  const ratio = face.width/face.height;
  const faceAreaRatio = (face.width * face.height) / (width * height);

  const isShifted = dx > width*0.22 || dy > height*0.22;
  const isHeadTurned = ratio < 0.68 || ratio > 1.45;
  const isSideTurned = ratio < 0.62 && faceAreaRatio < 0.095;

  if(isShifted){
    recordProctorEvent('gaze_away','Student appears to be looking away from the screen',14);
  }

  if(isHeadTurned || isSideTurned){
    recordProctorEvent('head_tilt','Student head appears tilted or turned away',12);
  }

  // Capture lower-magnitude head turns that still indicate attention leaving the camera view
  if(isShifted && (ratio < 0.72 || ratio > 1.40 || faceAreaRatio < 0.115)){
    recordProctorEvent('offscreen_device_look','Student appears to be looking toward a device or display outside the camera view',16);
  }

  lastFaceAspect = ratio;
  lastFaceAreaRatio = faceAreaRatio;
}

function analyzeAudio(){
  if(!analyserNode || !audioDataArray) return;
  analyserNode.getByteFrequencyData(audioDataArray);
  const rms = Math.sqrt(audioDataArray.reduce((sum,v)=>sum+v*v,0)/audioDataArray.length) / 255;
  if(rms > 0.22){ recordProctorEvent('speech_detected','Audio detected during the exam; possible whispering or verbal communication',18); }
}

function analyzeFrameMotion(data, width, height, faceBox){
  if (!data || !data.length) return 0;
  const curr = data;
  let last = lastMotionFrame;
  if (!last) {
    lastMotionFrame = new Uint8ClampedArray(curr);
    motionLevel = 0;
    isHighMotion = false;
    motionHistory.push(0);
    return 0;
  }

  const step = 8; // higher = cheaper
  let sumDiffAll = 0;
  let sumDiffNonFace = 0;
  let countAll = 0;
  let countNonFace = 0;
  const pad = 12;
  const faceX0 = faceBox ? Math.max(0, Math.floor(faceBox.x - pad)) : -1;
  const faceY0 = faceBox ? Math.max(0, Math.floor(faceBox.y - pad)) : -1;
  const faceX1 = faceBox ? Math.min(width, Math.ceil(faceBox.x + faceBox.width + pad)) : -1;
  const faceY1 = faceBox ? Math.min(height, Math.ceil(faceBox.y + faceBox.height + pad)) : -1;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const g1 = (curr[i] * 0.299 + curr[i + 1] * 0.587 + curr[i + 2] * 0.114) | 0;
      const g0 = (last[i] * 0.299 + last[i + 1] * 0.587 + last[i + 2] * 0.114) | 0;
      const diff = Math.abs(g1 - g0);
      sumDiffAll += diff;
      countAll++;
      if (!faceBox || x < faceX0 || x >= faceX1 || y < faceY0 || y >= faceY1) {
        sumDiffNonFace += diff;
        countNonFace++;
      }
    }
  }

  lastMotionFrame = new Uint8ClampedArray(curr);
  if (countAll === 0) return 0;

  const motionNonFace = countNonFace > 0 ? (sumDiffNonFace / (255 * countNonFace)) : 0;
  const motionAll = sumDiffAll / (255 * countAll);
  motionHistory.push(motionNonFace);
  if (motionHistory.length > motionHistoryLen) motionHistory.shift();
  motionLevel = motionHistory.reduce((a, b) => a + b, 0) / motionHistory.length;

  if (motionLevel > motionHighThreshold) isHighMotion = true;
  else if (motionLevel < motionLowThreshold) isHighMotion = false;

  return motionLevel;
}

function detectRestrictedItems(data,width,height){
  const lowerY = Math.floor(height * 0.55);
  let brightCount = 0, darkCount = 0, blockMatches = 0;
  const area = (data.length - lowerY * width * 4) / 4;
  const blockSize = 16;

  for(let by = lowerY; by < height; by += blockSize){
    for(let bx = 0; bx < width; bx += blockSize){
      let sum = 0, sumSq = 0, count = 0;
      for(let y = by; y < Math.min(height, by + blockSize); y++){
        for(let x = bx; x < Math.min(width, bx + blockSize); x++){
          const i = (y * width + x) * 4;
          const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          sum += l;
          sumSq += l * l;
          count++;
        }
      }
      if(count === 0) continue;
      const avg = sum / count;
      const variance = (sumSq / count) - (avg * avg);
      if(avg > 210) brightCount += count;
      else if(avg < 45) darkCount += count;
      if(variance > 900 && (avg > 210 || avg < 45)){
        blockMatches++;
      }
    }
  }

  const isLargeRestrictedPatch = area > 0 && (blockMatches >= 8 || brightCount / area > 0.38 || darkCount / area > 0.38);
  if(isLargeRestrictedPatch){
    recordProctorEvent('restricted_object','Potential restricted item detected in the camera view',16);
  }
}

// Enumerate media devices and surface diagnostics to the overlay
async function listMediaDevices(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices){
    const diag = document.getElementById('camera-diagnostics'); if(diag) diag.textContent = 'Device enumeration not supported by this browser.';
    return [];
  }
  try{
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d=>d.kind==='videoinput');
    const mics = devices.filter(d=>d.kind==='audioinput');
    const outs = devices.filter(d=>d.kind==='audiooutput');
    const lines = [];
    lines.push(`Detected devices: ${devices.length}`);
    lines.push(`Cameras (${cams.length}): ${cams.map(d=>d.label||'(label hidden)').join(', ') || 'none'}`);
    lines.push(`Microphones (${mics.length}): ${mics.map(d=>d.label||'(label hidden)').join(', ') || 'none'}`);
    lines.push(`Outputs (${outs.length}): ${outs.map(d=>d.label||'(label hidden)').join(', ') || 'none'}`);
    const msg = lines.join('\n');
    const diag = document.getElementById('camera-diagnostics'); if(diag) diag.textContent = msg; else console.info(msg);
    return devices;
  }catch(err){ const diag = document.getElementById('camera-diagnostics'); if(diag) diag.textContent = 'Could not enumerate devices: '+(err && err.message?err.message:String(err)); return []; }
}

function estimateGazeFromFace(frame, face, width, height){
  // frame: ImageData (width x height)
  // face: boundingBox with x,y,width,height in same coords as frame
  const sx = Math.max(0, Math.floor(face.x));
  const sy = Math.max(0, Math.floor(face.y));
  const sw = Math.max(16, Math.min(width - sx, Math.floor(face.width)));
  const sh = Math.max(16, Math.min(height - sy, Math.floor(face.height)));
  // focus on upper portion (eyes)
  const ey = sy;
  const eh = Math.max(6, Math.floor(sh * 0.45));
  const data = frame.data;

  // column-wise dark pixel counts
  const colCounts = new Uint16Array(sw);
  for(let x=0;x<sw;x++){
    let cnt = 0;
    for(let y=0;y<eh;y++){
      const px = ( (ey + y) * width + (sx + x) ) * 4;
      const r = data[px], g = data[px+1], b = data[px+2];
      const l = 0.2126*r + 0.7152*g + 0.0722*b;
      if(l < 60) cnt++;
    }
    colCounts[x] = cnt;
  }

  // find two largest peaks (left and right eye)
  let firstIdx = -1, secondIdx = -1, firstVal = 0, secondVal = 0;
  for(let i=0;i<sw;i++){
    const v = colCounts[i];
    if(v > firstVal){ secondVal = firstVal; secondIdx = firstIdx; firstVal = v; firstIdx = i; }
    else if(v > secondVal){ secondVal = v; secondIdx = i; }
  }
  if(firstIdx < 0 || secondIdx < 0) return {confidence:0, gx:0, gy:0};
  // ensure left/right ordering
  let left = Math.min(firstIdx, secondIdx), right = Math.max(firstIdx, secondIdx);
  // require separation and minimum counts
  const separation = right - left;
  if(separation < Math.max(6, sw * 0.12)) return {confidence:0, gx:0, gy:0};
  const minCount = Math.max(4, Math.floor(eh * 0.06));
  if(colCounts[left] < minCount || colCounts[right] < minCount) return {confidence:0, gx:0, gy:0};

  // compute normalized gaze X relative to face center: -1 left, 0 center, +1 right
  const eyesCenterX = (left + right) / 2 + sx;
  const faceCenterX = sx + sw / 2;
  const gx = (eyesCenterX - faceCenterX) / (sw/2);
  // compute vertical offset as difference between eye row and center
  // simple proxy: compute row with max dark counts
  let rowCounts = new Uint16Array(eh);
  for(let y=0;y<eh;y++){
    let cnt=0;
    for(let x=0;x<sw;x++){ const px = ((ey+y)*width + (sx+x))*4; const l = 0.2126*data[px] + 0.7152*data[px+1] + 0.0722*data[px+2]; if(l<60) cnt++; }
    rowCounts[y]=cnt;
  }
  let maxRow=0, maxRowVal=0; for(let y=0;y<eh;y++){ if(rowCounts[y]>maxRowVal){ maxRowVal=rowCounts[y]; maxRow=y; }}
  const gy = (maxRow - eh/2) / (eh/2);
  // confidence based on peak strengths
  const rawConfidence = Math.min(1, (colCounts[left] + colCounts[right]) / (eh * 8));
  // penalize confidence by recent motion to reduce false positives during subtle motion
  const motionPenalty = Math.min(0.5, motionLevel * 6.0); // up to 50% penalty
  const baselineBoost = 0.15; // small boost for multi-frame smoothing
  const timeSmoothed = (rawConfidence * (1 - motionPenalty)) + baselineBoost * 0.5;
  const finalConfidence = Math.max(0, Math.min(1, timeSmoothed));

  const isLookingAway = (Math.abs(gx) > 0.25) || (gy < -0.25);
  return {confidence: finalConfidence, gx: gx, gy: gy, isLookingAway};
}

function updateGazeHistory(gx, gy){
  gazeHistory.push({gx, gy, t: Date.now()});
  if(gazeHistory.length > GAZE_SAMPLE_SIZE) gazeHistory.shift();
}

function checkGazeBehavior(){
  if(gazeHistory.length < GAZE_CONSECUTIVE_LIMIT) return;
  // check last N samples
  const recent = gazeHistory.slice(-GAZE_CONSECUTIVE_LIMIT);
  let awayCount = 0;
  for(const s of recent){ if(Math.abs(s.gx) > GAZE_THRESHOLD_X) awayCount++; }
  if(awayCount >= GAZE_CONSECUTIVE_LIMIT){
    recordProctorEvent('gaze_away','Student appears to be looking away from the screen repeatedly',14);
    // avoid repeated rapid events: clear gazeHistory
    gazeHistory = [];
  }
}

function pauseExam(reason){
  if(examPausedDueCamera) return;
  examPausedDueCamera = true;
  pauseReason = reason || 'Camera issue';
  if(timerInterval){ clearInterval(timerInterval); timerInterval = null; }
  const overlay = document.getElementById('camera-overlay');
  if(overlay){ overlay.style.display = 'flex'; }
  updateCameraStatus(`Paused: ${pauseReason}`,'Exam paused until issue is resolved');
  setStartButtonEnabled(false);
  // disable answering while paused
  setExamInputsDisabled(true);
}

function resumeExam(){
  if(!examPausedDueCamera) return;
  examPausedDueCamera = false;
  const overlay = document.getElementById('camera-overlay');
  if(overlay){ overlay.style.display = 'none'; }
  updateCameraStatus('Camera active','');
  updateStartButtonState();
  // re-enable answering
  setExamInputsDisabled(false);
  if(timeLeft > 0){
    timerInterval = setInterval(()=>{ timeLeft--; updateTimerDisplay(); if(timeLeft<=0){ clearInterval(timerInterval); submitExam(true); } }, 1000);
  } else {
    document.getElementById('timer-display').textContent = 'No limit';
  }
  toast('Camera restored. Exam resumed.');
}

function retryCameraAccess(){ ensureCameraAccess(); }

async function testCameraOnce(){
  const diag = document.getElementById('camera-diagnostics'); if(diag) diag.textContent = '';
  try{
    const ok = await ensureCameraAccess();
    if(ok){
      updateCameraStatus('Camera active','');
      hideCameraOverlay();
      toast('Camera test successful');
      return true;
    }else{
      toast('Camera test failed');
      return false;
    }
  }catch(e){
    const em = e && e.message ? e.message : String(e);
    const diag = document.getElementById('camera-diagnostics'); if(diag) diag.textContent = em;
    updateCameraStatus('Camera error', em);
    showCameraOverlay('Camera test failed: '+em);
    setStartButtonEnabled(false);
    try{ listMediaDevices(); }catch(_){}
    return false;
  }
}

function updateCameraStatus(text, warning){ const status = document.getElementById('camera-status'); if(status) status.textContent = text; const alert = document.getElementById('camera-alert'); if(alert) alert.textContent = warning || ''; }

function showCameraOverlay(message){ const overlay = document.getElementById('camera-overlay'); if(overlay){ overlay.style.display = 'flex'; const p = overlay.querySelector('p'); if(p) p.textContent = message; } }

function hideCameraOverlay(){ const overlay = document.getElementById('camera-overlay'); if(overlay){ overlay.style.display = 'none'; } }

function setStartButtonEnabled(enabled){
  const btn = document.getElementById('start-btn');
  if(!btn) return;
  btn.disabled = !enabled;
  btn.style.opacity = enabled ? '' : '0.6';
}

function updateStartButtonState(){
  setStartButtonEnabled(calibrationPassed && !examPausedDueCamera);
}

function updateCalibrationProgress(faceSeen){
  if(proctorSession) return;
  if(faceSeen){
    calibrationConsecutive = Math.min(CALIBRATION_REQUIRED, calibrationConsecutive + 1);
  } else {
    calibrationConsecutive = Math.max(0, calibrationConsecutive - CALIBRATION_DECAY);
  }
  calibrationPassed = calibrationConsecutive >= CALIBRATION_REQUIRED;
  updateCalibrationUI(calibrationPassed, 0, 0, calibrationConsecutive);
  updateStartButtonState();
}

function updateCalibrationUI(passed, dxPct=0, dyPct=0, count=0){
  const msg = document.getElementById('calib-msg');
  const status = document.getElementById('calib-status');
  if(msg){ msg.textContent = passed ? 'Face detected — ready to start' : 'Hold still while we detect your face…'; }
  if(status){
    status.textContent = passed ? 'Ready to start' : `${count}/${CALIBRATION_REQUIRED}`;
    status.style.color = passed ? '#10b981' : '#f59e0b';
  }
  try{
    const fill = document.getElementById('calib-progress-fill');
    if(fill){
      const pct = Math.min(100, Math.round((count / CALIBRATION_REQUIRED) * 100));
      fill.style.width = pct + '%';
    }
  }catch(e){}
}

function disableCalibration(){
  calibrationPassed = false;
  calibrationHistory = [];
  calibrationConsecutive = 0;
  autoStartedOnCalibration = false;
  updateCalibrationUI(false, 0, 0, 0);
  updateStartButtonState();
}

function handleKeydown(e){
  if(!proctorSession) return;
  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if(ctrl && ['u','s','p'].includes(key)){
    e.preventDefault();
    recordProctorEvent('inspection_attempt',`Blocked shortcut Ctrl+${e.key.toUpperCase()}`,12);
  }
  if(e.key === 'F12' || (ctrl && e.shiftKey && ['i','j','c'].includes(key))){
    e.preventDefault();
    recordProctorEvent('devtools_attempt','Blocked developer tools shortcut',16);
  }
  if(ctrl && key === 'c' && document.activeElement?.tagName !== 'TEXTAREA'){
    e.preventDefault();
    recordProctorEvent('copy_attempt','Blocked Ctrl+C outside answer field',14);
  }
  if(ctrl && key === 'v'){
    e.preventDefault();
    recordProctorEvent('paste_attempt','Blocked Ctrl+V paste',14);
  }
  const active = document.activeElement;
  if(active && active.tagName === 'TEXTAREA' && !['F12','Escape'].includes(e.key)){
    const now = Date.now();
    if(proctorSession.lastKeyTime){
      const interval = now - proctorSession.lastKeyTime;
      proctorSession.typingHistory.push(interval);
      if(proctorSession.typingHistory.length > 40) proctorSession.typingHistory.shift();
      const recentAvg = proctorSession.typingHistory.reduce((a,b)=>a+b,0)/proctorSession.typingHistory.length;
      if(recentAvg < 60 && proctorSession.typingHistory.length >= 15){
        recordProctorEvent('rapid_typing','Unusually fast typing detected',10);
        proctorSession.typingHistory = [];
      }
    }
    proctorSession.lastKeyTime = now;
  }
}

function generateProctorVerdict(session){
  if(!session.events.length) return 'ProctorVision monitored the exam and did not detect suspicious behavior.';
  const major = session.events.filter(e=>['devtools_attempt','paste_attempt','copy_attempt','focus_lost','tab_switch'].includes(e.type)).length;
  return `ProctorVision recorded ${session.events.length} suspicious behaviour events with a risk score of ${Math.min(100,session.score)}%. ${major>0 ? 'The system recommends teacher review before finalizing the score.' : ''}`;
}

function formatVerdictHtml(text){
  if(!text) return '';
  return escHtml(text).replace(/\n\n/g, '</p><p style="margin:.65rem 0 0">').replace(/\n/g, '<br/>');
}

function openProctorReport(submissionId){
  if(currentRole!=='teacher') return;
  const sub = data.submissions.find(s=>s.id===submissionId);
  if(!sub){ toast('Report not found.'); return; }
  const body = document.getElementById('proctor-modal-body');
  const report = sub.proctorData;
  const suspicion = getSubmissionSuspicion(sub);
  const riskClass = suspicion>=70 ? 'pill-red' : suspicion>=40 ? 'pill-yellow' : 'pill-green';
  const riskLabel = suspicion>=70 ? 'High' : suspicion>=40 ? 'Moderate' : 'Low';

  body.innerHTML = `<div style="margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center">
    <div><strong>Dynamic suspicion score:</strong> <span class="pill ${riskClass}">${suspicion}% ${riskLabel}</span></div>
    <span class="pill ${backendConnected?'pill-green':'pill-yellow'}" style="font-size:.72rem">${backendConnected?'Server score':'Local only'}</span>
  </div>
  <div id="ai-verdict-block" style="margin-bottom:1rem;padding:1rem;border:1px solid var(--border);border-radius:10px;background:#f8fafc">
    <div style="font-weight:600;margin-bottom:.5rem">AI Verdict</div>
    <div style="font-size:.88rem;color:var(--muted)">Loading narrative…</div>
  </div>
  <div style="font-weight:600;margin-bottom:.75rem">Event log</div>
  <div id="proctor-event-log">${report && report.events && report.events.length ? report.events.map(e=>`
    <div style="padding:.75rem;border:1px solid var(--border);border-radius:10px;margin-bottom:.6rem">
      <div style="font-size:.82rem;color:var(--muted);margin-bottom:.25rem">${escHtml(e.time)}</div>
      <div style="font-weight:600">${escHtml(e.details)}</div>
      <div style="font-size:.8rem;color:var(--muted);margin-top:.35rem">Type: ${escHtml(e.type)} · Weight: ${e.weight}</div>
    </div>`).join('') : '<div class="empty-state" style="padding:1rem"><div class="icon">Info</div><p>No suspicious activity was recorded for this exam.</p></div>'}</div>`;

  currentReportSubmissionId = submissionId;
  document.getElementById('proctor-modal').classList.add('show');
  document.getElementById('proctor-pdf-btn').style.display = backendConnected ? '' : 'none';

  fetchBackendReport(submissionId).then(backend=>{
    const block = document.getElementById('ai-verdict-block');
    if(!block) return;
    const verdictText = backend?.ai_verdict || sub.backendVerdict || (report ? report.verdict : '');
    if(backend || verdictText){
      block.innerHTML = `<div style="font-weight:600;margin-bottom:.5rem">AI Verdict</div>
        <div style="font-size:.88rem;line-height:1.65;color:var(--text)"><p style="margin:0">${formatVerdictHtml(verdictText)}</p></div>`;
      if(backend.events && backend.events.length){
        const log = document.getElementById('proctor-event-log');
        if(log) log.innerHTML = backend.events.map(e=>`
          <div style="padding:.75rem;border:1px solid var(--border);border-radius:10px;margin-bottom:.6rem">
            <div style="font-size:.82rem;color:var(--muted);margin-bottom:.25rem">${escHtml((e.created_at||'').slice(11,19))}</div>
            <div style="font-weight:600">${escHtml(e.details)}</div>
            <div style="font-size:.8rem;color:var(--muted);margin-top:.35rem">Type: ${escHtml(e.event_type)} · Weight: ${e.weight}</div>
          </div>`).join('');
      }
    } else {
      block.innerHTML = `<div style="font-weight:600;margin-bottom:.5rem">AI Verdict</div>
        <div style="font-size:.88rem;color:var(--muted)">No verdict available — backend may be offline.</div>`;
    }
  });
}

function closeProctorModal(){
  document.getElementById('proctor-modal').classList.remove('show');
  if(monitorInterval){ clearInterval(monitorInterval); monitorInterval = null; monitorExamId = null; }
}
function openExamMonitor(examId){
  monitorExamId = examId;
  const body = document.getElementById('proctor-modal-body');
  let backendExamEvents = [];
  async function fetchBackendExamEvents(){
    if(!backendConnected) return;
    try{
      const res = await fetch(`${BACKEND_URL}/api/live/feed?exam_id=${encodeURIComponent(examId)}&limit=50`);
      if(res.ok){ const d = await res.json(); backendExamEvents = d.events || []; }
    }catch(e){}
  }
  function render(){
    data = loadData();
    const exam = data.exams.find(e=>e.id===examId);
    const joins = (data.studentJoins||[]).filter(j=>j.examId===examId && j.status==='joined');
    const allLive = (data.liveEvents||[]).concat(liveEventBuffer||[]);
    const localEvents = allLive.filter(ev=>ev.examId===examId).slice(-200).reverse();
    const events = backendExamEvents.length
      ? backendExamEvents.map(ev=>({
          time: ev.created_at,
          studentName: ev.student_name,
          type: ev.event_type,
          details: ev.details,
          suspicion_score: ev.suspicion_score,
        }))
      : localEvents;
    const byStudent = {};
    if(backendExamEvents.length){
      joins.forEach(j=>{
        const key = j.studentName + '|' + examId;
        const sc = backendLiveScores[key];
        if(sc) byStudent[j.studentName] = sc.suspicion_score;
      });
      backendExamEvents.forEach(ev=>{
        if(!byStudent[ev.student_name]) byStudent[ev.student_name] = Math.min(100, ev.suspicion_score || 0);
      });
    } else {
      allLive.filter(ev=>ev.examId===examId).forEach(ev=>{
        byStudent[ev.studentName] = (byStudent[ev.studentName]||0) + (ev.weight||0);
      });
    }
    body.innerHTML = `<div style="font-weight:700;margin-bottom:.5rem">Monitoring: ${escHtml(exam?exam.title:'Exam')}</div>
      <div style="font-size:.9rem;color:var(--muted);margin-bottom:.6rem">Exam ID: ${escHtml(exam?exam.id:'—')}</div>
      <div style="display:flex;gap:1rem;margin-bottom:.6rem"><div style="flex:1"><div style="font-weight:600">Joined Students</div>
        ${(joins.length?joins.map(j=>{
          const suspicion = Math.min(100, Math.round((byStudent[j.studentName]||0)));
          return `<div style="padding:.4rem 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <div>${escHtml(j.studentName)} · ${new Date(j.joinedAt).toLocaleTimeString()}</div>
            <div style="display:flex;gap:.4rem;align-items:center"><div style="font-weight:700;color:${suspicion>=70?'#dc2626':suspicion>=40?'#f59e0b':'#10b981'}">${suspicion}%</div><button class=\"btn btn-ghost btn-sm\" onclick=\"teacherFlag('${examId}','${escHtml(j.studentName)}')\">🚩 Flag</button></div>
          </div>`;
        }).join(''):'<div style="color:var(--muted);padding:.4rem">No students joined yet.</div>')}</div>
      <div style="flex:2"><div style="font-weight:600">Live Events</div>
        ${(events.length?events.map(ev=>`<div style="padding:.6rem;border:1px solid var(--border);border-radius:8px;margin-bottom:.5rem"><div style="font-size:.82rem;color:var(--muted)">${new Date(ev.time).toLocaleTimeString()}</div><div style="font-weight:600">${escHtml(ev.studentName)} · ${escHtml(ev.type)}</div><div style="font-size:.86rem;color:var(--muted)">${escHtml(ev.details)}</div></div>`).join(''):'<div style="color:var(--muted);padding:.4rem">No live events yet.</div>')}</div></div>`;
  }
  fetchBackendExamEvents().then(render);
  document.getElementById('proctor-modal').classList.add('show');
  if(monitorInterval) clearInterval(monitorInterval);
  monitorInterval = setInterval(()=>{ fetchBackendExamEvents().then(render); }, 1500);
}

async function teacherFlag(examId, studentName){
  data = loadData();
  data.liveEvents = data.liveEvents || [];
  const now = new Date();
  const ev = { examId, studentName, time: now.toISOString(), type: 'teacher_flag', details: 'Flagged by teacher', weight: 20 };
  data.liveEvents.push(ev);
  liveEventBuffer.push(ev);
  saveData();
  if(backendConnected){
    try{
      const exam = data.exams.find(e=>e.id===examId);
      await fetch(`${BACKEND_URL}/api/teacher/flag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exam_id: examId, student_name: studentName, exam_title: exam?.title || '' }),
      });
    }catch(e){ /* local flag still saved */ }
  }
  toast('Student flagged for review.');
}

function formatAns(ans,r){
  if(ans===undefined||ans===null||ans==='') return '(no answer)';
  if(r.qtype==='mcq'&&typeof ans==='number'&&r.choices) return String.fromCharCode(65+ans)+'. '+(r.choices[ans]||'');
  return String(ans);
}

function exitExam(){
  if(timerInterval) clearInterval(timerInterval);
  if(proctorSession) stopProctoring();
  else closeCameraStream();
  resetCameraExamState();
  document.getElementById('exam-shell').classList.remove('show');
  activeExam=null; answers={};
  data = loadData();
  const activePage = document.querySelector('.page.active')?.id?.replace('page-','');
  if(currentRole==='student'&&activePage) navStudent(activePage, document.querySelector('#sidebar a.active'));
}
