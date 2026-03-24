// Constants
const WORK_MS = 9 * 60 * 60 * 1000;           // 9 hours total per day
const BREAK_ALLOWANCE_MS = 30 * 60 * 1000;    // 30 min break per day
const WORK_ONLY_MS = WORK_MS - BREAK_ALLOWANCE_MS; // 8h 30m actual work
const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 42; // ~263.89

// DOM refs
const $ = (id) => document.getElementById(id);
const els = {
  dayBadge: $('dayBadge'),
  btnManual: $('btnManual'),
  btnAuto: $('btnAuto'),
  manualMode: $('manualMode'),
  autoMode: $('autoMode'),
  // Manual mode
  timeInput: $('timeInput'),
  btnAddTime: $('btnAddTime'),
  timestampList: $('timestampList'),
  btnClearToday: $('btnClearToday'),
  // Auto mode
  statusBanner: $('statusBanner'),
  statusText: $('statusText'),
  punchStatus: $('punchStatus'),
  lastSwipe: $('lastSwipe'),
  spentToday: $('spentToday'),
  // Progress
  dayProgress: $('dayProgress'),
  progressPercent: $('progressPercent'),
  officeTime: $('officeTime'),
  workTime: $('workTime'),
  remainingTime: $('remainingTime'),
  // Break
  breakUsed: $('breakUsed'),
  breakArc: $('breakArc'),
  carriedOver: $('carriedOver'),
  totalBreakAvailable: $('totalBreakAvailable'),
  breakRemaining: $('breakRemaining'),
  breakNote: $('breakNote'),
  // Week
  weekGrid: $('weekGrid'),
  weekOffice: $('weekOffice'),
  weekBreakUsed: $('weekBreakUsed'),
  weekBreakLeft: $('weekBreakLeft'),
  btnResetWeek: $('btnResetWeek')
};

// State
let mode = 'manual'; // 'manual' or 'auto'
let todayTimestamps = []; // array of epoch ms timestamps for today
let weekData = null;
let portalData = null;

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  updateUI();
  bindEvents();

  // Live update every second
  setInterval(() => updateUI(), 1000);
});

async function loadAll() {
  const stored = await chrome.storage.local.get(['mode', 'todayTimestamps', 'todayDate', 'weekData', 'portalData']);

  mode = stored.mode || 'manual';
  portalData = stored.portalData || null;

  const today = getTodayStr();

  // If stored timestamps are from a different day, archive them first
  if (stored.todayDate && stored.todayDate !== today && stored.todayTimestamps && stored.todayTimestamps.length > 0) {
    await archiveDayData(stored.todayDate, stored.todayTimestamps);
    todayTimestamps = [];
    await chrome.storage.local.set({ todayTimestamps: [], todayDate: today });
  } else {
    todayTimestamps = stored.todayTimestamps || [];
  }

  // Load week data
  weekData = stored.weekData || getEmptyWeekData();
  const currentMonday = getMonday(new Date()).toISOString();
  if (weekData.weekStart !== currentMonday) {
    weekData = getEmptyWeekData();
    await chrome.storage.local.set({ weekData });
  }

  // Ensure todayDate is set
  if (!stored.todayDate || stored.todayDate !== today) {
    await chrome.storage.local.set({ todayDate: today });
  }
}

function bindEvents() {
  // Mode toggle
  els.btnManual.addEventListener('click', () => switchMode('manual'));
  els.btnAuto.addEventListener('click', () => switchMode('auto'));

  // Add timestamp
  els.btnAddTime.addEventListener('click', () => addTimestamp());
  els.timeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTimestamp();
  });

  // Clear today
  els.btnClearToday.addEventListener('click', async () => {
    if (!confirm('Clear all timestamps for today?')) return;
    todayTimestamps = [];
    await chrome.storage.local.set({ todayTimestamps: [] });
    updateUI();
  });

  // Reset week
  els.btnResetWeek.addEventListener('click', async () => {
    if (!confirm('Reset entire week data?')) return;
    weekData = getEmptyWeekData();
    todayTimestamps = [];
    await chrome.storage.local.set({ weekData, todayTimestamps: [], todayDate: getTodayStr() });
    updateUI();
  });
}

async function switchMode(newMode) {
  mode = newMode;
  await chrome.storage.local.set({ mode });
  updateModeUI();
  updateUI();
}

