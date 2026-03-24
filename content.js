// Content script - runs on zingnext.zinghr.com
// Scrapes punch-in/out times and "Spent Today" from the portal

(function () {
  'use strict';

  const SCRAPE_INTERVAL = 30000; // scrape every 30 seconds
  let lastData = null;

  function scrapePortalData() {
    const data = {
      spentToday: null,
      lastSwipe: null,
      punchStatus: null, // 'in' or 'out'
      punchInTime: null,
      punchOutTime: null,
      scrapedAt: Date.now(),
      date: new Date().toISOString().split('T')[0]
    };

    try {
      // --- Scrape "Spent Today" ---
      // Look for the spent today time display (format: HH:MM or --:--)
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent.trim();

        // Find "Spent Today" label and get the time value near it
        if (text === 'Spent Today' || text === 'SpentToday') {
          // The time is usually in a sibling or parent element
          const parent = el.closest('div') || el.parentElement;
          if (parent) {
            const timeMatch = parent.textContent.match(/(\d{1,2}:\d{2})/);
            if (timeMatch) {
              data.spentToday = timeMatch[1];
            }
          }
        }
      }

      // Broader search for Spent Today pattern
      if (!data.spentToday) {
        const bodyText = document.body.innerText;
        const spentMatch = bodyText.match(/Spent\s*Today[\s\S]*?(\d{1,2}:\d{2})/i);
        if (spentMatch) {
          data.spentToday = spentMatch[1];
        }
      }

      // --- Scrape "Last Swipe" ---
      for (const el of allElements) {
        const text = el.textContent.trim();
        if (text.includes('Last Swipe')) {
          const parent = el.closest('div') || el.parentElement;
          if (parent) {
            const fullText = parent.textContent;
            // Match time like "10:30 AM" or "14:30" or "No swipe"
            const timeMatch = fullText.match(/Last\s*Swipe\s*:\s*([\w\d:.\s]+)/i);
            if (timeMatch) {
              data.lastSwipe = timeMatch[1].trim();
            }
          }
        }
      }

      // --- Scrape Punch In / Punch Out status ---
      const punchButtons = document.querySelectorAll('button, [role="button"], a');
      for (const btn of punchButtons) {
        const btnText = btn.textContent.trim().toLowerCase();
        if (btnText.includes('punch in')) {
          data.punchStatus = 'out'; // Button says "Punch In" means user is currently punched OUT
        } else if (btnText.includes('punch out')) {
          data.punchStatus = 'in'; // Button says "Punch Out" means user is currently punched IN
        }
      }

      // Also check for punch status in broader context
      if (!data.punchStatus) {
        const bodyText = document.body.innerText;
        if (/Punch\s*Out/i.test(bodyText)) {
          data.punchStatus = 'in';
        } else if (/Punch\s*In/i.test(bodyText)) {
          data.punchStatus = 'out';
        }
      }

      // --- Try to scrape swipe/attendance log for punch times ---
      // Look for time entries in attendance section
      const timeCells = document.querySelectorAll('td, span, div');
      const punchTimes = [];
      for (const cell of timeCells) {
        const text = cell.textContent.trim();
        // Match standard time formats like "09:30 AM", "09:30", "9:30"
        if (/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(text)) {
          const parent = cell.closest('tr, .swipe, .punch, .attendance');
          if (parent) {
            punchTimes.push(text);
          }
        }
      }

      if (punchTimes.length > 0) {
        data.punchInTime = punchTimes[0]; // First punch is punch-in
        if (punchTimes.length > 1) {
          data.punchOutTime = punchTimes[punchTimes.length - 1]; // Last punch is punch-out
        }
      }

    } catch (err) {
      console.error('[ZingTrack] Scrape error:', err);
    }

    return data;
  }

  function sendData(data) {
    // Only send if data changed
    const dataStr = JSON.stringify(data);
    if (dataStr === lastData) return;
    lastData = dataStr;

    chrome.storage.local.set({ portalData: data }, () => {
      console.log('[ZingTrack] Portal data saved:', data);
    });

    // Also send message for any open popup
    chrome.runtime.sendMessage({ type: 'PORTAL_DATA', data }).catch(() => {});
  }

  function run() {
    const data = scrapePortalData();
    sendData(data);
  }

  // Initial scrape after page settles
  setTimeout(run, 3000);

  // Periodic scrape
  setInterval(run, SCRAPE_INTERVAL);

  // Also scrape on visibility change (user switches back to tab)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(run, 1000);
    }
  });

  // Watch for DOM changes (SPA updates)
  const observer = new MutationObserver(() => {
    clearTimeout(observer._debounce);
    observer._debounce = setTimeout(run, 2000);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  console.log('[ZingTrack] Content script loaded - monitoring Zing portal');
})();
