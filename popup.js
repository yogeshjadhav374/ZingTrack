// Constants
const WORK_MS = 9 * 60 * 60 * 1000;
const BREAK_ALLOWANCE_MS = 30 * 60 * 1000;
const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 42;

// DOM refs
const $ = (id) => document.getElementById(id);
const els = {
  dayBadge: $('dayBadge'),
  btnManual: $('btnManual'),
  btnAuto: $('btnAuto'),
  manualMode: $('manualMode'),
  autoMode: $('autoMode'),
  // Day selector
  btnPrevDay: $('btnPrevDay'),
  btnNextDay: $('btnNextDay'),
  selectedDayName: $('selectedDayName'),
  selectedDayDate: $('selectedDayDate'),
  // Manual mode
  timeInput: $('timeInput'),
  btnAddTime: $('btnAddTime'),
  timestampList: $('timestampList'),
  btnClearDay: $('btnClearDay'),
  // Auto mode
  statusBanner: $('statusBanner'),
  statusText: $('statusText'),
  punchStatus: $('punchStatus'),
  portalShift: $('portalShift'),
  portalHours: $('portalHours'),
  portalDeficit: $('portalDeficit'),
  portalAttendance: $('portalAttendance'),
  lastSynced: $('lastSynced'),
  autoSwipeList: $('autoSwipeList'),
  btnRefreshPortal: $('btnRefreshPortal'),
  btnClearAutoDay: $('btnClearAutoDay'),
  // Progress
  progressTitle: $('progressTitle'),
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
let mode = 'manual';
let selectedDate = getTodayStr(); // YYYY-MM-DD of the day being viewed/edited
let allTimestamps = {};           // Manual mode: { "2026-03-24": [ts1, ts2, ...], ... }
let autoTimestamps = {};          // Auto mode: { "2026-03-24": [ts1, ts2, ...], ... }
let weekData = null;
let portalData = null;
let timeCardData = null;  // All days from GetTimeCard API

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  updateUI();
  bindEvents();
  setInterval(() => updateUI(), 1000);
});

async function loadAll() {
  const stored = await chrome.storage.local.get(['mode', 'allTimestamps', 'autoTimestamps', 'weekData', 'portalData', 'timeCardData']);
  mode = stored.mode || 'manual';
  portalData = stored.portalData || null;
  timeCardData = stored.timeCardData || null;
  allTimestamps = stored.allTimestamps || {};
  autoTimestamps = stored.autoTimestamps || {};

  // Load week data
  weekData = stored.weekData || getEmptyWeekData();
  const currentMonday = getMonday(new Date()).toISOString();
  if (weekData.weekStart !== currentMonday) {
    weekData = getEmptyWeekData();
    await chrome.storage.local.set({ weekData });
  }
}