function updateModeUI() {
  els.btnManual.classList.toggle('active', mode === 'manual');
  els.btnAuto.classList.toggle('active', mode === 'auto');
  els.manualMode.style.display = mode === 'manual' ? 'block' : 'none';
  els.autoMode.style.display = mode === 'auto' ? 'block' : 'none';
}

// ─── Timestamp Parsing ───
// Accepts formats: "11:58 am", "11:58am", "1:51 PM", "13:51", "9:00"
function parseTimeInput(str) {
  str = str.trim().toLowerCase();
  if (!str) return null;

  // Match "HH:MM am/pm" or "HH:MM"
  const match = str.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3];

  if (minutes < 0 || minutes > 59) return null;

  if (ampm) {
    if (hours < 1 || hours > 12) return null;
    if (ampm === 'am' && hours === 12) hours = 0;
    if (ampm === 'pm' && hours !== 12) hours += 12;
  } else {
    if (hours < 0 || hours > 23) return null;
  }

  // Create a Date for today with the given time
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  return d.getTime();
}

async function addTimestamp() {
  const raw = els.timeInput.value.trim();
  if (!raw) return;

  const ts = parseTimeInput(raw);
  if (!ts) {
    els.timeInput.style.borderColor = '#ef4444';
    setTimeout(() => { els.timeInput.style.borderColor = ''; }, 1500);
    return;
  }

  todayTimestamps.push(ts);
  // Sort timestamps chronologically
  todayTimestamps.sort((a, b) => a - b);

  await chrome.storage.local.set({ todayTimestamps, todayDate: getTodayStr() });
  els.timeInput.value = '';
  els.timeInput.focus();
  updateUI();
}

async function removeTimestamp(index) {
  todayTimestamps.splice(index, 1);
  await chrome.storage.local.set({ todayTimestamps });
  updateUI();
}

// ─── Calculations ───
// Timestamps alternate: IN, OUT, IN, OUT, ...
// Office time = sum of all (OUT - IN) pairs
// If odd number of timestamps, last IN is still open (use current time)
// Break time = gaps between OUT and next IN
function calculateFromTimestamps(timestamps) {
  let officeMs = 0;
  let breakMs = 0;
  const now = Date.now();

  if (timestamps.length === 0) return { officeMs: 0, breakMs: 0, workMs: 0, isActive: false };

  const pairs = [];
  for (let i = 0; i < timestamps.length; i += 2) {
    const inTime = timestamps[i];
    const outTime = (i + 1 < timestamps.length) ? timestamps[i + 1] : now;
    pairs.push({ inTime, outTime, isOpen: (i + 1 >= timestamps.length) });
  }

  // Calculate office time (sum of IN-OUT durations)
  for (const pair of pairs) {
    officeMs += pair.outTime - pair.inTime;
  }

  // Calculate break time (gaps between consecutive pairs)
  for (let i = 1; i < pairs.length; i++) {
    const gap = pairs[i].inTime - pairs[i - 1].outTime;
    if (gap > 0) breakMs += gap;
  }

  const workMs = Math.max(0, officeMs - breakMs);
  const isActive = pairs.length > 0 && pairs[pairs.length - 1].isOpen;

  // Total time from first IN to now (or last OUT)
  // officeMs here is pure "in-office" time (sum of IN-OUT)
  // breakMs is the gap time between sessions

  return { officeMs, breakMs, workMs, isActive };
}

