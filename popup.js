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
  portalRawSwipes: $('portalRawSwipes'),
  portalHours: $('portalHours'),
  portalDeficit: $('portalDeficit'),
  lastSwipe: $('lastSwipe'),
  spentToday: $('spentToday'),
  lastSynced: $('lastSynced'),
  autoSwipesSection: $('autoSwipesSection'),
  autoSwipeList: $('autoSwipeList'),
  btnRefreshPortal: $('btnRefreshPortal'),
  debugSection: $('debugSection'),
  debugOutput: $('debugOutput'),
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
let allTimestamps = {};           // { "2026-03-24": [ts1, ts2, ...], ... }
let weekData = null;
let portalData = null;

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  updateUI();
  bindEvents();
  setInterval(() => updateUI(), 1000);
});

async function loadAll() {
  const stored = await chrome.storage.local.get(['mode', 'allTimestamps', 'weekData', 'portalData']);
  mode = stored.mode || 'manual';
  portalData = stored.portalData || null;
  allTimestamps = stored.allTimestamps || {};

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

  // Refresh from portal
  els.btnRefreshPortal.addEventListener('click', async () => {
    els.btnRefreshPortal.textContent = 'Refreshing...';
    els.btnRefreshPortal.disabled = true;
    try {
      // Query all tabs and find the Zing portal one
      const allTabs = await chrome.tabs.query({});
      const zingTab = allTabs.find(t => t.url && t.url.includes('zinghr.com'));
      if (zingTab) {
        try {
          await chrome.tabs.sendMessage(zingTab.id, { type: 'FORCE_SCRAPE' });
        } catch (msgErr) {
          // Content script may not be injected yet — try reloading the tab
          console.warn('[ZingTrack] Could not message content script:', msgErr);
        }
        // Wait for scrape to save
        await new Promise(r => setTimeout(r, 2500));
        const stored = await chrome.storage.local.get(['portalData']);
        portalData = stored.portalData || null;
        updateUI();
      } else {
        els.statusText.textContent = 'No Zing portal tab found. Open zingnext.zinghr.com first.';
      }
    } catch (e) {
      console.error('Refresh error:', e);
      els.statusText.textContent = 'Error: ' + e.message;
    }
    els.btnRefreshPortal.textContent = 'Refresh from Portal';
    els.btnRefreshPortal.disabled = false;
  });

  // Reset week
  els.btnResetWeek.addEventListener('click', async () => {
    if (!confirm('Reset entire week data?')) return;
    weekData = getEmptyWeekData();
    // Clear all timestamps for this week
    const monday = getMonday(new Date());
    for (let i = 0; i < 5; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      const key = dateToStr(d);
      delete allTimestamps[key];
    }
    await chrome.storage.local.set({ weekData, allTimestamps });
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
  if (!allTimestamps[selectedDate]) return;
  allTimestamps[selectedDate].splice(index, 1);
  await saveTimestamps();
  updateUI();
}

async function saveTimestamps() {
  await chrome.storage.local.set({ allTimestamps });
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

  // Get timestamps for selected day
  const selectedTs = allTimestamps[selectedDate] || [];
  const viewingToday = isToday(selectedDate);

  let officeMs = 0, breakMs = 0;

  if (mode === 'manual') {
    renderTimestampList(selectedTs, viewingToday);
    const calc = calculateFromTimestamps(selectedTs, viewingToday);
    officeMs = calc.officeMs;
    breakMs = calc.breakMs;
  } else {
    updateAutoUI();
    // In auto mode, try to use scraped swipe times for calculation
    const autoTs = getAutoTimestamps();
    if (autoTs.length > 0) {
      const calc = calculateFromTimestamps(autoTs, true);
      officeMs = calc.officeMs;
      breakMs = calc.breakMs;
    } else if (portalData && portalData.spentToday && portalData.spentToday !== '--:--') {
      officeMs = parseHHMM(portalData.spentToday);
      breakMs = 0;
    }
  }

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
  els.timestampList.innerHTML = '';
  if (!timestamps || timestamps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ts-empty';
    empty.textContent = 'No timestamps yet. Add your first swipe time above.';
    els.timestampList.appendChild(empty);
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
    els.timestampList.appendChild(div);
  });

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
    els.portalShift.textContent = '--';
    els.portalRawSwipes.textContent = '--';
    els.portalHours.textContent = '--';
    els.portalDeficit.textContent = '--';
    els.lastSwipe.textContent = '--';
    els.spentToday.textContent = '--:--';
    els.lastSynced.textContent = 'Never';
    els.autoSwipesSection.style.display = 'none';
    return;
  }

  // Punch status
  if (portalData.punchStatus === 'in') {
    els.punchStatus.textContent = 'Punched In';
    els.statusBanner.className = 'status-banner punched-in';
    els.statusText.textContent = 'Punched In - tracking live';
  } else if (portalData.punchStatus === 'out') {
    els.punchStatus.textContent = 'Punched Out';
    els.statusBanner.className = 'status-banner';
    els.statusText.textContent = 'Punched out for today';
  } else {
    els.punchStatus.textContent = '--';
    els.statusBanner.className = 'status-banner';
    els.statusText.textContent = 'Synced with portal';
  }

  els.portalShift.textContent = portalData.shift || '--';
  els.portalRawSwipes.textContent = portalData.rawSwipes || '--';
  els.portalHours.textContent = portalData.hours || '--';
  els.portalDeficit.textContent = portalData.deficit || '--';
  els.lastSwipe.textContent = portalData.lastSwipe || '--';
  els.spentToday.textContent = portalData.spentToday || '--:--';

  // Last synced
  const syncDate = new Date(portalData.scrapedAt);
  els.lastSynced.textContent = syncDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Show detected swipe times
  const swipes = portalData.swipeTimes || [];
  if (swipes.length > 0) {
    els.autoSwipesSection.style.display = 'block';
    renderAutoSwipeList(swipes);
  } else {
    els.autoSwipesSection.style.display = 'none';
  }

  // Show debug info
  if (portalData.debug) {
    els.debugSection.style.display = 'block';
    const dbg = portalData.debug;
    let debugText = '';
    if (dbg.allTimesFound && dbg.allTimesFound.length > 0) {
      debugText += 'TIMES FOUND ON PAGE:\n' + dbg.allTimesFound.join(', ') + '\n\n';
    } else {
      debugText += 'TIMES FOUND ON PAGE: none\n\n';
    }
    if (dbg.textSnippets && dbg.textSnippets.length > 0) {
      debugText += 'RELEVANT TEXT SNIPPETS:\n' + dbg.textSnippets.join('\n') + '\n';
    } else {
      debugText += 'RELEVANT TEXT SNIPPETS: none\n';
    }
    debugText += '\nRAW DATA:\n';
    debugText += 'spentToday: ' + (portalData.spentToday || 'null') + '\n';
    debugText += 'lastSwipe: ' + (portalData.lastSwipe || 'null') + '\n';
    debugText += 'punchStatus: ' + (portalData.punchStatus || 'null') + '\n';
    debugText += 'swipeTimes: ' + JSON.stringify(portalData.swipeTimes || []) + '\n';
    els.debugOutput.textContent = debugText;
  } else {
    els.debugSection.style.display = 'none';
  }
}