function bindEvents() {
  // Mode toggle
  els.btnManual.addEventListener('click', () => switchMode('manual'));
  els.btnAuto.addEventListener('click', () => switchMode('auto'));

  // Day navigation
  els.btnPrevDay.addEventListener('click', () => navigateDay(-1));
  els.btnNextDay.addEventListener('click', () => navigateDay(1));

  // Add timestamp
  els.btnAddTime.addEventListener('click', () => addTimestamp());
  els.timeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTimestamp();
  });

  // Clear day
  els.btnClearDay.addEventListener('click', async () => {
    const label = isToday(selectedDate) ? 'today' : formatDateShort(selectedDate);
    if (!confirm(`Clear all timestamps for ${label}?`)) return;
    allTimestamps[selectedDate] = [];
    await saveTimestamps();
    updateUI();
  });

  // Fetch from portal — merges swipes into allTimestamps with dedup
  els.btnRefreshPortal.addEventListener('click', async () => {
    els.btnRefreshPortal.textContent = 'Fetching...';
    els.btnRefreshPortal.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'FETCH_TIMECARD' });
      if (response && response.ok) {
        const stored = await chrome.storage.local.get(['portalData', 'timeCardData']);
        portalData = stored.portalData || null;
        timeCardData = stored.timeCardData || null;

        // Merge fetched swipe times into autoTimestamps (dedup)
        if (timeCardData) {
          let changed = false;
          for (const [dateStr, dayData] of Object.entries(timeCardData)) {
            if (!dayData.swipeTimes || dayData.swipeTimes.length === 0) continue;
            const refDate = new Date(dateStr + 'T00:00:00');
            const fetchedMs = dayData.swipeTimes
              .map(s => parseSwipeTimeStr(s, refDate))
              .filter(Boolean);
            if (fetchedMs.length === 0) continue;

            const existing = autoTimestamps[dateStr] || [];
            // Count-based dedup: allow duplicates if portal has more occurrences
            // than what's already stored (e.g. 17:38 appears twice = OUT then IN)
            const usedExisting = new Array(existing.length).fill(false);
            const toAdd = [];
            for (const ts of fetchedMs) {
              // Find an unmatched existing entry within 1 minute
              const matchIdx = existing.findIndex((e, i) => !usedExisting[i] && Math.abs(e - ts) < 60000);
              if (matchIdx !== -1) {
                usedExisting[matchIdx] = true; // pair it, don't add again
              } else {
                toAdd.push(ts);
              }
            }
            if (toAdd.length > 0) {
              const merged = [...existing, ...toAdd].sort((a, b) => a - b);
              autoTimestamps[dateStr] = merged;
              changed = true;
            }
          }
          if (changed) await saveTimestamps();
        }

        updateUI();
        els.statusText.textContent = 'Synced successfully!';
      } else {
        els.statusText.textContent = response?.error || 'Failed to fetch data';
      }
    } catch (e) {
      console.error('Refresh error:', e);
      els.statusText.textContent = 'Error: ' + e.message;
    }
    els.btnRefreshPortal.textContent = 'Fetch from Portal';
    els.btnRefreshPortal.disabled = false;
  });

  // Clear day in auto mode
  els.btnClearAutoDay.addEventListener('click', async () => {
    const label = isToday(selectedDate) ? 'today' : formatDateShort(selectedDate);
    if (!confirm(`Clear all timestamps for ${label}?`)) return;
    autoTimestamps[selectedDate] = [];
    await saveTimestamps();
    updateUI();
  });

  // Reset week
  els.btnResetWeek.addEventListener('click', async () => {
    if (!confirm('Reset entire week data?')) return;
    weekData = getEmptyWeekData();
    // Clear all timestamps for this week (both manual and auto)
    const monday = getMonday(new Date());
    for (let i = 0; i < 5; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      const key = dateToStr(d);
      delete allTimestamps[key];
      delete autoTimestamps[key];
    }
    await chrome.storage.local.set({ weekData, allTimestamps, autoTimestamps });
    updateUI();
  });

  // Week day click to select
  els.weekGrid.addEventListener('click', (e) => {
    const dayEl = e.target.closest('.week-day');
    if (!dayEl) return;
    const idx = parseInt(dayEl.dataset.index, 10);
    if (isNaN(idx)) return;
    const monday = getMonday(new Date());
    const target = new Date(monday);
    target.setDate(target.getDate() + idx);
    const targetStr = dateToStr(target);
    // Only allow selecting today or past days
    if (targetStr <= getTodayStr()) {
      selectedDate = targetStr;
      updateUI();
    }
  });
}

// ─── Day Navigation ───
function navigateDay(delta) {
  const current = new Date(selectedDate + 'T00:00:00');
  current.setDate(current.getDate() + delta);
  const newDateStr = dateToStr(current);

  // Can't go into the future
  if (newDateStr > getTodayStr()) return;

  // Only navigate within the current week (Mon-Fri)
  const monday = getMonday(new Date());
  const mondayStr = dateToStr(monday);
  if (newDateStr < mondayStr) return;

  selectedDate = newDateStr;
  updateUI();
}

async function switchMode(newMode) {
  mode = newMode;
  await chrome.storage.local.set({ mode });
  updateUI();
}

