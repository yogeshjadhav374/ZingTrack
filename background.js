// Background service worker
// Handles day rollover: archives yesterday's timestamps into weekData

const ALARM_NAME = 'zingtrack-day-check';
const BREAK_MS = 30 * 60 * 1000;

chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await checkDayRollover();
});

chrome.runtime.onStartup.addListener(async () => {
  await checkDayRollover();
});

// Also listen for portal data from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PORTAL_DATA') {
    checkDayRollover();
  }
  return true;
});

async function checkDayRollover() {
  const stored = await chrome.storage.local.get(['todayDate', 'todayTimestamps', 'weekData']);
  const today = new Date().toISOString().split('T')[0];

  if (!stored.todayDate || stored.todayDate === today) return;

  // Day changed — archive yesterday's data
  const timestamps = stored.todayTimestamps || [];
  if (timestamps.length > 0) {
    const weekData = stored.weekData || getEmptyWeekData();

    // Check if week rolled over
    const currentMonday = getMonday(new Date()).toISOString();
    if (weekData.weekStart !== currentMonday) {
      const newWeek = getEmptyWeekData();
      await chrome.storage.local.set({ weekData: newWeek, todayTimestamps: [], todayDate: today });
      return;
    }

    // Archive into the correct day slot
    const d = new Date(stored.todayDate);
    const dayIndex = d.getDay() - 1; // 0=Mon..4=Fri

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

// Same calculation logic as popup.js
function calculateFromTimestamps(timestamps) {
  let officeMs = 0;
  let breakMs = 0;

  if (timestamps.length === 0) return { officeMs: 0, breakMs: 0 };

  const pairs = [];
  for (let i = 0; i < timestamps.length; i += 2) {
    const inTime = timestamps[i];
    const outTime = (i + 1 < timestamps.length) ? timestamps[i + 1] : inTime; // closed pair for archive
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
