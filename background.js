// Background service worker
// Handles: TimeCard API fetch, day rollover, week reset

const ALARM_NAME = 'zingtrack-day-check';
const BREAK_MS = 30 * 60 * 1000;

chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await checkDayRollover();
});

chrome.runtime.onStartup.addListener(async () => {
  await checkDayRollover();
});

// ── Message handler ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_TIMECARD') {
    fetchTimeCard()
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async
  }
  if (message.type === 'PORTAL_DATA') {
    checkDayRollover();
  }
  return true;
});

// ── Fetch TimeCard by scraping the #printtable on the TimeCard page ──
async function fetchTimeCard() {
  // 1. Find the TimeCard tab on portal.zinghr.com
  const allTabs = await chrome.tabs.query({});
  let portalTab = allTabs.find(t => t.url && t.url.includes('portal.zinghr.com/2015/Pages/TNA/TimeCard'));
  if (!portalTab) {
    portalTab = allTabs.find(t => t.url && t.url.includes('portal.zinghr.com'));
  }
  if (!portalTab) {
    portalTab = allTabs.find(t => t.url && t.url.includes('zinghr.com'));
  }

  if (!portalTab) {
    throw new Error('No Zing portal tab found. Open the TimeCard page on portal.zinghr.com first.');
  }

  // 2. Execute scraper inside the portal tab
  const results = await chrome.scripting.executeScript({
    target: { tabId: portalTab.id },
    func: scrapeTimeCardTable
  });

  if (!results || !results[0]) {
    throw new Error('Script execution failed');
  }

  const scriptResult = results[0].result;

  if (scriptResult.error) {
    throw new Error(scriptResult.error);
  }

  const records = scriptResult.records;
  const todayStr = new Date().toISOString().split('T')[0];
  const allDays = {};
  let todayData = null;

  for (const rec of records) {
    const swipeTimes = rec.swipeDetails
      ? rec.swipeDetails.split(',').map(s => s.trim()).filter(s => /\d{1,2}:\d{2}/.test(s))
      : [];

    const dayData = {
      ...rec,
      swipeTimes,
      scrapedAt: Date.now()
    };

    allDays[rec.date] = dayData;

    if (rec.date === todayStr) {
      todayData = {
        ...dayData,
        spentToday: rec.workingHours || null,
        lastSwipe: swipeTimes.length > 0 ? swipeTimes[swipeTimes.length - 1] : null,
        punchStatus: swipeTimes.length % 2 === 1 ? 'in' : 'out',
        rawSwipes: rec.swipeDetails || null,
        hours: rec.workingHours || null,
        debug: { source: 'TimeCard table scrape', recordCount: records.length }
      };
    }
  }

  if (!todayData) {
    todayData = {
      date: todayStr,
      swipeTimes: [],
      spentToday: null,
      lastSwipe: null,
      punchStatus: null,
      rawSwipes: null,
      hours: null,
      deficit: null,
      scrapedAt: Date.now(),
      debug: { source: 'TimeCard table scrape', recordCount: records.length, note: 'No record for today' }
    };
  }

  // 3. Store in chrome.storage
  await chrome.storage.local.set({
    portalData: todayData,
    timeCardData: allDays,
    lastFetchedAt: Date.now()
  });

  return { todayData, allDays };
}

// This function runs INSIDE the portal tab — scrapes the #printtable HTML table
function scrapeTimeCardTable() {
  try {
    var table = document.querySelector('#printtable');
    if (!table) {
      return { error: 'TimeCard table (#printtable) not found. Make sure the TimeCard page is open and loaded.' };
    }

    var rows = table.querySelectorAll('tr');
    if (rows.length < 2) {
      return { error: 'TimeCard table has no data rows.' };
    }

    // First row is the header: EMPCODE, DATE, DAY, SHIFT NAME, FIRST IN, LAST OUT,
    // WORKING HOURS, EXTRA HOURS, DEFICIT, SWIPE DETAILS, ATTENDANCE STATUS, REASON,
    // OVERTIME DURATION, OVERTIME STATUS
    var records = [];

    for (var i = 1; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('td');
      if (cells.length < 12) continue;

      records.push({
        empCode:          (cells[0].textContent || '').trim(),
        date:             (cells[1].textContent || '').trim(),
        day:              (cells[2].textContent || '').trim(),
        shift:            (cells[3].textContent || '').trim(),
        firstIn:          (cells[4].textContent || '').trim(),
        lastOut:          (cells[5].textContent || '').trim(),
        workingHours:     (cells[6].textContent || '').trim(),
        extraHours:       (cells[7].textContent || '').trim(),
        deficit:          (cells[8].textContent || '').trim(),
        swipeDetails:     (cells[9].textContent || '').trim(),
        attendanceStatus: (cells[10].textContent || '').trim(),
        reason:           (cells[11].textContent || '').trim()
      });
    }

    return { records: records };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Day rollover ──
async function checkDayRollover() {
  const stored = await chrome.storage.local.get(['todayDate', 'todayTimestamps', 'weekData']);
  const today = new Date().toISOString().split('T')[0];

  if (!stored.todayDate || stored.todayDate === today) return;

  const timestamps = stored.todayTimestamps || [];
  if (timestamps.length > 0) {
    const weekData = stored.weekData || getEmptyWeekData();

    const currentMonday = getMonday(new Date()).toISOString();
    if (weekData.weekStart !== currentMonday) {
      const newWeek = getEmptyWeekData();
      await chrome.storage.local.set({ weekData: newWeek, todayTimestamps: [], todayDate: today });
      return;
    }

    const d = new Date(stored.todayDate);
    const dayIndex = d.getDay() - 1;

    if (dayIndex >= 0 && dayIndex <= 4) {
      const calc = calculateFromTimestamps(timestamps);
      const totalPresence = calc.officeMs + calc.breakMs;

      weekData.days[dayIndex] = {
        officeMs: totalPresence,
        breakMs: calc.breakMs,
        completed: totalPresence > 0
      };

      await chrome.storage.local.set({ weekData, todayTimestamps: [], todayDate: today });
    }
  } else {
    await chrome.storage.local.set({ todayTimestamps: [], todayDate: today });
  }
}

function calculateFromTimestamps(timestamps) {
  let officeMs = 0;
  let breakMs = 0;
  if (timestamps.length === 0) return { officeMs: 0, breakMs: 0 };

  const pairs = [];
  for (let i = 0; i < timestamps.length; i += 2) {
    const inTime = timestamps[i];
    const outTime = (i + 1 < timestamps.length) ? timestamps[i + 1] : inTime;
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

console.log('[ZingTrack] Background service worker loaded');