// ─── UI ───
function updateUI() {
  const now = new Date();
  const dayIndex = now.getDay() - 1; // 0=Mon .. 4=Fri
  const dayName = WEEK_DAYS[Math.max(0, Math.min(dayIndex, 4))];
  els.dayBadge.textContent = dayName;

  updateModeUI();
  renderTimestampList();

  let officeMs = 0, breakMs = 0;

  if (mode === 'manual') {
    const calc = calculateFromTimestamps(todayTimestamps);
    officeMs = calc.officeMs;
    breakMs = calc.breakMs;
  } else {
    // Auto mode - from portal data
    if (portalData && portalData.spentToday && portalData.spentToday !== '--:--') {
      officeMs = parseHHMM(portalData.spentToday);
    }
    breakMs = 0;
    updateAutoUI();
  }

  // ── Today's Progress (based on total office time = officeMs + breakMs) ──
  const totalPresenceMs = officeMs + breakMs; // total time from first IN to last OUT/now
  // Actually for manual: officeMs is IN-office time, breakMs is gap time
  // Total wall clock time = officeMs + breakMs
  // The 9hr target includes 30min break, so progress should be based on total presence
  els.officeTime.textContent = fmtTime(totalPresenceMs);
  els.workTime.textContent = fmtTime(officeMs); // actual working time (in-office, excludes breaks)
  const remainMs = Math.max(0, WORK_MS - totalPresenceMs);
  els.remainingTime.textContent = fmtTime(remainMs);

  const progress = Math.min(100, (totalPresenceMs / WORK_MS) * 100);
  els.dayProgress.style.width = progress + '%';
  els.progressPercent.textContent = Math.round(progress) + '%';
  els.dayProgress.classList.toggle('complete', progress >= 100);

  // ── Break calculation ──
  const carryOverMs = calculateCarryOver(dayIndex);
  const totalAvailableMs = BREAK_ALLOWANCE_MS + carryOverMs;
  const breakRemainingMs = Math.max(0, totalAvailableMs - breakMs);
  const isOver = breakMs > totalAvailableMs;

  els.breakUsed.textContent = fmtMin(breakMs);
  els.carriedOver.textContent = fmtMin(carryOverMs);
  els.totalBreakAvailable.textContent = fmtMin(totalAvailableMs);
  els.breakRemaining.textContent = fmtMin(breakRemainingMs);

  // Break circle
  const ratio = Math.min(1, breakMs / (totalAvailableMs || 1));
  els.breakArc.style.strokeDashoffset = CIRCLE_CIRCUMFERENCE * (1 - ratio);
  els.breakArc.classList.toggle('over', isOver);

  const highlightStrong = els.breakRemaining.closest('.break-row').querySelector('strong');
  if (highlightStrong) highlightStrong.style.color = isOver ? '#f87171' : '#4ade80';

  // Break note
  if (isOver) {
    els.breakNote.textContent = 'Break exceeded by ' + fmtMin(breakMs - totalAvailableMs) + '!';
    els.breakNote.className = 'break-note visible warning';
  } else if (breakRemainingMs > 0 && breakMs > 0) {
    els.breakNote.textContent = 'You can still take ' + fmtMin(breakRemainingMs) + ' break today';
    els.breakNote.className = 'break-note visible';
  } else {
    els.breakNote.className = 'break-note';
  }

  // ── Weekly ──
  updateWeekGrid(dayIndex, totalPresenceMs, breakMs);
  updateWeekTotals(dayIndex, totalPresenceMs, breakMs);
}

function renderTimestampList() {
  if (mode !== 'manual') return;

  els.timestampList.innerHTML = '';
  if (todayTimestamps.length === 0) {
    els.timestampList.innerHTML = '<div style="text-align:center;color:#475569;font-size:11px;padding:12px;">No timestamps yet. Add your first swipe time above.</div>';
    return;
  }

  const now = Date.now();

  todayTimestamps.forEach((ts, i) => {
    const isIn = i % 2 === 0;
    const type = isIn ? 'IN' : 'OUT';
    const time = new Date(ts);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

    // Calculate duration for this segment
    let durationStr = '';
    if (isIn) {
      // IN timestamp - show duration until next OUT or now
      const outTs = (i + 1 < todayTimestamps.length) ? todayTimestamps[i + 1] : now;
      const dur = outTs - ts;
      durationStr = fmtTime(dur);
    } else {
      // OUT timestamp - show break duration until next IN
      if (i + 1 < todayTimestamps.length) {
        const gap = todayTimestamps[i + 1] - ts;
        durationStr = fmtTime(gap) + ' break';
      }
    }

    const div = document.createElement('div');
    div.className = 'ts-item';
    div.innerHTML = `
      <span class="ts-index">${i + 1}</span>
      <span class="ts-time">${timeStr}</span>
      <span class="ts-type ${isIn ? 'in' : 'out'}">${type}</span>
      <span class="ts-duration">${durationStr}</span>
      <button class="ts-remove" data-index="${i}" title="Remove">&times;</button>
    `;
    els.timestampList.appendChild(div);
  });

  // Bind remove buttons
  els.timestampList.querySelectorAll('.ts-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      removeTimestamp(parseInt(btn.dataset.index, 10));
    });
  });
}

