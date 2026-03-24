// Content script - runs on zingnext.zinghr.com
// Lightweight: just scrapes basic page info (punch status, spent today)
// Main data fetching is done via GetTimeCard API in background.js

(function () {
  'use strict';

  function isExtensionValid() {
    try { return !!chrome.runtime.id; } catch (e) { return false; }
  }

  function scrapeBasicInfo() {
    const data = {
      spentToday: null,
      lastSwipe: null,
      punchStatus: null,
      scrapedAt: Date.now(),
      date: new Date().toISOString().split('T')[0]
    };

    try {
      const bodyText = document.body.innerText;

      // Spent Today
      const spentPatterns = [
        /(\d{1,2}\s*:\s*\d{2})\s*\n?\s*Spent\s*Today/i,
        /Spent\s*Today[\s\S]{0,50}?(\d{1,2}\s*:\s*\d{2})/i
      ];
      for (const pat of spentPatterns) {
        const m = bodyText.match(pat);
        if (m) { data.spentToday = m[1].replace(/\s/g, ''); break; }
      }

      // Last Swipe
      const lsMatch = bodyText.match(/Last\s*Swipe\s*:?\s*(.+?)(?:\n|Current|$)/i);
      if (lsMatch) data.lastSwipe = lsMatch[1].trim().substring(0, 30);

      // Punch Status
      const allEls = document.querySelectorAll('button, [role="button"], a, div, span');
      for (const el of allEls) {
        const text = el.textContent.trim();
        if (text.length > 20) continue;
        if (/^Punch\s*Out/i.test(text)) { data.punchStatus = 'in'; break; }
        else if (/^Punch\s*In/i.test(text)) { data.punchStatus = 'out'; break; }
      }
    } catch (err) {
      console.error('[ZingTrack] Scrape error:', err);
    }

    return data;
  }

  function saveAndNotify(data) {
    if (!isExtensionValid()) { cleanup(); return; }
    try {
      // Only update basic fields, don't overwrite API data
      chrome.storage.local.get(['portalData'], (stored) => {
        const existing = stored.portalData || {};
        const merged = {
          ...existing,
          spentToday: data.spentToday || existing.spentToday,
          lastSwipe: data.lastSwipe || existing.lastSwipe,
          punchStatus: data.punchStatus || existing.punchStatus,
          scrapedAt: data.scrapedAt
        };
        chrome.storage.local.set({ portalData: merged });
      });
    } catch (e) {
      cleanup();
    }
  }

  function run() {
    if (!isExtensionValid()) { cleanup(); return; }
    const data = scrapeBasicInfo();
    saveAndNotify(data);
  }

  // Message listener
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'FORCE_SCRAPE') {
        run();
        sendResponse({ ok: true });
      }
      return true;
    });
  } catch (e) {}

  // Startup
  const t1 = setTimeout(run, 3000);
  const interval = setInterval(() => {
    if (!isExtensionValid()) { cleanup(); return; }
    run();
  }, 60000); // Every 60s for basic info

  function onVisChange() {
    if (!document.hidden && isExtensionValid()) setTimeout(run, 1000);
  }
  document.addEventListener('visibilitychange', onVisChange);

  function cleanup() {
    clearTimeout(t1);
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisChange);
    console.log('[ZingTrack] Content script stopped');
  }

  console.log('[ZingTrack] Content script loaded (lightweight mode)');
})();
