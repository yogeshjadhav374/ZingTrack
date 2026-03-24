// Content script - runs on zingnext.zinghr.com
// Scrapes: Raw Swipes from calendar tooltip, Spent Today, Punch status

(function () {
  'use strict';

  const SCRAPE_INTERVAL = 30000;

  function isExtensionValid() {
    try { return !!chrome.runtime.id; } catch (e) { return false; }
  }

  // ── Inject script into page's MAIN world to trigger React hover events ──
  function injectPageScript(code) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.textContent = code;
      document.documentElement.appendChild(script);
      script.remove();
      // Give React time to process
      setTimeout(resolve, 100);
    });
  }

  // ── Trigger tooltip via injected page-context script ──
  async function triggerTooltipInPageContext() {
    const today = new Date().getDate();

    // This code runs in the PAGE's world, not the content script's isolated world
    // So React event handlers will actually fire
    const injectedCode = `
    (function() {
      var today = ${today};

      // Strategy 1: Find MUI calendar day button
      var btns = document.querySelectorAll(
        'button.MuiPickersDay-day, button.MuiButtonBase-root.MuiIconButton-root'
      );
      var todayBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var p = btns[i].querySelector('p, span');
        var txt = p ? p.textContent.trim() : btns[i].textContent.trim();
        if (txt === String(today)) {
          todayBtn = btns[i];
          break;
        }
      }

      // Strategy 2: Find by selectedDate class or MuiPickersDay-current
      if (!todayBtn) {
        var selected = document.querySelector('.selectedDate button, .MuiPickersDay-daySelected');
        if (selected) todayBtn = selected;
      }

      // Strategy 3: Generic - find any small element with just today's number near calendar context
      if (!todayBtn) {
        var allEls = document.querySelectorAll('td, div, span, a, button');
        for (var j = 0; j < allEls.length; j++) {
          var el = allEls[j];
          if (el.textContent.trim() !== String(today)) continue;
          if (el.children.length > 2 || el.textContent.length > 4) continue;
          var par = el.closest('[class*="calendar"], [class*="attend"], [role="presentation"]');
          if (par) { todayBtn = el; break; }
        }
      }

      if (!todayBtn) {
        window.__zingTrackTooltipResult = { error: 'Could not find today element (' + today + ')' };
        return;
      }

      // Get element position for realistic mouse events
      var rect = todayBtn.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;

      // Also try the parent wrapper (div[role="presentation"] or parent div)
      var wrapper = todayBtn.closest('[role="presentation"]') || todayBtn.parentElement;
      var wrapperRect = wrapper ? wrapper.getBoundingClientRect() : rect;
      var wcx = wrapperRect.left + wrapperRect.width / 2;
      var wcy = wrapperRect.top + wrapperRect.height / 2;

      var evtOpts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: cx,
        clientY: cy,
        screenX: cx,
        screenY: cy
      };

      var wEvtOpts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: wcx,
        clientY: wcy,
        screenX: wcx,
        screenY: wcy
      };

      // Dispatch on the button itself
      ['pointerenter', 'pointerover', 'mouseenter', 'mouseover', 'mousemove'].forEach(function(evtName) {
        todayBtn.dispatchEvent(new PointerEvent(evtName, evtOpts));
      });

      // Also dispatch on wrapper
      if (wrapper && wrapper !== todayBtn) {
        ['pointerenter', 'pointerover', 'mouseenter', 'mouseover', 'mousemove'].forEach(function(evtName) {
          wrapper.dispatchEvent(new PointerEvent(evtName, wEvtOpts));
        });
      }

      // Also try clicking the button (some implementations show tooltip on click)
      // todayBtn.click(); // commented out - may navigate

      window.__zingTrackTooltipResult = {
        triggered: true,
        element: todayBtn.tagName + '.' + todayBtn.className.substring(0, 80),
        wrapper: wrapper ? wrapper.tagName + '.' + (wrapper.className || '').substring(0, 80) : null,
        position: { x: cx, y: cy }
      };
    })();
    `;

    await injectPageScript(injectedCode);
  }

  // ── Close tooltip via injected page-context script ──
  async function closeTooltipInPageContext() {
    const today = new Date().getDate();
    const injectedCode = `
    (function() {
      var today = ${today};
      var btns = document.querySelectorAll(
        'button.MuiPickersDay-day, button.MuiButtonBase-root.MuiIconButton-root'
      );
      var todayBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var p = btns[i].querySelector('p, span');
        var txt = p ? p.textContent.trim() : btns[i].textContent.trim();
        if (txt === String(today)) { todayBtn = btns[i]; break; }
      }
      if (!todayBtn) {
        var selected = document.querySelector('.selectedDate button, .MuiPickersDay-daySelected');
        if (selected) todayBtn = selected;
      }
      if (!todayBtn) return;

      var rect = todayBtn.getBoundingClientRect();
      var evtOpts = {
        bubbles: true, cancelable: true, view: window,
        clientX: rect.left - 100, clientY: rect.top - 100
      };
      ['pointerleave', 'pointerout', 'mouseleave', 'mouseout'].forEach(function(evtName) {
        todayBtn.dispatchEvent(new PointerEvent(evtName, evtOpts));
      });
      var wrapper = todayBtn.closest('[role="presentation"]') || todayBtn.parentElement;
      if (wrapper && wrapper !== todayBtn) {
        ['pointerleave', 'pointerout', 'mouseleave', 'mouseout'].forEach(function(evtName) {
          wrapper.dispatchEvent(new PointerEvent(evtName, evtOpts));
        });
      }
    })();
    `;
    await injectPageScript(injectedCode);
  }

  // ── Main scrape ──
  async function scrapePortalData() {
    const data = {
      spentToday: null,
      lastSwipe: null,
      punchStatus: null,
      swipeTimes: [],
      shift: null,
      actual: null,
      hours: null,
      deficit: null,
      rawSwipes: null,
      scrapedAt: Date.now(),
      date: new Date().toISOString().split('T')[0],
      debug: {}
    };

    try {
      const bodyText = document.body.innerText;

      // ── Spent Today ──
      const spentPatterns = [
        /(\d{1,2}\s*:\s*\d{2})\s*\n?\s*Spent\s*Today/i,
        /Spent\s*Today[\s\S]{0,50}?(\d{1,2}\s*:\s*\d{2})/i
      ];
      for (const pat of spentPatterns) {
        const m = bodyText.match(pat);
        if (m) { data.spentToday = m[1].replace(/\s/g, ''); break; }
      }

      // ── Last Swipe ──
      const lsMatch = bodyText.match(/Last\s*Swipe\s*:?\s*(.+?)(?:\n|Current|$)/i);
      if (lsMatch) data.lastSwipe = lsMatch[1].trim().substring(0, 30);

      // ── Punch Status ──
      const allEls = document.querySelectorAll('button, [role="button"], a, div, span');
      for (const el of allEls) {
        const text = el.textContent.trim();
        if (text.length > 20) continue;
        if (/^Punch\s*Out/i.test(text)) { data.punchStatus = 'in'; break; }
        else if (/^Punch\s*In/i.test(text)) { data.punchStatus = 'out'; break; }
      }

      // ── Trigger tooltip on today's calendar date (in page context) ──
      await triggerTooltipInPageContext();

      // Wait for tooltip to render
      await sleep(2500);

      // Read the result from the injected script
      const resultCode = `
      (function() {
        var el = document.createElement('div');
        el.id = '__zingTrackResult';
        el.style.display = 'none';
        el.textContent = JSON.stringify(window.__zingTrackTooltipResult || {});
        document.body.appendChild(el);
      })();
      `;
      await injectPageScript(resultCode);

      const resultEl = document.getElementById('__zingTrackResult');
      if (resultEl) {
        try {
          const triggerResult = JSON.parse(resultEl.textContent);
          data.debug.triggerResult = triggerResult;
        } catch (e) {}
        resultEl.remove();
      }

      // Now scrape tooltip content from the DOM
      // Look for tooltip/popover elements that appeared
      const tooltipSelectors = [
        '[role="tooltip"]',
        '.MuiTooltip-tooltip',
        '.MuiTooltip-popper',
        '.MuiPopover-root',
        '.MuiPopover-paper',
        '.MuiPopper-root',
        '[class*="tooltip"]',
        '[class*="Tooltip"]',
        '[class*="popover"]',
        '[class*="Popover"]',
        '[class*="popup"]'
      ];

      let tooltipText = '';
      for (const sel of tooltipSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const txt = el.innerText || el.textContent || '';
          if (txt.length > 5 && /raw\s*swipe|shift|actual|hours|deficit/i.test(txt)) {
            tooltipText = txt;
            data.debug.tooltipSelector = sel;
            data.debug.tooltipElement = el.tagName + '.' + (el.className || '').substring(0, 60);
            break;
          }
        }
        if (tooltipText) break;
      }

      // Fallback: search the entire body text for tooltip content
      if (!tooltipText) {
        tooltipText = document.body.innerText;
        data.debug.tooltipSelector = 'body (fallback)';
      }

      // Also look for any newly-appeared elements (tooltip might be a div that just showed up)
      if (!tooltipText || !/raw\s*swipe/i.test(tooltipText)) {
        // Search all visible elements for tooltip-like content
        const allVisible = document.querySelectorAll('div, span, p, td, th, li');
        for (const el of allVisible) {
          if (el.offsetParent === null && el.style.display !== 'contents') continue; // hidden
          const txt = el.innerText || '';
          if (/Raw\s*Swipes?\s*:?\s*\d/i.test(txt) && txt.length < 500) {
            tooltipText = txt;
            data.debug.tooltipSelector = 'visible element scan';
            data.debug.tooltipElement = el.tagName + '.' + (el.className || '').substring(0, 60);
            break;
          }
        }
      }

      // ── Extract fields from tooltip text ──
      const rawSwipesMatch = tooltipText.match(/Raw\s*Swipes?\s*:?\s*(.+?)(?:\n|$)/i);
      if (rawSwipesMatch) {
        const rawVal = rawSwipesMatch[1].trim();
        data.rawSwipes = rawVal;
        if (rawVal && rawVal.toLowerCase() !== 'none' && rawVal !== '--') {
          const times = rawVal.split(/[,;]+/).map(t => t.trim()).filter(Boolean);
          data.swipeTimes = times;
        }
      }

      const shiftMatch = tooltipText.match(/Shift\s*:?\s*(.+?)(?:\n|$)/i);
      if (shiftMatch) data.shift = shiftMatch[1].trim();

      const actualMatch = tooltipText.match(/Actual\s*:?\s*(.+?)(?:\n|$)/i);
      if (actualMatch) data.actual = actualMatch[1].trim();

      const hoursMatch = tooltipText.match(/Hours\s*:?\s*(.+?)(?:\n|$)/i);
      if (hoursMatch) data.hours = hoursMatch[1].trim();

      const deficitMatch = tooltipText.match(/Deficit\s*:?\s*(.+?)(?:\n|$)/i);
      if (deficitMatch) data.deficit = deficitMatch[1].trim();

      data.debug.calendarTooltip = 'Scraped. Raw Swipes: ' + (data.rawSwipes || 'not found');

      // Debug: capture all visible text fragments containing "swipe" or time patterns near calendar
      data.debug.swipeRelated = [];
      document.querySelectorAll('*').forEach(el => {
        const t = (el.innerText || '').trim();
        if (t.length > 3 && t.length < 200 && /swipe/i.test(t)) {
          data.debug.swipeRelated.push(el.tagName + ': ' + t.substring(0, 100));
        }
      });
      data.debug.swipeRelated = data.debug.swipeRelated.slice(0, 10);

      // Close the tooltip
      await closeTooltipInPageContext();

      // Debug: all times found on page
      data.debug.allTimesFound = [...new Set(document.body.innerText.match(/\d{1,2}:\d{2}(?:\s*(?:AM|PM|am|pm))?/gi) || [])].slice(0, 20);

    } catch (err) {
      console.error('[ZingTrack] Scrape error:', err);
      data.debug.error = err.message;
    }

    return data;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Save & Notify ──
  let lastDataStr = null;

  function saveAndNotify(data) {
    if (!isExtensionValid()) { cleanup(); return; }

    const dataStr = JSON.stringify(data);
    if (dataStr === lastDataStr) return;
    lastDataStr = dataStr;

    try {
      chrome.storage.local.set({ portalData: data }, () => {
        if (chrome.runtime.lastError) return;
        console.log('[ZingTrack] Saved:', data);
      });
      chrome.runtime.sendMessage({ type: 'PORTAL_DATA', data }).catch(() => {});
    } catch (e) {
      cleanup();
    }
  }

  async function run() {
    if (!isExtensionValid()) { cleanup(); return; }
    const data = await scrapePortalData();
    saveAndNotify(data);
  }

  // ── Message listener ──
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'FORCE_SCRAPE') {
        lastDataStr = null;
        run();
        sendResponse({ ok: true });
      }
      return true;
    });
  } catch (e) {}

  // ── Startup ──
  const t1 = setTimeout(run, 3000);
  const t2 = setTimeout(run, 8000);

  const interval = setInterval(() => {
    if (!isExtensionValid()) { cleanup(); return; }
    run();
  }, SCRAPE_INTERVAL);

  function onVisChange() {
    if (!document.hidden && isExtensionValid()) setTimeout(run, 1000);
  }
  document.addEventListener('visibilitychange', onVisChange);

  function cleanup() {
    clearTimeout(t1);
    clearTimeout(t2);
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisChange);
    console.log('[ZingTrack] Content script stopped');
  }

  console.log('[ZingTrack] Content script loaded on Zing portal');
})();