function updateAutoUI() {
  if (!portalData || !portalData.scrapedAt) {
    els.statusBanner.className = 'status-banner no-portal';
    els.statusText.textContent = 'Open zingnext.zinghr.com to sync';
    els.punchStatus.textContent = '--';
    els.lastSwipe.textContent = '--';
    els.spentToday.textContent = '--:--';
    return;
  }

  if (portalData.punchStatus === 'in') {
    els.punchStatus.textContent = 'Punched In';
    els.statusBanner.className = 'status-banner punched-in';
    els.statusText.textContent = 'Punched In - tracking time';
  } else {
    els.punchStatus.textContent = portalData.punchStatus === 'out' ? 'Punched Out' : 'Unknown';
    els.statusBanner.className = 'status-banner';
    els.statusText.textContent = 'Punched out for today';
  }

  els.lastSwipe.textContent = portalData.lastSwipe || '--';
  els.spentToday.textContent = portalData.spentToday || '--:--';
}

function calculateCarryOver(todayIndex) {
  // Sum unused break from previous completed days this week
  let carry = 0;
  for (let i = 0; i < todayIndex && i < 5; i++) {
    const day = weekData.days[i];
    if (day && day.officeMs > 0) {
      // Unused break = allowance - break used that day
      const unused = Math.max(0, BREAK_ALLOWANCE_MS - (day.breakMs || 0));
      carry += unused;
    }
  }
  return carry;
}

function updateWeekGrid(todayIndex, todayOfficeMs, todayBreakMs) {
  els.weekGrid.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const day = weekData.days[i] || {};
    const div = document.createElement('div');
    div.className = 'week-day';

    if (i === todayIndex) div.classList.add('today');
    if (day.completed) div.classList.add('completed');

    let officeStr = '--';
    let breakStr = '--';

    if (i === todayIndex) {
      officeStr = fmtTimeShort(todayOfficeMs);
      breakStr = fmtMin(todayBreakMs);
    } else if (day.officeMs !== undefined && day.officeMs > 0) {
      officeStr = fmtTimeShort(day.officeMs);
      breakStr = fmtMin(day.breakMs || 0);
    }

    div.innerHTML = `
      <div class="week-day-name">${WEEK_DAYS[i]}</div>
      <div class="week-day-hours">${officeStr}</div>
      <div class="week-day-break">${breakStr}</div>
    `;
    els.weekGrid.appendChild(div);
  }
}

function updateWeekTotals(todayIndex, todayOfficeMs, todayBreakMs) {
  let totalOffice = todayOfficeMs;
  let totalBreak = todayBreakMs;

  for (let i = 0; i < 5; i++) {
    if (i === todayIndex) continue;
    const day = weekData.days[i] || {};
    totalOffice += day.officeMs || 0;
    totalBreak += day.breakMs || 0;
  }

  const totalWeekBreakBudget = 5 * BREAK_ALLOWANCE_MS;
  const breakLeft = Math.max(0, totalWeekBreakBudget - totalBreak);

  els.weekOffice.textContent = fmtTime(totalOffice);
  els.weekBreakUsed.textContent = fmtMin(totalBreak);
  els.weekBreakLeft.textContent = fmtMin(breakLeft);
}

// ─── Day Archive ───
async function archiveDayData(dateStr, timestamps) {
  const stored = await chrome.storage.local.get(['weekData']);
  const wd = stored.weekData || getEmptyWeekData();

  const d = new Date(dateStr);
  const dayIndex = d.getDay() - 1; // 0=Mon..4=Fri

  if (dayIndex < 0 || dayIndex > 4) return; // Weekend, skip

  const calc = calculateFromTimestamps(timestamps);
  const totalPresence = calc.officeMs + calc.breakMs;

  wd.days[dayIndex] = {
    officeMs: totalPresence,
    breakMs: calc.breakMs,
    completed: totalPresence > 0
  };

  await chrome.storage.local.set({ weekData: wd });
  weekData = wd;
}

// ─── Helpers ───
function parseHHMM(timeStr) {
  const parts = timeStr.split(':');
  if (parts.length !== 2) return 0;
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  return (h * 60 + m) * 60 * 1000;
}

function fmtTime(ms) {
  const totalMin = Math.floor(Math.abs(ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function fmtTimeShort(ms) {
  const totalMin = Math.floor(Math.abs(ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function fmtMin(ms) {
  return Math.floor(Math.abs(ms) / 60000) + 'm';
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getEmptyWeekData() {
  return {
    weekStart: getMonday(new Date()).toISOString(),
    days: [{}, {}, {}, {}, {}],
    carryOverMs: 0
  };
}