// Parse portal swipe time strings into epoch ms for today
function getAutoTimestamps() {
  if (!portalData || !portalData.swipeTimes || portalData.swipeTimes.length === 0) return [];

  const result = [];
  const today = new Date();

  for (const timeStr of portalData.swipeTimes) {
    const ms = parseSwipeTimeStr(timeStr, today);
    if (ms) result.push(ms);
  }

  result.sort((a, b) => a - b);
  return result;
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

function renderAutoSwipeList(swipes) {
  els.autoSwipeList.innerHTML = '';

  swipes.forEach((timeStr, i) => {
    const isIn = i % 2 === 0;
    const type = isIn ? 'IN' : 'OUT';

    const div = document.createElement('div');
    div.className = 'ts-item';
    div.innerHTML = `
      <span class="ts-index">${i + 1}</span>
      <span class="ts-time">${timeStr}</span>
      <span class="ts-type ${isIn ? 'in' : 'out'}">${type}</span>
    `;
    els.autoSwipeList.appendChild(div);
  });
}

function calculateCarryOver(dayIndex) {
  let carry = 0;
  const monday = getMonday(new Date());
  for (let i = 0; i < dayIndex && i < 5; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const dateStr = dateToStr(d);
    const ts = allTimestamps[dateStr] || [];
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
    const ts = allTimestamps[dateStr] || [];
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
    const ts = allTimestamps[dateStr] || [];
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
