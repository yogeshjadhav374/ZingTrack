// Constants
const WORK_MS = 9 * 60 * 60 * 1000;
const BREAK_ALLOWANCE_MS = 30 * 60 * 1000;
const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// DOM refs
const $ = (id) => document.getElementById(id);
const els = {
  currentDateTime: $('currentDateTime'),
  // Auto (Portal) mode
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
  breakTimeStat: $('breakTimeStat'),
  remainingTime: $('remainingTime'),
  // Average Work Time
  avgDaySelector: $('avgDaySelector'),
  avgWorkValue: $('avgWorkValue'),
  avgWorkSub: $('avgWorkSub'),
  // Week
  weekGrid: $('weekGrid'),
  weekOffice: $('weekOffice'),
  weekBreakUsed: $('weekBreakUsed'),
  weekBreakLeft: $('weekBreakLeft'),
  btnResetWeek: $('btnResetWeek')
};

// State
let mode = 'auto'; // Auto (Portal) only — manual mode removed
let selectedDate = getTodayStr(); // YYYY-MM-DD of the day being viewed/edited
let allTimestamps = {};           // Manual mode: { "2026-03-24": [ts1, ts2, ...], ... }
let autoTimestamps = {};          // Auto mode: { "2026-03-24": [ts1, ts2, ...], ... }
let weekData = null;
let portalData = null;
let timeCardData = null;  // All days from GetTimeCard API
let avgSelectedDays = new Set(); // weekday indices (0=Mon..4=Fri) for Average Work Time

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  updateUI();
  bindEvents();
  setInterval(() => updateUI(), 1000);
});

async function loadAll() {
  const stored = await chrome.storage.local.get(['allTimestamps', 'autoTimestamps', 'weekData', 'portalData', 'timeCardData']);
  mode = 'auto';
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

  // Average Work Time — toggle weekday chips (multi-select)
  els.avgDaySelector.addEventListener('click', (e) => {
    const chip = e.target.closest('.avg-day-chip');
    if (!chip) return;
    const idx = parseInt(chip.dataset.index, 10);
    if (isNaN(idx)) return;
    if (avgSelectedDays.has(idx)) avgSelectedDays.delete(idx);
    else avgSelectedDays.add(idx);
    updateAvgWorkTime();
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

// Day selection is driven by clicking a day in the Weekly Summary grid.

async function removeTimestamp(index) {
  if (!autoTimestamps[selectedDate]) return;
  autoTimestamps[selectedDate].splice(index, 1);
  await saveTimestamps();
  updateUI();
}

// Get timestamps for the selected date (Auto/Portal store)
function getActiveTimestamps(dateStr) {
  return autoTimestamps[dateStr] || [];
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
  // Current date & day (always today)
  els.currentDateTime.textContent = new Date().toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
  });

  // Get timestamps for selected day
  const selectedTs = getActiveTimestamps(selectedDate);
  const viewingToday = isToday(selectedDate);

  let officeMs = 0, breakMs = 0;

  updateAutoUI();
  renderTimestampList(selectedTs, viewingToday);

  const calc = calculateFromTimestamps(selectedTs, viewingToday);
  officeMs = calc.officeMs;
  breakMs = calc.breakMs;

  // Progress title
  els.progressTitle.textContent = viewingToday ? "Today's Progress" : `${formatDayName(selectedDate)} Progress`;

  // Total presence
  const totalPresenceMs = officeMs + breakMs;

  els.officeTime.textContent = fmtTime(totalPresenceMs);
  els.workTime.textContent = fmtTime(officeMs);
  els.breakTimeStat.textContent = fmtMin(breakMs);
  const remainMs = Math.max(0, WORK_MS - totalPresenceMs);
  els.remainingTime.textContent = fmtTime(remainMs);

  const progress = Math.min(100, (totalPresenceMs / WORK_MS) * 100);
  els.dayProgress.style.width = progress + '%';
  els.progressPercent.textContent = Math.round(progress) + '%';
  els.dayProgress.classList.toggle('complete', progress >= 100);

  // Average work time across the selected weekdays
  updateAvgWorkTime();

  // Weekly
  updateWeekGrid(selectedDate);
  updateWeekTotals();
}

// ─── Average Work Time ───
// avgSelectedDays holds weekday indices (0=Mon .. 4=Fri) chosen by the user.
function updateAvgWorkTime() {
  const monday = getMonday(new Date());
  const todayStr = getTodayStr();

  // Reflect selection state on the chips
  els.avgDaySelector.querySelectorAll('.avg-day-chip').forEach(chip => {
    const idx = parseInt(chip.dataset.index, 10);
    chip.classList.toggle('active', avgSelectedDays.has(idx));
  });

  if (avgSelectedDays.size === 0) {
    els.avgWorkValue.textContent = '--';
    els.avgWorkSub.textContent = 'No day selected';
    return;
  }

  let totalWork = 0;
  let daysWithData = 0;

  for (const idx of avgSelectedDays) {
    const d = new Date(monday);
    d.setDate(d.getDate() + idx);
    const dateStr = dateToStr(d);
    const ts = getActiveTimestamps(dateStr);
    if (ts.length === 0) continue;
    const calc = calculateFromTimestamps(ts, dateStr === todayStr);
    totalWork += calc.officeMs; // work time = office time excluding breaks
    daysWithData++;
  }

  if (daysWithData === 0) {
    els.avgWorkValue.textContent = '0h 0m';
    els.avgWorkSub.textContent = `${avgSelectedDays.size} day(s) selected · no data yet`;
    return;
  }

  const avg = totalWork / daysWithData;
  els.avgWorkValue.textContent = fmtTime(avg);
  els.avgWorkSub.textContent =
    `Average of ${daysWithData} day${daysWithData > 1 ? 's' : ''} worked`;
}

function renderTimestampList(timestamps, useNowForOpen) {
  const container = els.autoSwipeList;
  container.innerHTML = '';

  if (!timestamps || timestamps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ts-empty';
    empty.textContent = 'No swipes yet. Click "Fetch from Portal" to load.';
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

  // Base budget is always the full 5-day week (150m).
  // Extra presence beyond 9h on any day adds to the pool on top.
  let totalWeekBreakBudget = 5 * BREAK_ALLOWANCE_MS;

  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const dateStr = dateToStr(d);

    const ts = getActiveTimestamps(dateStr);
    if (ts.length === 0) continue;

    const calc = calculateFromTimestamps(ts, dateStr === todayStr);
    const presence = calc.officeMs + calc.breakMs;
    totalOffice += presence;
    totalBreak += calc.breakMs;
    // Any time beyond 9h on a given day extends the weekly break pool
    totalWeekBreakBudget += Math.max(0, presence - WORK_MS);
  }

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
