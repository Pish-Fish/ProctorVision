// ════════════════════════════════════════
// SHARED DATA
// ════════════════════════════════════════
const STORAGE_KEY = 'lms_data_v2';
const STUDENT_ACCOUNTS = [
  { id:'stu1', name:'Juan Dela Cruz', initials:'JD', studentId:'2024-0001', email:'juan.delacruz@student.imms.edu.ph', program:'BS Marine Transportation', year:'1st Year' },
  { id:'stu2', name:'Maria Santos', initials:'MS', studentId:'2024-0002', email:'maria.santos@student.imms.edu.ph', program:'BS Marine Engineering', year:'1st Year' },
  { id:'stu3', name:'Pedro Reyes', initials:'PR', studentId:'2024-0003', email:'pedro.reyes@student.imms.edu.ph', program:'BS Marine Transportation', year:'2nd Year' },
  { id:'stu4', name:'Ana Lim', initials:'AL', studentId:'2024-0004', email:'ana.lim@student.imms.edu.ph', program:'BS Customs Administration', year:'1st Year' },
  { id:'stu5', name:'Carlo Mendoza', initials:'CM', studentId:'2024-0005', email:'carlo.mendoza@student.imms.edu.ph', program:'BS Marine Engineering', year:'2nd Year' },
  { id:'stu6', name:'Rhea Dizon', initials:'RD', studentId:'2024-0006', email:'rhea.dizon@student.imms.edu.ph', program:'BS Customs Administration', year:'2nd Year' },
  { id:'stu7', name:'Kevin Cruz', initials:'KC', studentId:'2024-0007', email:'kevin.cruz@student.imms.edu.ph', program:'BS Marine Engineering', year:'2nd Year' },
  { id:'stu8', name:'Liza Bautista', initials:'LB', studentId:'2024-0008', email:'liza.bautista@student.imms.edu.ph', program:'BS Marine Transportation', year:'1st Year' },
  { id:'stu9', name:'Mark Tolentino', initials:'MT', studentId:'2024-0009', email:'mark.tolentino@student.imms.edu.ph', program:'BS Customs Administration', year:'2nd Year' },
];
let currentStudentId = localStorage.getItem('pv_current_student_id') || STUDENT_ACCOUNTS[0].id;
let STUDENT_NAME = getCurrentStudent().name;

let currentRole = null;
let data = loadData();
let proctorSession = null;
let monitorInterval = null, monitorExamId = null;
let monitorGeneration = 0;
let monitorLiveEventHandler = null;
let monitorSessionJoinedHandler = null;
let monitorScoreUpdateHandler = null;
let monitorStudentSelectionHandler = null;
let monitorBlinkTimeouts = new Map();
let monitorAudioContext = null;
let teacherSessionCounts = new Map();
let teacherSessionsInterval = null;
let teacherSessionsRefreshInFlight = false;
// Live event buffering to reduce localStorage churn
let liveEventBuffer = [];
let liveEventFlushTimer = null;
const LIVE_EVENT_FLUSH_MS = 150;
// The static frontend is served on :8000; the Flask API and Socket.IO server
// are always on :5000 of the same machine/IP address.
const BACKEND_PORT = 5000;
const BACKEND_URL = `http://${location.hostname}:${BACKEND_PORT}`;
let backendSocket = null;
let backendSessionId = null;
let backendConnected = false;
let lmsSyncTimer = null;
let lmsPushTimer = null;
let backendLiveEvents = [];
let backendLiveScores = {};
let currentReportSubmissionId = null;

// Exam-taking state
let activeExam = null, answers = {}, currentQ = 0, timerInterval = null, timeLeft = 0;
const PROCTOR_WEIGHT_MULTIPLIER = 0.6;
const EVENT_COOLDOWN_MS = 10000;
let editingExamId = null, qCount = 0;
let examInputsDisabled = false;

function normalizeQuestion(q, index){
  if(typeof q === 'string') return { text: q, qtype: 'short', points: 1, choices: [], correct: undefined, _index: index };
  const qtype = q?.qtype || 'short';
  return {
    text: q?.text || `Question ${index + 1}`,
    qtype,
    points: Number(q?.points) || 1,
    choices: Array.isArray(q?.choices) && q.choices.length ? q.choices : (qtype === 'tf' ? ['true','false'] : []),
    correct: q?.correct,
    _index: index,
  };
}