// ─── Timestamp Parsing ───
function parseTimeInput(str) {
  str = str.trim().toLowerCase();
  if (!str) return null;

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

  // Create a Date for the SELECTED day with the given time
  const d = new Date(selectedDate + 'T00:00:00');
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

async function addTimestamp() {
  const raw = els.timeInput.value.trim();
  if (!raw) return;

  // Split by comma, semicolon, or pipe to accept multiple timestamps at once
  const parts = raw.split(/[,;|]+/).map(s => s.trim()).filter(Boolean);
  const parsed = [];
  let hasError = false;

  for (const part of parts) {
    const ts = parseTimeInput(part);
    if (!ts) {
      hasError = true;
      break;
    }
    parsed.push(ts);
  }

  if (hasError || parsed.length === 0) {
    els.timeInput.style.borderColor = '#ef4444';
    setTimeout(() => { els.timeInput.style.borderColor = ''; }, 1500);
    return;
  }

  if (!allTimestamps[selectedDate]) allTimestamps[selectedDate] = [];
  allTimestamps[selectedDate].push(...parsed);
  allTimestamps[selectedDate].sort((a, b) => a - b);

  await saveTimestamps();
  els.timeInput.value = '';
  els.timeInput.focus();
  updateUI();
}

async function removeTimestamp(index) {
  if (mode === 'auto') {
    if (!autoTimestamps[selectedDate]) return;
    autoTimestamps[selectedDate].splice(index, 1);
  } else {
    if (!allTimestamps[selectedDate]) return;
    allTimestamps[selectedDate].splice(index, 1);
  }
  await saveTimestamps();
  updateUI();
}

// Get timestamps for selected date based on active mode
function getActiveTimestamps(dateStr) {
  if (mode === 'auto') return autoTimestamps[dateStr] || [];
  return allTimestamps[dateStr] || [];
}

async function saveTimestamps() {
  await chrome.storage.local.set({ allTimestamps, autoTimestamps });
}

// ─── Calculations ───
function calculateFromTimestamps(timestamps, useNowForOpen) {
  let officeMs = 0;
  let breakMs = 0;
  const now = Date.now();

  if (!timestamps || timestamps.length === 0) return { officeMs: 0, breakMs: 0 };

  const pairs = [];
  for (let i = 0; i < timestamps.length; i += 2) {
    const inTime = timestamps[i];
    const outTime = (i + 1 < timestamps.length) ? timestamps[i + 1] : (useNowForOpen ? now : inTime);
    pairs.push({ inTime, outTime });
  }

  for (const pair of pairs) {
    officeMs += pair.outTime - pair.inTime;
  }

  for (let i = 1; i < pairs.length; i++) {
    const gap = pairs[i].inTime - pairs[i - 1].outTime;
    if (gap > 0) breakMs += gap;
  }

  return { officeMs, breakMs };
}

// ─── UI ───
function updateUI() {
  const now = new Date();
  const todayIndex = now.getDay() - 1;
  els.dayBadge.textContent = WEEK_DAYS[Math.max(0, Math.min(todayIndex, 4))];

  // Mode
  els.btnManual.classList.toggle('active', mode === 'manual');
  els.btnAuto.classList.toggle('active', mode === 'auto');
  els.manualMode.style.display = mode === 'manual' ? 'block' : 'none';
  els.autoMode.style.display = mode === 'auto' ? 'block' : 'none';

  // Day selector
  updateDaySelector();

  // Get timestamps for selected day based on active mode
  const selectedTs = getActiveTimestamps(selectedDate);
  const viewingToday = isToday(selectedDate);

  let officeMs = 0, breakMs = 0;

  if (mode === 'manual') {
    renderTimestampList(selectedTs, viewingToday);
  } else {
    updateAutoUI();
    // In auto mode, render the same timestamp list with delete buttons
    renderTimestampList(selectedTs, viewingToday);
  }

  // Both modes use allTimestamps for calculation
  const calc = calculateFromTimestamps(selectedTs, viewingToday);
  officeMs = calc.officeMs;
  breakMs = calc.breakMs;

  // Progress title
  els.progressTitle.textContent = viewingToday ? "Today's Progress" : `${formatDayName(selectedDate)} Progress`;

  // Total presence
  const totalPresenceMs = officeMs + breakMs;

  els.officeTime.textContent = fmtTime(totalPresenceMs);
  els.workTime.textContent = fmtTime(officeMs);
  const remainMs = Math.max(0, WORK_MS - totalPresenceMs);
  els.remainingTime.textContent = fmtTime(remainMs);

  const progress = Math.min(100, (totalPresenceMs / WORK_MS) * 100);
  els.dayProgress.style.width = progress + '%';
  els.progressPercent.textContent = Math.round(progress) + '%';
  els.dayProgress.classList.toggle('complete', progress >= 100);

  // Break
  const selectedDayIndex = getDayIndex(selectedDate);
  const carryOverMs = calculateCarryOver(selectedDayIndex);
  const totalAvailableMs = BREAK_ALLOWANCE_MS + carryOverMs;
  const breakRemainingMs = Math.max(0, totalAvailableMs - breakMs);
  const isOver = breakMs > totalAvailableMs;

  els.breakUsed.textContent = fmtMin(breakMs);
  els.carriedOver.textContent = fmtMin(carryOverMs);
  els.totalBreakAvailable.textContent = fmtMin(totalAvailableMs);
  els.breakRemaining.textContent = fmtMin(breakRemainingMs);

  const ratio = Math.min(1, breakMs / (totalAvailableMs || 1));
  els.breakArc.style.strokeDashoffset = CIRCLE_CIRCUMFERENCE * (1 - ratio);
  els.breakArc.classList.toggle('over', isOver);

  const highlightStrong = els.breakRemaining.closest('.break-row').querySelector('strong');
  if (highlightStrong) highlightStrong.style.color = isOver ? '#dc2626' : '#16a34a';

  if (isOver) {
    els.breakNote.textContent = 'Break exceeded by ' + fmtMin(breakMs - totalAvailableMs) + '!';
    els.breakNote.className = 'break-note visible warning';
  } else if (breakRemainingMs > 0 && breakMs > 0) {
    els.breakNote.textContent = 'You can still take ' + fmtMin(breakRemainingMs) + ' break';
    els.breakNote.className = 'break-note visible';
  } else {
    els.breakNote.className = 'break-note';
  }

  // Weekly
  updateWeekGrid(selectedDate);
  updateWeekTotals();
}

function updateDaySelector() {
  const today = getTodayStr();
  const monday = dateToStr(getMonday(new Date()));

  // Update label
  if (isToday(selectedDate)) {
    els.selectedDayName.textContent = 'Today';
  } else {
    els.selectedDayName.textContent = formatDayName(selectedDate);
  }
  els.selectedDayDate.textContent = formatDateShort(selectedDate);

  // Disable next if already today
  els.btnNextDay.disabled = (selectedDate >= today);
  // Disable prev if already Monday of this week
  els.btnPrevDay.disabled = (selectedDate <= monday);
}

function renderTimestampList(timestamps, useNowForOpen) {
  // Render into the correct container based on mode
  const container = mode === 'auto' ? els.autoSwipeList : els.timestampList;
  container.innerHTML = '';

  if (!timestamps || timestamps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ts-empty';
    empty.textContent = mode === 'auto'
      ? 'No swipes yet. Click "Fetch from Portal" to load.'
      : 'No timestamps yet. Add your first swipe time above.';
    container.appendChild(empty);
    return;
  }

  const now = Date.now();

  timestamps.forEach((ts, i) => {
    const isIn = i % 2 === 0;
    const type = isIn ? 'IN' : 'OUT';
    const time = new Date(ts);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

    let durationStr = '';
    if (isIn) {
      const outTs = (i + 1 < timestamps.length) ? timestamps[i + 1] : (useNowForOpen ? now : ts);
      const dur = outTs - ts;
      if (dur > 0) durationStr = fmtTime(dur);
    } else {
      if (i + 1 < timestamps.length) {
        const gap = timestamps[i + 1] - ts;
        if (gap > 0) durationStr = fmtTime(gap) + ' break';
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
    container.appendChild(div);
  });

  container.querySelectorAll('.ts-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      removeTimestamp(parseInt(btn.dataset.index, 10));
    });
  });
}

function updateAutoUI() {
  const dayData = getDayDataForSelectedDate();
  const data = dayData || portalData || {};
  const selectedTs = autoTimestamps[selectedDate] || [];

  if (!dayData && !portalData && selectedTs.length === 0) {
    els.statusBanner.className = 'status-banner no-portal';
    els.statusText.textContent = 'Click "Fetch from Portal" to load data';
    els.punchStatus.textContent = '--';
    els.portalShift.textContent = '--';
    els.portalHours.textContent = '--';
    els.portalDeficit.textContent = '--';
    els.portalAttendance.textContent = '--';
    els.lastSynced.textContent = 'Never';
    return;
  }

  // Punch status from timestamps count
  if (isToday(selectedDate)) {
    const isIn = selectedTs.length % 2 === 1;
    els.punchStatus.textContent = isIn ? 'Punched In' : 'Punched Out';
    els.statusBanner.className = isIn ? 'status-banner punched-in' : 'status-banner';
    els.statusText.textContent = isIn ? 'Punched In - tracking live' : `Viewing ${formatDayName(selectedDate)}`;
  } else {
    els.punchStatus.textContent = data.attendanceStatus || '--';
    els.statusBanner.className = 'status-banner';
    els.statusText.textContent = `Viewing ${formatDayName(selectedDate)}`;
  }

  els.portalShift.textContent = data.shift || '--';
  els.portalHours.textContent = data.workingHours || data.hours || '--';
  els.portalDeficit.textContent = data.deficit || '--';
  els.portalAttendance.textContent = data.attendanceStatus || '--';

  // Last synced
  const scrapedAt = data.scrapedAt || (portalData && portalData.scrapedAt);
  if (scrapedAt) {
    const syncDate = new Date(scrapedAt);
    els.lastSynced.textContent = syncDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } else {
    els.lastSynced.textContent = 'Never';
  }
}