function shuffleArray(items){
  const copy = [...items];
  for(let i = copy.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randomizeExamQuestions(exam){
  const normalized = (exam?.questions || []).map((q, i) => normalizeQuestion(q, i));
  if(!normalized.length) return [];

  const questionOrder = shuffleArray(normalized.map((_, i) => i));

  return questionOrder.map(originIndex => {
    const question = normalized[originIndex];
    const randomized = { ...question, originalIndex: originIndex };

    if(question.qtype === 'mcq' && Array.isArray(question.choices) && question.choices.length > 1){
      const choiceOrder = shuffleArray(question.choices.map((_, i) => i));
      randomized.choices = choiceOrder.map(choiceIndex => question.choices[choiceIndex]);
      const correctIndex = Number(question.correct);
      if(Number.isInteger(correctIndex) && correctIndex >= 0 && correctIndex < question.choices.length){
        randomized.correct = choiceOrder.indexOf(correctIndex);
      }
    }

    if(question.qtype === 'tf'){
      const tfChoices = Array.isArray(question.choices) && question.choices.length
        ? question.choices
        : ['true', 'false'];
      randomized.choices = shuffleArray(tfChoices);
    }

    return randomized;
  });
}

function setExamInputsDisabled(disabled){
  examInputsDisabled = !!disabled;
  try{
    ['btn-prev','btn-next','btn-submit','btn-prev-inline','btn-next-inline'].forEach(id=>{ const b=document.getElementById(id); if(b) { b.disabled = disabled; b.style.opacity = disabled ? '0.6' : ''; } });
    document.querySelectorAll('#question-area textarea, #question-area input, #question-area select').forEach(el=>{ el.disabled = disabled; });
  }catch(e){ /* ignore UI update errors */ }
}

function applyRemoteLmsData(remote){
  if(!remote) return;
  const local = loadData();
  data = {
    ...local,
    courses: remote.courses ?? local.courses,
    exams: remote.exams ?? local.exams,
    studentEnrollments: remote.studentEnrollments ?? local.studentEnrollments,
    submissions: remote.submissions ?? local.submissions,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getLmsPayload(){
  return {
    courses: data.courses || [],
    exams: data.exams || [],
    studentEnrollments: data.studentEnrollments || [],
    submissions: data.submissions || [],
  };
}

function hasMeaningfulLmsData(payload){
  const courses = payload?.courses || [];
  const exams = payload?.exams || [];
  const enrollments = payload?.studentEnrollments || [];
  const hasJoinCodes = courses.some(c => c.joinCode || c.enrollCode);
  return exams.length > 0 || enrollments.length > 0 || hasJoinCodes || courses.length > 3;
}

async function pushLmsToBackend(){
  try{
    const res = await fetch(`${BACKEND_URL}/api/lms/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getLmsPayload()),
    });
    if(res.ok) backendConnected = true;
    return res.ok;
  }catch(e){
    return false;
  }
}

async function syncLmsFromBackend(){
  try{
    const res = await fetch(`${BACKEND_URL}/api/lms/data`);
    if(!res.ok) return false;
    backendConnected = true;
    const remote = await res.json();
    if(hasMeaningfulLmsData(remote)){
      applyRemoteLmsData(remote);
      return true;
    }
    if(hasMeaningfulLmsData(getLmsPayload())){
      await pushLmsToBackend();
      return true;
    }
    applyRemoteLmsData(remote);
    return true;
  }catch(e){
    return false;
  }
}

function scheduleLmsPush(){
  if(lmsPushTimer) clearTimeout(lmsPushTimer);
  lmsPushTimer = setTimeout(()=>{
    lmsPushTimer = null;
    pushLmsToBackend();
  }, 200);
}

function startLmsSyncPolling(){
  stopLmsSyncPolling();
  lmsSyncTimer = setInterval(async ()=>{
    const changed = await syncLmsFromBackend();
    if(changed) handleRemoteDataUpdate();
  }, 3000);
}

function stopLmsSyncPolling(){
  if(lmsSyncTimer){ clearInterval(lmsSyncTimer); lmsSyncTimer = null; }
  if(lmsPushTimer){ clearTimeout(lmsPushTimer); lmsPushTimer = null; }
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
      studentEnrollments: parsed?.studentEnrollments ?? [],
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
      studentEnrollments:[],
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
  scheduleLmsPush();
}
function handleRemoteDataUpdate(){
  data = loadData();
  if(currentRole === 'teacher'){
    const page = document.querySelector('.page.active')?.id?.replace('page-','') || 'dashboard';
    if(page === 'dashboard') renderTeacherDashboard();
    if(page === 'courses') renderCoursesWithEnrollmentCodes();
    if(page === 'exams') renderExams();
    if(page === 'sessions') renderTeacherSessions();
    if(page === 'results') renderTeacherResults();
    if(page === 'grades') renderGrades();
  }
  if(currentRole === 'student'){
    const page = document.querySelector('.page.active')?.id?.replace('page-','') || 'dashboard';
    if(page === 'dashboard') renderStudentDashboard();
    if(page === 'courses') renderStudentCourses();
    if(page === 'exams') renderAvailableExams();
    if(page === 'results') renderStudentResults();
  }
  if(currentRole === 'admin'){
    const page = document.querySelector('.page.active')?.id?.replace('page-','') || 'dashboard';
    if(page === 'dashboard') renderAdminDashboard();
    if(page === 'courses') renderAdminCourses();
    if(page === 'exams') renderAdminExams();
  }
}
window.addEventListener('storage', e => {
  if(e.key === STORAGE_KEY) handleRemoteDataUpdate();
});
window.addEventListener('lms-data-update', handleRemoteDataUpdate);
function toast(msg, d=4200){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), d);
}
function escHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function getCurrentStudent(){
  return STUDENT_ACCOUNTS.find(s=>s.id===currentStudentId) || STUDENT_ACCOUNTS[0];
}

function updateStudentIdentity(){
  const student = getCurrentStudent();
  STUDENT_NAME = student.name;
  const avatar = document.getElementById('user-avatar');
  const name = document.getElementById('user-name');
  if(avatar) avatar.textContent = student.initials;
  if(name) name.textContent = student.name;
}

function switchStudentAccount(studentId){
  if(!STUDENT_ACCOUNTS.some(s=>s.id===studentId)) return;
  currentStudentId = studentId;
  localStorage.setItem('pv_current_student_id', currentStudentId);
  updateStudentIdentity();
  data = loadData();
  if(currentRole === 'student'){
    const activePage = document.querySelector('.page.active')?.id?.replace('page-','') || 'dashboard';
    renderStudentAccountSwitcher();
    if(activePage === 'dashboard') renderStudentDashboard();
    if(activePage === 'courses') renderStudentCourses();
    if(activePage === 'exams') renderAvailableExams();
    if(activePage === 'results') renderStudentResults();
    if(activePage === 'profile') renderStudentProfile();
    toast(`Switched to ${getCurrentStudent().name}.`);
  }
}

function normalizeCode(value){
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function generateCourseJoinCode(){
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const group = () => Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  let code = '';
  do {
    code = `${group()}-${group()}`;
  } while(data.courses?.some(c => normalizeCode(c.joinCode) === normalizeCode(code)));
  return code;
}

function getCourseJoinCode(course){
  return course?.joinCode || course?.enrollCode || '';
}

function getEnrolledCourseIds(){
  return (data.studentEnrollments || [])
    .filter(e => e.studentName === STUDENT_NAME)
    .map(e => e.courseId);
}

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
    await syncLmsFromBackend();
    startLmsSyncPolling();
    if(role === 'teacher'){
      await refreshBackendLiveFeed();
      renderTeacherLiveFeed();
    }
    console.info('[ProctorVision]', health.service, 'connected', health.stack);
  }catch(e){
    backendConnected = false;
    stopLmsSyncPolling();
    console.warn('[ProctorVision] Backend offline — running in local-only mode');
    toast('Backend offline — course and exam data will not sync across devices.');
  }
}

function connectBackendSocket(role){
  if(typeof io === 'undefined') return;
  if(backendSocket){ backendSocket.disconnect(); backendSocket = null; }
  // Flask-SocketIO is currently served by Werkzeug in threading mode. Werkzeug
  // cannot handle WebSocket upgrades reliably, so use Socket.IO polling here.
  // Polling still delivers the live teacher/student updates over the LAN.
  backendSocket = io(BACKEND_URL, { transports: ['polling'] });
  backendSocket.on('connect', ()=>{
    backendSocket.emit('join_role', { role });
  });
  backendSocket.on('live_event', ev=>{
    const liveEvent = { ...ev, time: ev.time || ev.created_at || new Date().toISOString() };
    backendLiveEvents.unshift(liveEvent);
    backendLiveEvents = backendLiveEvents.slice(0, 50);
    if(currentRole === 'teacher'){
      renderTeacherLiveFeed();
      if(monitorLiveEventHandler) monitorLiveEventHandler(liveEvent);
    }
  });
  backendSocket.on('score_update', sc=>{
    backendLiveScores[sc.student_name + '|' + sc.exam_id] = sc;
    if(currentRole === 'teacher'){
      renderTeacherLiveFeed();
      if(monitorScoreUpdateHandler) monitorScoreUpdateHandler(sc);
    }
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
      refreshBackendTeacherSessionCounts();
      toast(`ProctorVision: ${alert.student_name} submitted (${alert.suspicion_score}% risk)`);
    }
  });
  backendSocket.on('session_joined', info=>{
    const joinedEvent = {
      type: 'session_join',
      exam_id: info.exam_id,
      session_id: info.session_id,
      student_name: info.student_name,
      exam_title: info.exam_title,
      details: 'Joined monitored exam session',
      time: new Date().toISOString(),
    };
    backendLiveEvents.unshift(joinedEvent);
    if(currentRole === 'teacher'){
      renderTeacherLiveFeed();
      refreshBackendTeacherSessionCounts();
      if(monitorSessionJoinedHandler) monitorSessionJoinedHandler(info);
    }
  });
  backendSocket.on('lms_updated', async ()=>{
    const changed = await syncLmsFromBackend();
    if(changed) handleRemoteDataUpdate();
  });
}

async function refreshBackendLiveFeed(){
  if(!backendConnected) return;
  try{
    const res = await fetch(`${BACKEND_URL}/api/live/feed?limit=30`);
    if(!res.ok) return;
    const data = await res.json();
    backendLiveEvents = (data.events || []).map(ev=>{
      const exam = (data.exams || []).find(item=>item.id===ev.exam_id);
      return {
        type: ev.event_type,
        student_name: ev.student_name,
        exam_id: ev.exam_id,
        exam_title: exam?.title || '',
        details: ev.details,
        weight: ev.weight,
        suspicion_score: ev.suspicion_score,
        time: ev.created_at,
      };
    });
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
    liveFeed.innerHTML = '<div class="empty-state" style="padding:1rem;box-shadow:none;background:transparent;border:none;color:var(--muted)"><div class="icon">Info</div><p>No student activity yet. Events will appear here while monitored exams are in progress.</p></div>';
    return;
  }
  liveFeed.innerHTML = `<div class="live-feed-summary">${backendLiveEvents.length} recent event${backendLiveEvents.length===1?'':'s'} · newest first. Review signals need context and are not proof of misconduct.</div>
    ${backendLiveEvents.slice(0, 12).map(renderTeacherEventCard).join('')}`;
}

function proctorEventLabel(type){
  const labels = {
    tab_switch: 'Browser tab or window changed',
    focus_lost: 'Exam window lost focus',
    focus_return: 'Returned to the exam',
    focus_regained: 'Exam window regained focus',
    copy_attempt: 'Copy attempt blocked',
    paste_attempt: 'Paste attempt blocked',
    devtools_attempt: 'Developer tools shortcut blocked',
    inspection_attempt: 'Page inspection shortcut blocked',
    session_join: 'Joined the monitored exam',
    submission: 'Submitted the exam',
    teacher_flag: 'Flagged for teacher review',
    screenshot_attempt: 'Print Screen key pressed',
  };
  return labels[type] || String(type || 'Exam activity').replace(/_/g, ' ').replace(/\b\w/g, char=>char.toUpperCase());
}

function renderTeacherEventCard(ev){
  const type = ev.type || ev.event_type || 'event';
  const reviewTypes = ['tab_switch','focus_lost','copy_attempt','paste_attempt','devtools_attempt','inspection_attempt','screenshot_attempt','teacher_flag'];
  const reviewSignal = reviewTypes.includes(type);
  const name = ev.student_name || ev.studentName || 'Student';
  const details = ev.details || '';
  const eventTime = ev.time || ev.created_at;
  const timestamp = eventTime ? new Date(eventTime) : null;
  const timeLabel = timestamp && !Number.isNaN(timestamp.getTime())
    ? timestamp.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : '';
  const score = ev.suspicion_score != null && Number.isFinite(Number(ev.suspicion_score))
    ? `<span class="live-event-score">Session risk score <strong>${escHtml(String(ev.suspicion_score))}%</strong></span>`
    : '';
  const examTitle = ev.exam_title ? `<span>${escHtml(ev.exam_title)}</span>` : '';

  return `<article class="live-event-card${reviewSignal?' review-signal':''}">
    <div class="live-event-heading">
      <div class="live-event-title">${escHtml(proctorEventLabel(type))}</div>
      <span class="live-event-badge ${reviewSignal?'review':'activity'}">${reviewSignal?'Review signal':'Activity'}</span>
    </div>
    ${details ? `<div class="live-event-details">${escHtml(details)}</div>` : ''}
    <div class="live-event-meta"><strong>${escHtml(name)}</strong>${examTitle}${timeLabel?`<time>${escHtml(timeLabel)}</time>`:''}</div>
    ${score ? `<div class="live-event-score-row">${score}</div>` : ''}
  </article>`;
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
function setStudentAccountControlsVisible(visible){
  const wrap = document.querySelector('.topbar-user-wrap');
  const trigger = document.getElementById('student-account-trigger');
  const menu = document.getElementById('student-account-switcher-strip');

  if(wrap) wrap.style.display = visible ? '' : 'none';
  if(trigger) trigger.setAttribute('aria-expanded', 'false');
  if(menu) menu.style.display = 'none';
}

function isMobileDevice(){
  const ua = navigator.userAgent || navigator.vendor || '';
  if(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)) return true;
  // iPadOS 13+ reports as Macintosh with touch
  if(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  return false;
}

function isIOSDevice(){
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function showStudentDeviceBlock(){
  const block = document.getElementById('student-device-block');
  if(block) block.hidden = false;
  document.getElementById('role-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'none';
}

function dismissStudentDeviceBlock(){
  const block = document.getElementById('student-device-block');
  if(block) block.hidden = true;
  document.getElementById('role-screen').style.display = 'flex';
  currentRole = null;
}

function setPortalBodyClass(role){
  document.body.classList.remove('portal-admin','portal-teacher','portal-student','sidebar-open');
  if(role) document.body.classList.add('portal-'+role);
}

function toggleAppNav(){
  if(currentRole === 'student') return;
  document.body.classList.toggle('sidebar-open');
}

function closeAppNav(){
  document.body.classList.remove('sidebar-open');
}

function enterPortal(role){
  if(role === 'student' && !isMobileDevice()){
    showStudentDeviceBlock();
    return;
  }
  currentRole = role;
  data = loadData();
  setPortalBodyClass(role);
  closeAppNav();
  document.getElementById('role-screen').style.display = 'none';
  const block = document.getElementById('student-device-block');
  if(block) block.hidden = true;
  setStudentAccountControlsVisible(role === 'student');
  const shell = document.getElementById('app-shell');
  shell.style.display = 'flex';

  const finishPortalSetup = () => {
    if(role === 'admin'){
      setStudentAccountControlsVisible(false);
      document.documentElement.style.setProperty('--sidebar','#ffffff');
      document.documentElement.style.setProperty('--sidebar-hover','#fff8e1');
      document.documentElement.style.setProperty('--accent','#4169e1');
      document.documentElement.style.setProperty('--accent2','#d4af37');
      document.getElementById('topbar').style.background = '#1e3a8a';
      const sidebar = document.getElementById('sidebar');
      if(sidebar){ sidebar.style.background = '#ffffff'; sidebar.style.color = '#111827'; sidebar.style.boxShadow = 'inset -1px 0 0 rgba(15,23,42,.08)'; }
      document.getElementById('portal-label').textContent = 'Admin Portal';
      document.getElementById('portal-label').style.color = '#eef4ff';
      document.getElementById('user-avatar').textContent = 'AD';
      document.getElementById('user-avatar').style.background = '#d4af37';
      document.getElementById('user-name').textContent = 'System Administrator';
      buildAdminUI();
      navAdmin('dashboard', null);
    } else if(role === 'teacher'){
      setStudentAccountControlsVisible(false);
      document.documentElement.style.setProperty('--sidebar','#ffffff');
      document.documentElement.style.setProperty('--sidebar-hover','#fff8e1');
      document.documentElement.style.setProperty('--accent','#4169e1');
      document.documentElement.style.setProperty('--accent2','#d4af37');
      document.getElementById('topbar').style.background = '#1e3a8a';
      const sidebar = document.getElementById('sidebar');
      if(sidebar){ sidebar.style.background = '#ffffff'; sidebar.style.color = '#111827'; sidebar.style.boxShadow = 'inset -1px 0 0 rgba(15,23,42,.08)'; }
      document.getElementById('portal-label').textContent = 'Teacher Portal';
      document.getElementById('portal-label').style.color = '#eef4ff';
      document.getElementById('user-avatar').textContent = 'TR';
      document.getElementById('user-avatar').style.background = '#d4af37';
      document.getElementById('user-name').textContent = 'Prof. Teacher';
      buildTeacherUI();
      navTeacher('dashboard', null);
    } else {
      setStudentAccountControlsVisible(true);
      document.documentElement.style.setProperty('--sidebar','#ffffff');
      document.documentElement.style.setProperty('--sidebar-hover','#fff8e1');
      document.documentElement.style.setProperty('--accent','#4169e1');
      document.documentElement.style.setProperty('--accent2','#d4af37');
      document.getElementById('topbar').style.background = '#1e3a8a';
      const sidebar = document.getElementById('sidebar');
      if(sidebar){ sidebar.style.background = '#ffffff'; sidebar.style.color = '#111827'; sidebar.style.boxShadow = 'inset -1px 0 0 rgba(15,23,42,.08)'; }
      document.getElementById('portal-label').textContent = 'Student Portal';
      document.getElementById('portal-label').style.color = '#eef4ff';
      document.getElementById('user-avatar').textContent = 'JD';
      document.getElementById('user-avatar').style.background = '#d4af37';
      document.getElementById('user-name').textContent = 'Juan Dela Cruz';
      buildStudentUI();
      navStudent('dashboard', null);
    }
  };

  initBackend(role).then(()=>{
    data = loadData();
    finishPortalSetup();
  }).catch(()=>{
    finishPortalSetup();
  });
}

function switchPortal(){
  setStudentAccountControlsVisible(false);
  stopLmsSyncPolling();
  if(backendSocket){ backendSocket.disconnect(); backendSocket = null; }
  backendConnected = false;
  data = loadData();
  currentRole = null;
  setPortalBodyClass(null);
  closeAppNav();
  const tabbar = document.getElementById('student-tabbar');
  if(tabbar) tabbar.innerHTML = '';
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
    <div class="section-label" style="color:#374151">Main</div>
    <a href="#" class="active" style="color:#111827" onclick="return navTeacher('dashboard',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Dashboard</a>
    <a href="#" style="color:#111827" onclick="return navTeacher('courses',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>My Courses</a>
    <div class="section-label" style="color:#374151">Assessments</div>
    <a href="#" style="color:#111827" onclick="return navTeacher('exams',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Exams &amp; Quizzes</a>
    <a href="#" style="color:#111827" onclick="return navTeacher('sessions',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18"/><path d="M7 7v14"/><path d="M17 7v14"/><path d="M3 21h18"/></svg>Monitored Exams</a>
    <a href="#" style="color:#111827" onclick="return navTeacher('results',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>Student Results</a>
    <div class="section-label" style="color:#374151">Tools</div>
    <a href="#" style="color:#111827" onclick="return navTeacher('grades',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Grade Book</a>
    <a href="#" style="color:#111827" onclick="return navTeacher('students',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Students</a>
  `;
  // Apply active sidebar style
  document.querySelectorAll('#sidebar a').forEach(a=>{
    a.addEventListener('mouseenter',()=>{ if(!a.classList.contains('active')) a.style.background='rgba(212,175,55,0.14)'; a.style.color='#111827'; });
    a.addEventListener('mouseleave',()=>{ if(!a.classList.contains('active')) a.style.background=''; a.style.color='#111827'; });
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
      <div class="card"><table><thead><tr><th>Exam</th><th>Course</th><th>Published</th><th>Taking Now</th><th>Actions</th></tr></thead><tbody id="session-tbody"></tbody></table></div>
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
  closeAppNav();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('#sidebar a').forEach(a=>{ a.classList.remove('active'); a.style.background=''; });
  document.getElementById('page-'+page).classList.add('active');
  if(el){ el.classList.add('active'); el.style.background='linear-gradient(90deg, #d4af37 0%, #f1de9a 100%)'; el.style.color='#111827'; }
  if(page==='dashboard') renderTeacherDashboard();
  if(page==='courses') renderCoursesWithEnrollmentCodes();
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

function renderCoursesWithEnrollmentCodes(){
  const g = document.getElementById('course-grid');
  if(!g) return;
  if(!data.courses.length){
    g.innerHTML='<div class="empty-state" style="grid-column:1/-1"><div class="icon">Info</div><p>No courses yet. Create one!</p></div>';
    return;
  }
  const colors = ['#dbeafe','#dcfce7','#fef9c3','#fce7f3','#e0e7ff'];
  g.innerHTML = data.courses.map((c,i)=>{
    const enrolledStudents = (data.studentEnrollments || []).filter(e=>e.courseId===c.id);
    const enrollments = enrolledStudents.length;
    const joinCode = getCourseJoinCode(c);
    return `<div class="course-card">
      <div class="cc-banner" style="background:${colors[i%colors.length]}">${escHtml(c.icon||'Course')}</div>
      <div class="cc-body">
        <div class="cc-title">${escHtml(c.name)}</div>
        <div class="cc-sub">${escHtml(c.code||'')}${c.desc?' · '+escHtml(c.desc):''}</div>
        <div class="course-join-code ${joinCode?'':'empty'}">
          <span>Enrollment Code</span>
          <strong>${joinCode ? escHtml(joinCode) : 'Not generated'}</strong>
        </div>
      </div>
      <div class="cc-foot">
        <span style="font-size:.75rem;color:var(--muted)">${data.exams.filter(e=>e.course===c.id).length} assessments · ${enrollments} enrolled</span>
        <div style="display:flex;gap:.4rem;align-items:center">
          <button class="btn btn-ghost btn-sm" type="button" onclick="openCourseStudentsModal('${c.id}')">Students</button>
          <button class="btn btn-ghost btn-sm" onclick="generateCourseCode('${c.id}')">${joinCode?'Regenerate Code':'Generate Code'}</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteCourse('${c.id}')">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function openCourseStudentsModal(courseId){
  const course = data.courses.find(c=>c.id===courseId);
  const students = (data.studentEnrollments || []).filter(e=>e.courseId===courseId);
  const modal = document.getElementById('course-students-modal');
  const body = document.getElementById('course-students-body');
  const title = document.getElementById('course-students-title');
  if(!course || !modal || !body || !title) return;
  title.textContent = `${course.name} — Enrolled Students`;
  body.innerHTML = students.length
    ? students.map(e => `
      <div class="course-student-row-modal">
        <span>${escHtml(e.studentName || 'Unknown student')}</span>
        <button class="btn btn-danger btn-sm" type="button" onclick="removeStudentFromCourse('${courseId}','${e.id}')">Remove</button>
      </div>`).join('')
    : '<div class="empty-state" style="padding:1rem 0"><div class="icon">Info</div><p>No students are enrolled in this course.</p></div>';
  modal.classList.add('show');
}

function closeCourseStudentsModal(){
  const modal = document.getElementById('course-students-modal');
  if(modal) modal.classList.remove('show');
}


function removeStudentFromCourse(courseId, enrollmentId){
  const enrollment = (data.studentEnrollments || []).find(e=>e.id===enrollmentId && e.courseId===courseId);
  if(!enrollment){ toast('Enrollment record not found.'); return; }
  if(!confirm(`Remove ${enrollment.studentName || 'this student'} from this course?`)) return;

  data = loadData();
  data.studentEnrollments = (data.studentEnrollments || []).filter(e=>!(e.id===enrollmentId && e.courseId===courseId));
  saveData();
  renderCoursesWithEnrollmentCodes();
  renderTeacherDashboard();
  toast('Student removed from the course.');
}

function generateCourseCode(courseId){
  data = loadData();
  const course = data.courses.find(c=>c.id===courseId);
  if(!course){ toast('Course not found.'); return; }
  course.joinCode = generateCourseJoinCode();
  saveData();
  renderCoursesWithEnrollmentCodes();
  toast(`Course code generated: ${course.joinCode}`);
}

function openCourseModal(){ document.getElementById('course-modal').classList.add('show'); }
function saveCourse(){
  const name = document.getElementById('c-name').value.trim();
  if(!name){ alert('Course name required'); return; }
  const course = {id:'c'+Date.now(),name,code:document.getElementById('c-code').value.trim(),desc:document.getElementById('c-desc').value.trim(),icon:document.getElementById('c-icon').value};
  data.courses.push(course); saveData();
  document.getElementById('course-modal').classList.remove('show');
  ['c-name','c-code','c-desc'].forEach(id=>document.getElementById(id).value='');
  renderCoursesWithEnrollmentCodes(); toast('Course created!');
}
function deleteCourse(id){
  if(!confirm('Delete this course?')) return;
  data.courses = data.courses.filter(c=>c.id!==id);
  data.exams = data.exams.filter(e=>e.course!==id);
  data.studentEnrollments = (data.studentEnrollments || []).filter(e=>e.courseId!==id);
  saveData(); renderCoursesWithEnrollmentCodes(); toast('Course deleted');
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
  const qc = document.getElementById('questions-container');
  if(qc){ qc.innerHTML=''; qc.style.display='block'; qc.style.visibility='visible'; }
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
  const qc = document.getElementById('questions-container');
  if(qc){ qc.innerHTML=''; qc.style.display='block'; qc.style.visibility='visible'; }
  qCount = 0;
  exam.questions.forEach(q=>addQuestion(q));
  document.getElementById('exam-modal').classList.add('show');
}

function closeExamModal(){ document.getElementById('exam-modal').classList.remove('show'); editingExamId=null; }

function updateQuestionAddButtons(){
  const cards = Array.from(document.querySelectorAll('.q-card'));
  cards.forEach(card => {
    card.querySelector('.add-question-btn')?.remove();
    const actionWrap = card.querySelector('.q-card-actions');
    if(actionWrap) actionWrap.remove();
  });
  const lastCard = cards[cards.length - 1];
  if(lastCard){
    const actionWrap = document.createElement('div');
    actionWrap.className = 'q-card-actions';
    actionWrap.style.display = 'flex';
    actionWrap.style.justifyContent = 'flex-end';
    actionWrap.style.marginTop = '.5rem';
    actionWrap.innerHTML = '<button class="btn btn-primary btn-sm add-question-btn" type="button" onclick="addQuestion()" title="Add next question" aria-label="Add next question">＋</button>';
    lastCard.appendChild(actionWrap);
  }
}

function addQuestion(existing){
  const qc = document.getElementById('questions-container');
  if(!qc){ return; }
  qCount++;
  const qi = qCount;
  const div = document.createElement('div');
  div.className='q-card';
  div.id='q-'+qi;
  div.dataset.questionIndex = String(qi);
  div.innerHTML = `
    <div class="q-hdr"><span class="q-num">Question ${qi}</span><button class="btn btn-ghost btn-sm" type="button" onclick="removeQ(${qi})">Remove</button></div>
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
  updateQuestionAddButtons();
  qc.style.display='block';
  qc.style.visibility='visible';
  requestAnimationFrame(() => {
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
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

function removeQ(qi){
  const el=document.getElementById('q-'+qi);
  if(!el) return;
  el.remove();
  renumberQuestionCards();
  updateQuestionAddButtons();
}

function renumberQuestionCards(){
  const cards = Array.from(document.querySelectorAll('.q-card'));
  cards.forEach((card, index) => {
    const newQi = index + 1;
    card.id = 'q-' + newQi;
    card.dataset.questionIndex = String(newQi);
    const num = card.querySelector('.q-num');
    if(num) num.textContent = 'Question ' + newQi;
    const removeBtn = card.querySelector('button');
    if(removeBtn) removeBtn.setAttribute('onclick', 'removeQ(' + newQi + ')');
    const qt = card.querySelector('input[id^="qt-"]');
    if(qt) qt.id = 'qt-' + newQi;
    const qtype = card.querySelector('select[id^="qtype-"]');
    if(qtype){
      qtype.id = 'qtype-' + newQi;
      qtype.setAttribute('onchange', 'renderChoices(' + newQi + ')');
    }
    const points = card.querySelector('input[id^="qpts-"]');
    if(points) points.id = 'qpts-' + newQi;
    const choices = card.querySelector('[id^="choices-"]');
    if(choices) choices.id = 'choices-' + newQi;
    card.querySelectorAll('input[name^="correct-"]').forEach(input => {
      input.name = 'correct-' + newQi;
    });
  });
  qCount = cards.length;
  updateQuestionAddButtons();
}

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
        <button class="btn btn-ghost btn-sm" onclick="downloadBackendPdf('${s.id}')">PDF</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick="openStudentAnswersSpreadsheet('${s.id}')">View Answers</button></td>
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
function renderStudentAccountSwitcher(){
  const container = document.getElementById('student-account-switcher-strip');
  if(!container) return;

  const current = getCurrentStudent();
  container.innerHTML = STUDENT_ACCOUNTS.map(student => `
    <button
      type="button"
      class="student-account-chip${student.id === current.id ? ' active' : ''}"
      onclick="switchStudentAccount('${student.id}'); closeStudentAccountMenu();"
      title="Switch to ${student.name}"
    >${student.name}</button>
  `).join('');
}

function toggleStudentAccountMenu(){
  const menu = document.getElementById('student-account-switcher-strip');
  const trigger = document.getElementById('student-account-trigger');
  if(!menu || !trigger) return;

  const shouldOpen = menu.style.display === 'none' || menu.style.display === '';
  menu.style.display = shouldOpen ? 'flex' : 'none';
  trigger.setAttribute('aria-expanded', String(shouldOpen));
}

function closeStudentAccountMenu(){
  const menu = document.getElementById('student-account-switcher-strip');
  const trigger = document.getElementById('student-account-trigger');
  if(menu) menu.style.display = 'none';
  if(trigger) trigger.setAttribute('aria-expanded', 'false');
}

window.addEventListener('click', (event) => {
  const trigger = document.getElementById('student-account-trigger');
  const menu = document.getElementById('student-account-switcher-strip');
  if(!trigger || !menu) return;

  const clickedInside = trigger.contains(event.target) || menu.contains(event.target);
  if(!clickedInside) closeStudentAccountMenu();
});

function buildStudentUI(){
  document.getElementById('sidebar').innerHTML = `
    <div class="section-label" style="color:#374151">Main</div>
    <a href="#" class="active" style="color:#111827" onclick="return navStudent('dashboard',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Dashboard</a>
    <a href="#" style="color:#111827" onclick="return navStudent('courses',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>My Courses</a>
    <div class="section-label" style="color:#374151">Assessments</div>
    <!-- Enter Session removed: exams auto-join when opened -->
    <a href="#" style="color:#111827" onclick="return navStudent('exams',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Available Exams</a>
    <a href="#" style="color:#111827" onclick="return navStudent('results',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>My Results</a>
    <div class="section-label" style="color:#374151">More</div>
    <a href="#" style="color:#111827" onclick="return navStudent('profile',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>My Profile</a>
  `;

  document.querySelectorAll('#sidebar a').forEach(a=>{
    a.addEventListener('mouseenter',()=>{ if(!a.classList.contains('active')) { a.style.background='linear-gradient(90deg, rgba(212,175,55,.18) 0%, rgba(212,175,55,.08) 100%)'; a.style.color='#111827'; } });
    a.addEventListener('mouseleave',()=>{ if(!a.classList.contains('active')) { a.style.background=''; a.style.color='#111827'; } });
  });

  const tabbar = document.getElementById('student-tabbar');
  if(tabbar){
    tabbar.innerHTML = `
      <a href="#" class="active" data-page="dashboard" onclick="return navStudent('dashboard',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        <span>Home</span>
      </a>
      <a href="#" data-page="courses" onclick="return navStudent('courses',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        <span>Courses</span>
      </a>
      <a href="#" data-page="exams" onclick="return navStudent('exams',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>Exams</span>
      </a>
      <a href="#" data-page="results" onclick="return navStudent('results',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        <span>Results</span>
      </a>
      <a href="#" data-page="profile" onclick="return navStudent('profile',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>Profile</span>
      </a>
    `;
  }

  const student = getCurrentStudent();

  document.getElementById('main-content').innerHTML = `
    <!-- STUDENT DASHBOARD -->
    <div class="page active" id="page-dashboard">
      <div class="page-hdr student-welcome"><div><p class="welcome-kicker">Student dashboard</p><h1>Welcome back, ${student.name.split(' ')[0]}</h1><p>Your academic overview, all in one place.</p></div></div>
      <div class="stat-grid student-stat-grid">
        <div class="stat-card"><div class="stat-card-top"><span class="icon">Courses</span><span class="stat-symbol">◫</span></div><div class="num" id="sd-courses">0</div><div class="lbl">Enrolled courses</div></div>
        <div class="stat-card"><div class="stat-card-top"><span class="icon">Exams</span><span class="stat-symbol">✓</span></div><div class="num" id="sd-available">0</div><div class="lbl">Available assessments</div></div>
        <div class="stat-card"><div class="stat-card-top"><span class="icon">Done</span><span class="stat-symbol">↗</span></div><div class="num" id="sd-done">0</div><div class="lbl">Completed</div></div>
        <div class="stat-card"><div class="stat-card-top"><span class="icon">Score</span><span class="stat-symbol">★</span></div><div class="num" id="sd-avg">—</div><div class="lbl">Average score</div></div>
      </div>
      <div class="two-col-grid">
        <div class="card dashboard-section"><div class="card-title">Pending assessments</div><div id="dash-pending"></div></div>
        <div class="card dashboard-section"><div class="card-title">Recent scores</div><div id="dash-scores"></div></div>
      </div>
    </div>

    <!-- Session join removed: exams auto-join when opened -->

    <!-- COURSES -->
    <div class="page" id="page-courses">
      <div class="page-hdr"><div><h1>My Courses</h1><p>Your enrolled courses this semester</p></div><button class="btn btn-primary" onclick="openStudentCourseEnroll()">Add Course</button></div>
      <div class="card enroll-card" id="student-enroll-card" style="display:none">
        <div class="form-group" style="margin-bottom:0">
          <label>Course Enrollment Code</label>
          <div class="enroll-row">
            <input type="text" id="student-course-code" placeholder="e.g. IJKL-WASD" maxlength="9" onkeydown="if(event.key==='Enter') enrollInCourseByCode()"/>
            <button class="btn btn-primary" onclick="enrollInCourseByCode()">Enroll</button>
            <button class="btn btn-ghost" onclick="closeStudentCourseEnroll()">Cancel</button>
          </div>
        </div>
      </div>
      <div class="course-grid" id="s-course-grid"></div>
    </div>

    <!-- AVAILABLE EXAMS -->
    <div class="page" id="page-exams">
      <div class="page-hdr"><div><h1>Available Assessments</h1><p>Exams and quizzes published by your teachers</p></div></div>
      <div class="list-stack" id="avail-list"></div>
    </div>

    <!-- RESULTS -->
    <div class="page" id="page-results">
      <div class="page-hdr"><div><h1>My Results</h1><p>Your submission history and scores</p></div></div>
      <div class="list-stack" id="s-results-list"></div>
    </div>

    <!-- PROFILE -->
    <div class="page" id="page-profile">
      <div class="page-hdr"><div><h1>My Profile</h1></div></div>
      <div class="card" style="max-width:480px">
        <div class="profile-hero">
          <div class="profile-avatar">${student.initials}</div>
          <div>
            <div class="profile-name">${student.name}</div>
            <div class="profile-program">Student · ${student.program}</div>
          </div>
        </div>
        <div class="profile-rows">
          <div class="profile-row"><span>Student ID</span><strong>${student.studentId}</strong></div>
          <div class="profile-row"><span>Email</span><strong>${student.email}</strong></div>
          <div class="profile-row"><span>Program</span><strong>${student.program}</strong></div>
          <div class="profile-row"><span>Year Level</span><strong>${student.year}</strong></div>
        </div>
      </div>
    </div>
  `;

  renderStudentAccountSwitcher();
}

function navStudent(page, el){
  data = loadData();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('#sidebar a').forEach(a=>{ a.classList.remove('active'); a.style.background=''; });
  document.querySelectorAll('#student-tabbar a').forEach(a=>a.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  const sidebarLink = document.querySelector(`#sidebar a[onclick*="'${page}'"]`);
  if(sidebarLink){ sidebarLink.classList.add('active'); sidebarLink.style.background='linear-gradient(90deg, #d4af37 0%, #f1de9a 100%)'; sidebarLink.style.color='#111827'; }
  const tabLink = document.querySelector(`#student-tabbar a[data-page="${page}"]`);
  if(tabLink) tabLink.classList.add('active');
  if(el && el.closest('#sidebar')){ el.classList.add('active'); el.style.background='linear-gradient(90deg, #d4af37 0%, #f1de9a 100%)'; el.style.color='#111827'; }
  window.scrollTo(0,0);
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
  const enrolledIds = getEnrolledCourseIds();
  return data.exams.filter(e=>e.status==='published' && enrolledIds.includes(e.course));
}
function getMySubmissions(){ return data.submissions.filter(s=>s.studentName===STUDENT_NAME); }
function hasSubmitted(examId){ return getMySubmissions().some(s=>s.examId===examId); }

function openStudentCourseEnroll(){
  const card = document.getElementById('student-enroll-card');
  if(card) card.style.display = 'block';
  setTimeout(()=>document.getElementById('student-course-code')?.focus(), 0);
}

function closeStudentCourseEnroll(){
  const card = document.getElementById('student-enroll-card');
  const input = document.getElementById('student-course-code');
  if(input) input.value = '';
  if(card) card.style.display = 'none';
}

function enrollInCourseByCode(){
  const input = document.getElementById('student-course-code');
  const code = normalizeCode(input?.value || '');
  if(!code){ toast('Enter a course enrollment code.'); return; }
  syncLmsFromBackend().then(()=>{
    data = loadData();
    data.studentEnrollments = data.studentEnrollments || [];
    const course = data.courses.find(c=>normalizeCode(getCourseJoinCode(c))===code);
    if(!course){ toast('No course found for that code.'); return; }
    const already = data.studentEnrollments.some(e=>e.studentName===STUDENT_NAME && e.courseId===course.id);
    if(already){ toast('You are already enrolled in this course.'); return; }
    data.studentEnrollments.push({ id:'enr'+Date.now(), studentName:STUDENT_NAME, courseId:course.id, enrolledAt:new Date().toISOString() });
    saveData();
    closeStudentCourseEnroll();
    renderStudentCourses();
    renderStudentDashboard();
    toast(`Enrolled in ${course.name}.`);
  });
}

function renderStudentDashboard(){
  const myExams = getMyExams(), mySubs = getMySubmissions();
  const myCourses = data.courses.filter(c=>getEnrolledCourseIds().includes(c.id));
  const pending = myExams.filter(e=>!hasSubmitted(e.id));
  document.getElementById('sd-courses').textContent = myCourses.length;
  document.getElementById('sd-available').textContent = myExams.length;
  document.getElementById('sd-done').textContent = mySubs.length;
  if(mySubs.length){
    const avg = Math.round(mySubs.reduce((a,s)=>a+s.pct,0)/mySubs.length);
    document.getElementById('sd-avg').textContent = avg+'%';
  }
  const pendingCard = document.getElementById('dash-pending');
  if(!myCourses.length){
    pendingCard.innerHTML = '<div class="empty-state empty-state-compact"><p>Enroll in a course first to see available assessments.</p><button class="btn btn-primary btn-sm" type="button" onclick="return navStudent(\'courses\')">Add a course</button></div>';
  } else if(!myExams.length){
    pendingCard.innerHTML = '<div class="empty-state empty-state-compact"><p>No assessments are available yet. Check back after your teacher publishes one.</p></div>';
  } else if(!pending.length){
    pendingCard.innerHTML = '<div class="empty-state empty-state-compact"><p>You\'re all caught up. No pending exams right now.</p></div>';
  } else {
    pendingCard.innerHTML = pending.slice(0,4).map(e=>{
      const course = data.courses.find(c=>c.id===e.course);
      return `<div class="action-row">
        <div>
          <div class="action-row-title">${escHtml(e.title)}</div>
          <div class="action-row-sub">${escHtml(course?course.name:'')} · ${e.questions.length} questions</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openExamIntro('${e.id}')">Take exam</button>
      </div>`;
    }).join('');
  }
  const ds = document.getElementById('dash-scores');
  if(!mySubs.length){ ds.innerHTML='<div class="empty-state empty-state-compact"><p>No scores yet. Complete an exam to see results here.</p></div>'; }
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
  const myCourses = data.courses.filter(c=>getEnrolledCourseIds().includes(c.id));
  const colors = ['#dbeafe','#dcfce7','#fef9c3'];
  if(!myCourses.length){
    g.innerHTML = '<div class="empty-state empty-state-compact" style="grid-column:1/-1"><p>No enrolled courses yet. Ask your teacher for the enrollment code, then tap Add Course.</p></div>';
    return;
  }
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
  renderTeacherSessionsTable();
  if(!teacherSessionsInterval){
    teacherSessionsInterval = setInterval(()=>{
      if(document.getElementById('page-sessions')?.classList.contains('active')){
        refreshBackendTeacherSessionCounts();
      } else {
        clearInterval(teacherSessionsInterval);
        teacherSessionsInterval = null;
      }
    }, 3000);
  }
  refreshBackendTeacherSessionCounts();
}

async function refreshBackendTeacherSessionCounts(){
  if(!backendConnected || teacherSessionsRefreshInFlight) return;
  teacherSessionsRefreshInFlight = true;
  try{
    const response = await fetch(`${BACKEND_URL}/api/sessions/active`);
    if(!response.ok) throw new Error(`Active sessions request failed (${response.status})`);
    const result = await response.json();
    const sessionsByExam = new Map();
    (result.sessions || []).forEach(session=>{
      if(!session.exam_id || !session.student_name) return;
      if(!sessionsByExam.has(session.exam_id)) sessionsByExam.set(session.exam_id, new Set());
      sessionsByExam.get(session.exam_id).add(session.student_name);
    });
    const publishedExamIds = new Set(data.exams.filter(exam=>exam.status==='published').map(exam=>exam.id));
    teacherSessionCounts = new Map(
      Array.from(publishedExamIds, examId=>[examId, sessionsByExam.get(examId)?.size || 0])
    );
    if(document.getElementById('page-sessions')?.classList.contains('active')){
      data = loadData();
      renderTeacherSessionsTable();
    }
  }catch(error){
    console.warn('[ProctorVision] Could not refresh monitored exam student counts', error);
  }finally{
    teacherSessionsRefreshInFlight = false;
  }
}

function renderTeacherSessionsTable(){
  const tb = document.getElementById('session-tbody');
  if(!tb) return;
  const exams = data.exams.filter(e=>e.status==='published');
  const joins = data.studentJoins || [];
  if(!exams.length){ tb.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="icon">Info</div><p>No published exams to monitor yet.</p></div></td></tr>'; return; }
  tb.innerHTML = exams.map(e=>{
    const course = data.courses.find(c=>c.id===e.course);
    const localJoinedCount = new Set(joins.filter(j=>j.examId===e.id && j.status==='joined').map(j=>j.studentName)).size;
    const joinedCount = backendConnected && teacherSessionCounts.has(e.id)
      ? teacherSessionCounts.get(e.id)
      : localJoinedCount;
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
  const list = document.getElementById('avail-list');
  if(!list) return;
  const myExams = getMyExams();
  if(!getEnrolledCourseIds().length){
    list.innerHTML = '<div class="card empty-state empty-state-compact"><p>Enroll in a course first to view published assessments.</p><button class="btn btn-primary btn-sm" type="button" onclick="return navStudent(\'courses\')">Add a course</button></div>';
    return;
  }
  if(!myExams.length){
    list.innerHTML = '<div class="card empty-state empty-state-compact"><p>No assessments are currently published for your enrolled courses.</p></div>';
    return;
  }
  list.innerHTML = myExams.map(e=>{
    const course = data.courses.find(c=>c.id===e.course);
    const done = hasSubmitted(e.id);
    return `<article class="item-card">
      <div class="item-card-head">
        <strong>${escHtml(e.title)}</strong>
        ${done?'<span class="pill pill-green">Done</span>':'<span class="pill pill-yellow">Pending</span>'}
      </div>
      <div class="item-card-meta">
        <span>${escHtml(course?course.name:'—')}</span>
        <span>${escHtml(e.type)}</span>
        <span>${e.questions.length} questions</span>
        <span>${e.timeLimit?e.timeLimit+' min':'No time limit'}</span>
      </div>
      ${done
        ? '<button class="btn btn-ghost btn-sm" disabled style="opacity:.55">Submitted</button>'
        : `<button class="btn btn-primary" onclick="openExamIntro('${e.id}')">Take exam</button>`}
    </article>`;
  }).join('');
}

function formatAnswerValue(answer, question){
  if(question?.qtype==='mcq'){
    const index = typeof answer === 'number' ? answer : Number(answer);
    if(Number.isInteger(index) && Array.isArray(question.choices) && question.choices[index] !== undefined){
      return `${String.fromCharCode(65 + index)}. ${question.choices[index]}`;
    }
    return answer ?? '';
  }
  if(question?.qtype==='tf'){
    return String(answer).toLowerCase() === 'true' || answer === true ? 'True' : 'False';
  }
  return answer ?? '';
}

function openStudentAnswersSpreadsheet(submissionId){
  const submission = data.submissions.find(s=>s.id===submissionId);
  const exam = submission ? data.exams.find(e=>e.id===submission.examId) : null;
  if(!submission || !exam){ toast('Submission details are not available.'); return; }

  const savedReview = Array.isArray(submission.review) && submission.review.length
    ? submission.review
    : null;

  const rowsHtml = (savedReview || (Array.isArray(submission.randomizedQuestions) ? submission.randomizedQuestions : exam.questions || [])).map((item, index) => {
    const qText = item.q || item.text || `Question ${index + 1}`;
    const qType = item.qtype || item.type || 'short';
    const pts = item.pts || item.points || 1;
    const fallbackChoices = Array.isArray(exam.questions?.[index]?.choices) ? exam.questions[index].choices : [];
    const choices = Array.isArray(item.choices) && item.choices.length ? item.choices : fallbackChoices;

    function formatAnswerLabel(answer, type, optionList){
      const normalized = typeof answer === 'string' ? answer.trim() : answer;
      if(type === 'mcq'){
        const numericIndex = typeof normalized === 'number' ? normalized : Number(normalized);
        if(Number.isInteger(numericIndex) && Array.isArray(optionList) && optionList[numericIndex] !== undefined){
          return `${String.fromCharCode(65 + numericIndex)}. ${optionList[numericIndex]}`;
        }
        if(typeof normalized === 'string' && /^[A-Z]$/i.test(normalized)){
          const letterIndex = normalized.toUpperCase().charCodeAt(0) - 65;
          if(Array.isArray(optionList) && optionList[letterIndex] !== undefined){
            return `${String.fromCharCode(65 + letterIndex)}. ${optionList[letterIndex]}`;
          }
        }
        return String(normalized ?? '');
      }
      if(type === 'tf'){
        if(Array.isArray(optionList) && optionList.length){
          const matchingIndex = optionList.findIndex(choice => String(choice).toLowerCase() === String(normalized).toLowerCase());
          if(matchingIndex >= 0){
            return `${String.fromCharCode(65 + matchingIndex)}. ${optionList[matchingIndex]}`;
          }
        }
        if(String(normalized).toLowerCase() === 'true' || normalized === true){
          return 'True';
        }
        if(String(normalized).toLowerCase() === 'false' || normalized === false){
          return 'False';
        }
        return String(normalized ?? '');
      }
      return String(normalized ?? '');
    }

    const studentAnswer = savedReview ? item.userAns : submission.answers?.[index];
    const correctAnswer = savedReview ? item.correctAns : item.correct;

    let studentAnswerText = formatAnswerLabel(studentAnswer, qType, choices);
    let correctAnswerText = formatAnswerLabel(correctAnswer, qType, choices);

    if(qType === 'short' || qType === 'essay'){
      studentAnswerText = String(savedReview ? (item.userAns ?? '') : (submission.answers?.[index] ?? ''));
      correctAnswerText = String(savedReview ? (item.correctAns ?? '') : (item.correct ?? ''));
    }

    return `<tr>
      <td>${escHtml(qText)}</td>
      <td>${escHtml(qType)}</td>
      <td>${escHtml(studentAnswerText)}</td>
      <td>${escHtml(correctAnswerText)}</td>
      <td>${pts}</td>
    </tr>`;
  }).join('');

  const modal = document.getElementById('answer-review-modal');
  const title = document.getElementById('answer-review-title');
  const body = document.getElementById('answer-review-body');

  if(modal && title && body){
    title.textContent = `${exam.title} — ${submission.studentName}`;
    body.innerHTML = `<table class="mini-table"><thead><tr><th>Question</th><th>Type</th><th>Student Answer</th><th>Correct Answer</th><th>Points</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
    modal.classList.add('show');
  }

  toast('Answer review opened.');
}

function closeAnswerReviewModal(){
  document.getElementById('answer-review-modal')?.classList.remove('show');
}

function renderStudentResults(){
  const list = document.getElementById('s-results-list');
  if(!list) return;
  const mySubs = getMySubmissions();
  if(!mySubs.length){
    list.innerHTML='<div class="card empty-state empty-state-compact"><p>No submissions yet. Take an exam to see your scores here.</p></div>';
    return;
  }
  list.innerHTML = mySubs.slice().reverse().map(s=>{
    const exam = data.exams.find(e=>e.id===s.examId);
    const course = exam?data.courses.find(c=>c.id===exam.course):null;
    return `<article class="item-card">
      <div class="item-card-head">
        <strong>${escHtml(exam?exam.title:'Exam')}</strong>
        <span class="pill ${s.pct>=75?'pill-green':'pill-red'}">${s.pct>=75?'Passed':'Failed'}</span>
      </div>
      <div class="item-card-meta">
        <span>${escHtml(course?course.name:'—')}</span>
        <span>${s.score}/${s.total} (${s.pct}%)</span>
        <span>${new Date(s.submittedAt).toLocaleDateString()}</span>
      </div>
      <div class="score-bar"><div class="score-fill" style="width:${s.pct}%;background:${s.pct>=75?'var(--accent2)':'var(--warn)'}"></div></div>
    </article>`;
  }).join('');
}

// ════════════════════════════════════════
// ADMIN UI
// ════════════════════════════════════════
function buildAdminUI(){
  document.getElementById('sidebar').innerHTML = `
    <div class="section-label" style="color:#374151">System</div>
    <a href="#" class="active" style="color:#111827" onclick="return navAdmin('dashboard',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Dashboard</a>
    <a href="#" style="color:#111827" onclick="return navAdmin('users',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>User Management</a>
    <a href="#" style="color:#111827" onclick="return navAdmin('courses',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>Courses</a>
    <a href="#" style="color:#111827" onclick="return navAdmin('exams',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>All Assessments</a>
    <div class="section-label" style="color:#374151">Monitoring</div>
    <a href="#" style="color:#111827" onclick="return navAdmin('sessions',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18"/><path d="M7 7v14"/><path d="M17 7v14"/><path d="M3 21h18"/></svg>Active Sessions</a>
    <a href="#" style="color:#111827" onclick="return navAdmin('submissions',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>Submissions</a>
    <a href="#" style="color:#111827" onclick="return navAdmin('events',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>Audit Log</a>
    <div class="section-label" style="color:#374151">Settings</div>
    <a href="#" style="color:#111827" onclick="return navAdmin('settings',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m5.08 0l4.24-4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m5.08 0l4.24 4.24"/></svg>System Settings</a>
    <a href="#" style="color:#111827" onclick="return navAdmin('reports',this)">
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
      <div class="card">
        <div class="card-title">Quick Actions</div>
        <div style="display:flex;flex-direction:column;gap:.5rem;margin-top:.5rem">
          <button class="btn btn-primary" onclick="navAdmin('users',null);return false" style="justify-content:center">Create New User</button>
          <button class="btn btn-primary" onclick="navAdmin('courses',null);return false" style="justify-content:center">Manage Courses</button>
          <button class="btn btn-primary" onclick="navAdmin('exams',null);return false" style="justify-content:center">View All Assessments</button>
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
        <div class="card-title">System Status</div>
        <div style="font-size:.85rem;color:var(--muted);margin-top:.5rem">
          <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Backend Status</span><span id="a-backend-status" class="pill pill-green" style="font-size:.72rem">Online</span></div>
          <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Database</span><span class="pill pill-green" style="font-size:.72rem">Connected</span></div>
          <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)"><span>Proctoring Engine</span><span id="a-proctor-status" class="pill pill-green" style="font-size:.72rem">Active</span></div>
          <div style="display:flex;justify-content:space-between;padding:.4rem 0"><span>API Endpoints</span><span class="pill pill-green" style="font-size:.72rem">Operational</span></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Proctoring Configuration</div>
        <div style="display:grid;gap:1rem;margin-top:.75rem">
          <div class="form-group">
            <label><input type="checkbox" id="a-setting-focus" checked style="margin-right:.5rem"/>Focus and tab-switch detection</label>
          </div>
          <div class="form-group">
            <label><input type="checkbox" id="a-setting-clipboard" checked style="margin-right:.5rem"/>Copy, cut, and paste blocking</label>
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
    a.addEventListener('mouseenter',()=>{ if(!a.classList.contains('active')) { a.style.background='linear-gradient(90deg, rgba(212,175,55,.18) 0%, rgba(212,175,55,.08) 100%)'; a.style.color='#111827'; } });
    a.addEventListener('mouseleave',()=>{ if(!a.classList.contains('active')) { a.style.background=''; a.style.color='#111827'; } });
  });
}

function navAdmin(page, el){
  data = loadData();
  closeAppNav();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('#sidebar a').forEach(a=>{ a.classList.remove('active'); a.style.background=''; });
  document.getElementById('page-'+page).classList.add('active');
  if(el){ el.classList.add('active'); el.style.background='linear-gradient(90deg, #d4af37 0%, #f1de9a 100%)'; el.style.color='#111827'; }
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
  data.studentEnrollments = (data.studentEnrollments || []).filter(e=>e.courseId!==courseId);
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
    focusDetection: document.getElementById('a-setting-focus').checked,
    clipboardBlocking: document.getElementById('a-setting-clipboard').checked,
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
  activeExam = {
    ...exam,
    questions: randomizeExamQuestions(exam),
  };
  answers = {};
  currentQ = 0;
  backendJoinSession(exam);
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
  activeExam = {
    ...exam,
    questions: randomizeExamQuestions(exam),
  };
  answers = {};
  currentQ = 0;
  const course = data.courses.find(c=>c.id===exam.course);
  document.getElementById('es-title').textContent = exam.title;
  document.getElementById('intro-title').textContent = exam.title;
  document.getElementById('intro-instructions').textContent = exam.instructions||'Answer all questions to the best of your ability.';
  document.getElementById('intro-qcount').textContent = exam.questions.length;
  document.getElementById('intro-time').textContent = activeExam.timeLimit?activeExam.timeLimit+' minutes':'No time limit';
  document.getElementById('intro-course').textContent = course?course.name:'Unknown';
  document.getElementById('intro-screen').style.display='block';
  document.getElementById('questions-screen').style.display='none';
  document.getElementById('result-screen-wrap').style.display='none';
  document.getElementById('exam-shell').classList.add('show');
}

async function beginExam(){
  if(!activeExam){ toast('Exam is still loading. Please try again.'); return; }
  document.getElementById('intro-screen').style.display='none';
  document.getElementById('questions-screen').style.display='flex';
  document.getElementById('qs-exam-title').textContent=activeExam.title;
  document.getElementById('exam-shell').classList.add('proctoring-active');
  if(timerInterval) clearInterval(timerInterval);
  startProctoring();
  if(isIOSDevice()){
    toast('iOS does not notify websites about screenshots. Screenshots cannot be detected or blocked in this browser.', 7000);
  }
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
  const qs = (activeExam?.questions || []).map((q, i) => normalizeQuestion(q, i));
  if(!qs.length){
    const area = document.getElementById('question-area');
    if(area) area.innerHTML = '<div class="empty-state"><div class="icon">Info</div><p>No questions available for this exam.</p></div>';
    return;
  }
  currentQ = Math.min(idx, qs.length - 1);
  document.getElementById('q-progress').textContent=(currentQ+1)+'/'+qs.length;
  const answered = Object.keys(answers).filter(k=>answers[k]!==undefined&&answers[k]!=='').length;
  document.getElementById('q-prog-label').textContent=answered+' answered';
  document.getElementById('q-prog-fill').style.width=Math.round((answered/Math.max(qs.length,1))*100)+'%';
  const showAllQuestions = false;

  const prevInline = document.getElementById('btn-prev-inline');
  const nextInline = document.getElementById('btn-next-inline');
  const isLastQuestion = currentQ >= qs.length - 1;
  if(prevInline) prevInline.style.display = currentQ === 0 ? 'none' : '';
  if(nextInline){
    nextInline.style.display = '';
    nextInline.textContent = isLastQuestion ? 'Submit Exam' : 'Next';
    nextInline.onclick = isLastQuestion ? () => submitExam() : () => nextQ();
  }
  const submitBtn = document.getElementById('btn-submit');
  if(submitBtn) submitBtn.style.display = 'none';
  let html = '';

  if(showAllQuestions){
    html = qs.map((q,i)=>{
      let card = `<div class="q-block" style="display:block"><span class="q-num-badge">Q${i+1} of ${qs.length}</span><div class="q-text">${escHtml(q.text)}</div>`;
      if(q.qtype==='mcq'){
        card += (q.choices||[]).map((c,j)=>`
          <div class="choice-opt ${answers[i]===j?'selected':''}" onclick="selectAnswer(${i},${j})">
            <input type="radio" name="q${i}" value="${j}" ${answers[i]===j?'checked':''} onchange="selectAnswer(${i},${j})"/>
            <span>${String.fromCharCode(65+j)}. ${escHtml(c)}</span>
          </div>`).join('');
      }else if(q.qtype==='tf'){
        card += ['True','False'].map((c,j)=>`
          <div class="choice-opt ${answers[i]===c.toLowerCase()?'selected':''}" onclick="selectAnswer(${i},'${c.toLowerCase()}')">
            <input type="radio" name="q${i}" value="${c.toLowerCase()}" ${answers[i]===c.toLowerCase()?'checked':''}/>
            <span>${c}</span>
          </div>`).join('');
      }else{
        card += `<textarea class="short-answer" placeholder="Type your answer here..." onchange="selectAnswer(${i},this.value)" oninput="selectAnswer(${i},this.value)">${answers[i]||''}</textarea>`;
      }
      return card + '</div>';
    }).join('');
  }else{
    const q = qs[currentQ];
    html = `<div class="q-block"><span class="q-num-badge">Q${currentQ+1} of ${qs.length}</span><div class="q-text">${escHtml(q.text)}</div>`;
    if(q.qtype==='mcq'){
      html += (q.choices||[]).map((c,j)=>`
        <div class="choice-opt ${answers[currentQ]===j?'selected':''}" onclick="selectAnswer(${currentQ},${j})">
          <input type="radio" name="q${currentQ}" value="${j}" ${answers[currentQ]===j?'checked':''} onchange="selectAnswer(${currentQ},${j})"/>
          <span>${String.fromCharCode(65+j)}. ${escHtml(c)}</span>
        </div>`).join('');
    }else if(q.qtype==='tf'){
      const tfChoices = Array.isArray(q.choices) && q.choices.length ? q.choices : ['true','false'];
      html += tfChoices.map((choiceValue, j)=>{
        const label = choiceValue === 'true' ? 'True' : choiceValue === 'false' ? 'False' : choiceValue;
        const value = String(choiceValue).toLowerCase();
        return `<div class="choice-opt ${answers[currentQ]===value?'selected':''}" onclick="selectAnswer(${currentQ},'${value}')">
          <input type="radio" name="q${currentQ}" value="${value}" ${answers[currentQ]===value?'checked':''} onchange="selectAnswer(${currentQ},'${value}')"/>
          <span>${label}</span>
        </div>`;
      }).join('');
    }else{
      html += `<textarea class="short-answer" placeholder="Type your answer here..." onchange="selectAnswer(${currentQ},this.value)" oninput="selectAnswer(${currentQ},this.value)">${answers[currentQ]||''}</textarea>`;
    }
    html += '</div>';
  }

  const area = document.getElementById('question-area');
  if(area){
    area.style.display = 'block';
    area.innerHTML = html;
  }
}

function selectAnswer(qi,val){
  if(examInputsDisabled){ toast('Exam is paused. You cannot change answers right now.'); return; }
  answers[qi]=val; renderQuestion(qi);
}
function prevQ(){ if(currentQ>0) renderQuestion(currentQ-1); }
function nextQ(){ if(currentQ<activeExam.questions.length-1) renderQuestion(currentQ+1); }

function submitExam(auto){
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
  const answerSnapshot = activeExam.questions.map((q, index) => answers[index]);
  const randomizedQuestions = activeExam.questions.map(q => ({
    text: q.text,
    qtype: q.qtype,
    points: q.points || 1,
    choices: Array.isArray(q.choices) ? [...q.choices] : [],
    correct: q.correct,
    originalIndex: q.originalIndex
  }));
  data.submissions.push({
    id:submissionId,
    examId:activeExam.id,
    studentName:STUDENT_NAME,
    score,
    total,
    pct,
    submittedAt:new Date().toISOString(),
    proctorData,
    backendSessionId,
    review,
    answers: answerSnapshot,
    randomizedQuestions
  });
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
  setExamPrivacyShield(false);
  window.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('blur', handleBlur);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('copy', handleCopy);
  window.addEventListener('cut', handleCut);
  window.addEventListener('paste', handlePaste);
  window.addEventListener('contextmenu', handleContextMenu);
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('beforeunload', handleBeforeUnload);
  installProctorCaptureHandlers();
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
  removeProctorCaptureHandlers();
  document.getElementById('exam-shell')?.classList.remove('proctoring-active');
  setExamPrivacyShield(false);
  updateProctoringBadge(false);
}

function installProctorCaptureHandlers(){
  document.addEventListener('copy', handleCopy, true);
  document.addEventListener('cut', handleCut, true);
  document.addEventListener('paste', handlePaste, true);
  document.addEventListener('beforeinput', handleBeforeInput, true);
  document.addEventListener('selectstart', handleSelectStart, true);
  document.addEventListener('dragstart', handleDragStart, true);
  document.addEventListener('contextmenu', handleContextMenu, true);
  document.addEventListener('keydown', handleKeydown, true);
}

function removeProctorCaptureHandlers(){
  document.removeEventListener('copy', handleCopy, true);
  document.removeEventListener('cut', handleCut, true);
  document.removeEventListener('paste', handlePaste, true);
  document.removeEventListener('beforeinput', handleBeforeInput, true);
  document.removeEventListener('selectstart', handleSelectStart, true);
  document.removeEventListener('dragstart', handleDragStart, true);
  document.removeEventListener('contextmenu', handleContextMenu, true);
  document.removeEventListener('keydown', handleKeydown, true);
}

function handleBeforeInput(e){
  if(!proctorSession) return;
  if(e.inputType === 'insertFromPaste'){
    e.preventDefault();
    e.stopImmediatePropagation();
    recordProctorEvent('paste_attempt','Paste action blocked during exam',14);
  }
}

function handleSelectStart(e){
  if(!proctorSession) return;
  if(document.activeElement?.tagName === 'TEXTAREA') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  recordProctorEvent('selection_attempt','Text selection blocked during exam',10);
}

function handleDragStart(e){
  if(!proctorSession) return;
  if(document.activeElement?.tagName === 'TEXTAREA') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  recordProctorEvent('drag_attempt','Drag selection blocked during exam',10);
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
  const added = addProctorWeight(weight || 8, type);
  if(added <= 0) return;

  const event = {time: now.toLocaleTimeString(), type, details, weight};
  proctorSession.events.push(event);
  if(!proctorSession.alerted && proctorSession.score >= 40){
    toast('ProctorVision flagged suspicious activity for teacher review.');
    proctorSession.alerted = true;
  }
  // Buffer live events to reduce localStorage writes; flush periodically
  try{
    if(activeExam && activeExam.id){
      liveEventBuffer.push({ examId: activeExam.id, studentName: STUDENT_NAME, time: now.toISOString(), type, details, weight, added });
      // flush immediately so the live monitor updates without waiting for the old 2-second batch window
      if(liveEventFlushTimer) clearTimeout(liveEventFlushTimer);
      flushLiveEvents();
      liveEventFlushTimer = setTimeout(flushLiveEvents, LIVE_EVENT_FLUSH_MS);
      backendPostEvent({ type, details, weight, time: now.toISOString() });
    }
  }catch(e){ /* ignore transient errors */ }
}

function addProctorWeight(weight, type){
  if(!proctorSession) return 0;
  proctorSession.lastEventAtByType = proctorSession.lastEventAtByType || {};
  const nowMs = Date.now();
  const cooldownMs = EVENT_COOLDOWN_MS;
  if(proctorSession.lastEventAtByType[type] && (nowMs - proctorSession.lastEventAtByType[type]) < cooldownMs){
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

function setExamPrivacyShield(hidden){
  document.getElementById('exam-shell')?.classList.toggle('is-privacy-shielded', hidden);
}

function handleVisibility(){
  if(!proctorSession) return;
  if(document.visibilityState === 'hidden'){
    setExamPrivacyShield(true);
    recordProctorEvent('tab_switch','Student switched browser tab or window',12);
  } else {
    setExamPrivacyShield(false);
    recordProctorEvent('focus_return','Student returned to exam tab',2);
  }
}

function handleBlur(){ if(proctorSession){ setExamPrivacyShield(true); recordProctorEvent('focus_lost','Exam window lost focus',10); } }
function handleFocus(){ if(!proctorSession) return; setExamPrivacyShield(false); recordProctorEvent('focus_regained','Exam window regained focus',2); }
function handleCopy(e){
  if(!proctorSession) return;
  if(document.activeElement?.tagName === 'TEXTAREA') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  recordProctorEvent('copy_attempt','Copy action blocked during exam',14);
}
function handleCut(e){
  if(!proctorSession) return;
  if(document.activeElement?.tagName === 'TEXTAREA') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  recordProctorEvent('copy_attempt','Cut action blocked during exam',14);
}
function handlePaste(e){
  if(!proctorSession) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  recordProctorEvent('paste_attempt','Paste action blocked during exam',14);
}
function handleContextMenu(e){
  if(!proctorSession) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  recordProctorEvent('context_menu','Right-click context menu blocked',8);
}
function handleBeforeUnload(e){ if(!proctorSession) return; e.preventDefault(); e.returnValue = ''; }

function updateProctoringBadge(active){
  const el = document.getElementById('proctoring-badge');
  if(el) el.style.display = active ? 'inline-flex' : 'none';
}

function handleKeydown(e){
  if(!proctorSession) return;
  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if(e.key === 'PrintScreen'){
    recordProctorEvent('screenshot_attempt','Print Screen key pressed; screenshot capture may still succeed',16);
    toast('Print Screen key detected. The browser cannot reliably block screenshots.');
  }
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
  const major = session.events.filter(e=>['devtools_attempt','paste_attempt','copy_attempt','screenshot_attempt','focus_lost','tab_switch'].includes(e.type)).length;
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
  monitorGeneration++;
  if(monitorInterval){ clearInterval(monitorInterval); monitorInterval = null; monitorExamId = null; }
  monitorLiveEventHandler = null;
  monitorSessionJoinedHandler = null;
  monitorScoreUpdateHandler = null;
  const body = document.getElementById('proctor-modal-body');
  if(monitorStudentSelectionHandler){
    body.removeEventListener('click', monitorStudentSelectionHandler);
    monitorStudentSelectionHandler = null;
  }
  monitorBlinkTimeouts.forEach(timeout=>clearTimeout(timeout));
  monitorBlinkTimeouts.clear();
  if(monitorAudioContext){
    monitorAudioContext.close().catch(e=>console.warn('[ProctorVision] Could not close monitoring alert audio', e));
    monitorAudioContext = null;
  }
}
function openExamMonitor(examId){
  if(monitorInterval || monitorStudentSelectionHandler || monitorAudioContext) closeProctorModal();
  const thisMonitorGeneration = ++monitorGeneration;
  monitorExamId = examId;
  const body = document.getElementById('proctor-modal-body');
  let backendExamEvents = [];
  let backendExamSessions = [];
  let backendSessionsLoaded = false;
  let monitorRefreshInFlight = false;
  async function fetchBackendExamData(){
    if(!backendConnected || monitorRefreshInFlight) return;
    monitorRefreshInFlight = true;
    try{
      const response = await fetch(`${BACKEND_URL}/api/live/feed?exam_id=${encodeURIComponent(examId)}&limit=50`, { cache: 'no-store' });
      if(!response.ok) throw new Error(`Live monitoring request failed (${response.status})`);
      const liveData = await response.json();
      if(thisMonitorGeneration !== monitorGeneration) return;
      backendExamEvents = mergeMonitorEvents(backendExamEvents, liveData.events || []);
      backendExamSessions = (liveData.sessions || []).filter(session=>session.exam_id===examId);
      backendSessionsLoaded = true;
    }catch(e){
      console.warn('[ProctorVision] Could not refresh live monitoring data', e);
    }finally{
      monitorRefreshInFlight = false;
    }
  }
  function monitorEventKey(event){
    if(event.event_id != null) return `id:${event.event_id}`;
    if(event.id != null) return `id:${event.id}`;
    return [event.session_id, event.event_type || event.type, event.created_at || event.time, event.details].join('|');
  }
  function mergeMonitorEvents(current, incoming){
    const unique = new Map();
    [...incoming, ...current].forEach(event=>unique.set(monitorEventKey(event), event));
    return Array.from(unique.values())
      .sort((a,b)=>new Date(b.created_at || b.time || 0) - new Date(a.created_at || a.time || 0))
      .slice(0, 50);
  }
  monitorLiveEventHandler = ev=>{
    if(ev.exam_id !== examId) return;
    backendExamEvents = mergeMonitorEvents(backendExamEvents, [{
      event_id: ev.event_id,
      session_id: ev.session_id,
      student_name: ev.student_name,
      event_type: ev.type,
      details: ev.details,
      created_at: ev.created_at || ev.time,
      suspicion_score: backendLiveScores[ev.student_name + '|' + examId]?.suspicion_score,
    }]);
    render();
  };
  monitorSessionJoinedHandler = info=>{
    if(info.exam_id !== examId) return;
    backendSessionsLoaded = true;
    if(!monitorScores.has(info.student_name)) monitorScores.set(info.student_name, 0);
    backendExamSessions = [
      {
        id: info.session_id,
        exam_id: info.exam_id,
        student_name: info.student_name,
        joined_at: new Date().toISOString(),
      },
      ...backendExamSessions.filter(session=>session.id !== info.session_id),
    ];
    render();
  };
  monitorScoreUpdateHandler = score=>{
    if(score.exam_id !== examId) return;
    if(monitorScoresInitialized) updateMonitoredStudentScore(score.student_name, score.suspicion_score);
    else pendingMonitorScores.set(score.student_name, Number(score.suspicion_score) || 0);
    render();
  };
  let selectedMonitorStudent = null;
  let monitorScoresInitialized = false;
  const monitorScores = new Map();
  const pendingMonitorScores = new Map();
  const blinkingStudents = new Set();
  const blinkTimeouts = new Map();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  monitorAudioContext = null;
  try{
    if(AudioContextClass){
      monitorAudioContext = new AudioContextClass();
      if(monitorAudioContext.state === 'suspended'){
        monitorAudioContext.resume().catch(e=>console.warn('[ProctorVision] Could not enable the monitoring alert sound', e));
      }
    }
  }catch(e){
    console.warn('[ProctorVision] Could not initialize the monitoring alert sound', e);
  }
  function playThresholdDing(){
    if(!monitorAudioContext){
      console.warn('[ProctorVision] Alert sound is unavailable in this browser');
      return;
    }
    try{
      const now = monitorAudioContext.currentTime;
      const oscillator = monitorAudioContext.createOscillator();
      const gain = monitorAudioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now);
      oscillator.frequency.setValueAtTime(1174.66, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
      oscillator.connect(gain);
      gain.connect(monitorAudioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.4);
    }catch(e){
      console.warn('[ProctorVision] Could not play the monitoring alert sound', e);
    }
  }
  function alertForThreshold(studentName){
    const previousTimeout = blinkTimeouts.get(studentName);
    if(previousTimeout) clearTimeout(previousTimeout);
    blinkingStudents.add(studentName);
    playThresholdDing();
    render();
    const timeout = setTimeout(()=>{
      blinkingStudents.delete(studentName);
      blinkTimeouts.delete(studentName);
      monitorBlinkTimeouts.delete(studentName);
      render();
    }, 5000);
    blinkTimeouts.set(studentName, timeout);
    monitorBlinkTimeouts.set(studentName, timeout);
  }
  function updateMonitoredStudentScore(studentName, score){
    if(!studentName || !Number.isFinite(Number(score))) return;
    const nextScore = Number(score);
    const previousScore = monitorScores.get(studentName) || 0;
    monitorScores.set(studentName, nextScore);
    if(previousScore < 50 && nextScore >= 50) alertForThreshold(studentName);
  }
  function handleStudentSelection(event){
    const row = event.target.closest('[data-monitor-student-index]');
    if(!row || (event.target.closest('button') && !event.target.closest('.monitor-student-select'))) return;
    const index = Number(row.dataset.monitorStudentIndex);
    const student = currentMonitorJoins[index];
    if(!student) return;
    selectedMonitorStudent = selectedMonitorStudent === student.studentName ? null : student.studentName;
    render();
  }
  let currentMonitorJoins = [];
  monitorStudentSelectionHandler = handleStudentSelection;
  body.addEventListener('click', handleStudentSelection);
  function render(){
    data = loadData();
    const exam = data.exams.find(e=>e.id===examId);
    const localJoins = (data.studentJoins||[]).filter(j=>j.examId===examId && j.status==='joined');
    const joins = backendConnected && backendSessionsLoaded
      ? backendExamSessions.map(session=>({
          studentName: session.student_name,
          joinedAt: session.joined_at,
          sessionId: session.id,
          suspicionScore: session.suspicion_score,
        }))
      : localJoins;
    currentMonitorJoins = joins;
    const allLive = (data.liveEvents||[]).concat(liveEventBuffer||[]);
    const localEvents = allLive.filter(ev=>ev.examId===examId).slice(-200).reverse();
    const allEvents = backendConnected && backendSessionsLoaded
      ? backendExamEvents.map(ev=>({
          time: ev.created_at,
          studentName: ev.student_name,
          type: ev.event_type,
          details: ev.details,
          suspicion_score: ev.suspicion_score,
        }))
      : localEvents;
    const events = selectedMonitorStudent
      ? allEvents.filter(event=>event.studentName===selectedMonitorStudent)
      : allEvents;
    const byStudent = {};
    joins.forEach(student=>{
      const score = backendLiveScores[student.studentName + '|' + examId];
      if(score) byStudent[student.studentName] = score.suspicion_score;
      else if(student.suspicionScore != null) byStudent[student.studentName] = Number(student.suspicionScore);
    });
    if(backendExamEvents.length){
      backendExamEvents.forEach(ev=>{
        if(byStudent[ev.student_name] == null) byStudent[ev.student_name] = Math.min(100, ev.suspicion_score || 0);
      });
    } else if(!backendConnected || !backendSessionsLoaded) {
      allLive.filter(ev=>ev.examId===examId).forEach(ev=>{
        byStudent[ev.studentName] = (byStudent[ev.studentName]||0) + (ev.weight||0);
      });
    }
    joins.forEach(student=>{
      const score = backendLiveScores[student.studentName + '|' + examId]?.suspicion_score;
      const currentScore = score != null ? Number(score) : Number(byStudent[student.studentName] || 0);
      if(Number.isFinite(currentScore)){
        if(monitorScoresInitialized) updateMonitoredStudentScore(student.studentName, currentScore);
        else monitorScores.set(student.studentName, currentScore);
      }
    });
    if(!backendConnected) monitorScoresInitialized = true;
    body.innerHTML = `<div style="font-weight:700;margin-bottom:.5rem">Monitoring: ${escHtml(exam?exam.title:'Exam')}</div>
      <div style="font-size:.9rem;color:var(--muted);margin-bottom:.6rem">Exam ID: ${escHtml(exam?exam.id:'—')}</div>
      <div class="exam-monitor-grid"><div style="min-width:0"><div style="font-weight:600">Joined Students</div>
        ${(joins.length?joins.map((j,index)=>{
          const suspicion = Math.min(100, Math.round((byStudent[j.studentName]||0)));
          const selected = selectedMonitorStudent === j.studentName;
          return `<div class="monitor-student-row${selected?' selected':''}${blinkingStudents.has(j.studentName)?' threshold-blink':''}" data-monitor-student-index="${index}">
            <button type="button" class="monitor-student-select" aria-pressed="${selected}">
              <span class="monitor-student-name">${escHtml(j.studentName)}</span>
              <span class="monitor-student-joined">${new Date(j.joinedAt).toLocaleTimeString()}</span>
              <span class="monitor-student-score" style="color:${suspicion>=70?'#dc2626':suspicion>=40?'#f59e0b':'#10b981'}">${suspicion}%</span>
            </button>
            <button class="btn btn-ghost btn-sm" onclick="teacherFlag('${examId}','${escHtml(j.studentName)}')">🚩 Flag</button>
          </div>`;
        }).join(''):'<div style="color:var(--muted);padding:.4rem">No students joined yet.</div>')}</div>
      <div style="min-width:0"><div class="monitor-events-heading"><span>${selectedMonitorStudent?`Live Events — ${escHtml(selectedMonitorStudent)}`:'Live Events'}</span>${selectedMonitorStudent?'<button type="button" class="btn btn-ghost btn-sm" data-clear-monitor-student>Show all</button>':''}</div>
        ${(events.length?events.map(renderTeacherEventCard).join(''):'<div style="color:var(--muted);padding:.4rem">No student activity yet.</div>')}</div></div>`;
    const clearSelectionButton = body.querySelector('[data-clear-monitor-student]');
    if(clearSelectionButton){
      clearSelectionButton.addEventListener('click', ()=>{
        selectedMonitorStudent = null;
        render();
      });
    }
  }
  function acceptInitialScores(sessions){
    if(monitorScoresInitialized) return;
    sessions.forEach(session=>{
      monitorScores.set(session.student_name, Number(session.suspicion_score) || 0);
    });
    monitorScoresInitialized = true;
    pendingMonitorScores.forEach((score, studentName)=>updateMonitoredStudentScore(studentName, score));
    pendingMonitorScores.clear();
  }
  const loadBackendExamData = fetchBackendExamData;
  render();
  document.getElementById('proctor-modal').classList.add('show');
  if(monitorInterval) clearInterval(monitorInterval);
  async function refreshBackendExamData(){
    await loadBackendExamData();
    if(thisMonitorGeneration !== monitorGeneration) return;
    if(backendSessionsLoaded) acceptInitialScores(backendExamSessions);
    render();
  }
  refreshBackendExamData();
  monitorInterval = setInterval(refreshBackendExamData, 1000);
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
  setExamInputsDisabled(false);
  document.getElementById('exam-shell').classList.remove('show');
  activeExam=null; answers={};
  data = loadData();
  const activePage = document.querySelector('.page.active')?.id?.replace('page-','');
  if(currentRole==='student'&&activePage) navStudent(activePage, document.querySelector('#sidebar a.active'));
}