// Get day data for the currently selected date from the timeCardData cache
function getDayDataForSelectedDate() {
  if (!timeCardData) return null;
  return timeCardData[selectedDate] || null;
}

// Parse various time formats: "10:30 AM", "14:30", "10:30", "2026-03-24 10:30:00"
function parseSwipeTimeStr(str, refDate) {
  str = String(str).trim();
  if (!str || str === '--' || str === '--:--') return null;

  // Try full datetime "YYYY-MM-DD HH:MM:SS"
  const dtMatch = str.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (dtMatch) {
    return new Date(
      parseInt(dtMatch[1]), parseInt(dtMatch[2]) - 1, parseInt(dtMatch[3]),
      parseInt(dtMatch[4]), parseInt(dtMatch[5]), parseInt(dtMatch[6] || 0)
    ).getTime();
  }

  // Try "HH:MM AM/PM" or "HH:MM"
  const timeMatch = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const ampm = (timeMatch[3] || '').toLowerCase();

    if (ampm === 'am' && h === 12) h = 0;
    if (ampm === 'pm' && h !== 12) h += 12;

    const d = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), h, m, 0, 0);
    return d.getTime();
  }

  return null;
}

function calculateCarryOver(dayIndex) {
  let carry = 0;
  const monday = getMonday(new Date());
  for (let i = 0; i < dayIndex && i < 5; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const dateStr = dateToStr(d);
    const ts = getActiveTimestamps(dateStr);
    if (ts.length > 0) {
      const calc = calculateFromTimestamps(ts, false);
      const unused = Math.max(0, BREAK_ALLOWANCE_MS - calc.breakMs);
      carry += unused;
    }
  }
  return carry;
}

function updateWeekGrid(selectedDateStr) {
  els.weekGrid.innerHTML = '';
  const monday = getMonday(new Date());
  const todayStr = getTodayStr();

  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const dateStr = dateToStr(d);
    const ts = getActiveTimestamps(dateStr);
    const isViewingToday = (dateStr === todayStr);
    const calc = calculateFromTimestamps(ts, isViewingToday);
    const total = calc.officeMs + calc.breakMs;

    const div = document.createElement('div');
    div.className = 'week-day';
    div.dataset.index = i;

    if (dateStr === todayStr) div.classList.add('today');
    if (dateStr === selectedDateStr) div.classList.add('selected');
    if (total >= WORK_MS) div.classList.add('completed');

    const officeStr = ts.length > 0 ? fmtTimeShort(total) : '--';
    const breakStr = ts.length > 0 ? fmtMin(calc.breakMs) : '--';

    div.innerHTML = `
      <div class="week-day-name">${WEEK_DAYS[i]}</div>
      <div class="week-day-hours">${officeStr}</div>
      <div class="week-day-break">${breakStr}</div>
    `;
    els.weekGrid.appendChild(div);
  }
}

function updateWeekTotals() {
  const monday = getMonday(new Date());
  const todayStr = getTodayStr();
  let totalOffice = 0;
  let totalBreak = 0;

  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const dateStr = dateToStr(d);
    const ts = getActiveTimestamps(dateStr);
    if (ts.length === 0) continue;
    const calc = calculateFromTimestamps(ts, dateStr === todayStr);
    totalOffice += calc.officeMs + calc.breakMs;
    totalBreak += calc.breakMs;
  }

  const totalWeekBreakBudget = 5 * BREAK_ALLOWANCE_MS;
  const breakLeft = Math.max(0, totalWeekBreakBudget - totalBreak);

  els.weekOffice.textContent = fmtTime(totalOffice);
  els.weekBreakUsed.textContent = fmtMin(totalBreak);
  els.weekBreakLeft.textContent = fmtMin(breakLeft);
}

// ─── Helpers ───
function parseHHMM(timeStr) {
  const parts = timeStr.split(':');
  if (parts.length !== 2) return 0;
  return (parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)) * 60 * 1000;
}

function fmtTime(ms) {
  const totalMin = Math.floor(Math.abs(ms) / 60000);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function fmtTimeShort(ms) {
  const totalMin = Math.floor(Math.abs(ms) / 60000);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`;
}

function fmtMin(ms) {
  return Math.floor(Math.abs(ms) / 60000) + 'm';
}

function getTodayStr() {
  return dateToStr(new Date());
}

function dateToStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isToday(dateStr) {
  return dateStr === getTodayStr();
}

function getDayIndex(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDay() - 1; // 0=Mon..4=Fri
}

function formatDayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString([], { weekday: 'long' });
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
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
