const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

// How many results-page fetches / listing-detail tabs to run at once. Higher
// = faster, but more load on Rightmove at once. These are plain requests
// from the user's own browser session (not a separate bot), so a modest
// pool is a reasonable balance.
const PAGE_FETCH_CONCURRENCY = 10;
const DETAIL_SCRAPE_CONCURRENCY = 4; // default/fallback - overridable per-run from the popup

const OPEN_WINDOWS_KEY = 'rmScraperOpenWindows';
const SAVED_ROWS_KEY = 'rmScraperSavedRows';

let state = makeIdleState();

function makeIdleState() {
  return {
    running: false,
    phase: 'idle',
    scraped: 0,
    total: 0,
    resultCount: 0,
    channel: '',
    note: '',
    rows: [],
    log: [],
  };
}

let persistTimer = null;
function schedulePersistRows() {
  if (persistTimer || !state.rows.length) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.local
      .set({ [SAVED_ROWS_KEY]: { rows: state.rows, channel: state.channel, resultCount: state.resultCount } })
      .catch(() => {});
  }, 2000);
}

function broadcast() {
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
  schedulePersistRows();
}

// If a previous run's service worker got killed mid-scrape - which Chrome
// will do under enough memory/CPU pressure, which opening several real
// browser windows at once can itself cause - any hidden windows it had open
// never got closed, and whatever had been scraped so far was only ever in
// memory and is gone. Left alone, orphaned windows accumulate across
// restarts and make Chrome increasingly unstable each time. On every service
// worker startup: close anything left over, and recover whatever rows were
// last saved so a crash doesn't mean losing the whole scrape.
async function cleanupOrphanedWindows() {
  try {
    const stored = await chrome.storage.local.get(OPEN_WINDOWS_KEY);
    const ids = stored[OPEN_WINDOWS_KEY];
    if (ids && ids.length) {
      await Promise.all(ids.map((id) => chrome.windows.remove(id).catch(() => {})));
    }
  } catch (e) {
    // ignore
  } finally {
    await chrome.storage.local.remove(OPEN_WINDOWS_KEY).catch(() => {});
  }
}

async function restoreSavedRows() {
  try {
    const stored = await chrome.storage.local.get(SAVED_ROWS_KEY);
    const saved = stored[SAVED_ROWS_KEY];
    if (saved && saved.rows && saved.rows.length) {
      state.rows = saved.rows;
      state.channel = saved.channel || '';
      state.resultCount = saved.resultCount || 0;
      state.phase = 'done';
      state.note = "Recovered from a previous run that didn't finish cleanly - showing what was scraped before it stopped.";
    }
  } catch (e) {
    // ignore
  }
}

cleanupOrphanedWindows();
restoreSavedRows();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs `worker(i)` for i in [0, count) using up to `concurrency` runners at
// once, stopping early if state.running is flipped off (Stop button).
async function runPool(count, concurrency, worker) {
  let next = 0;
  async function runner() {
    while (state.running) {
      const i = next++;
      if (i >= count) return;
      await worker(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, runner));
}

// Straight-line ("as the crow flies") distance in km - not a driving or
// walking distance, which would need a routing API rather than just two
// coordinates.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Free, no-API-key UK postcode lookup - resolves a postcode straight to
// coordinates so listings can be compared against a reference location
// (e.g. an office) without needing a full geocoding service.
async function geocodePostcode(postcode) {
  const clean = (postcode || '').trim().replace(/\s+/g, '');
  if (!clean) return null;
  const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
  const data = await res.json();
  if (!res.ok || !data.result) throw new Error(`postcode "${postcode}" not found`);
  return { latitude: data.result.latitude, longitude: data.result.longitude };
}

function normalizeProperty(p, refCoords) {
  const priceInfo = (p.price && p.price.displayPrices && p.price.displayPrices[0]) || {};
  const displayPrice = priceInfo.displayPrice || '';
  // Rightmove's "amount" field still holds a placeholder number even when
  // the price is undisclosed (POA / "Price on Application" etc, where
  // displayPrice is text, not a figure) - using that placeholder as a real
  // price would silently corrupt price-per-bedroom/bathroom/sqft maths, so
  // treat it as blank and surface the actual text in priceQualifier instead.
  const priceLooksNumeric = /\d/.test(displayPrice);
  const price = priceLooksNumeric && p.price ? p.price.amount : '';
  const priceQualifier = priceLooksNumeric ? priceInfo.displayPriceQualifier || '' : displayPrice;

  let distanceKm = '';
  if (refCoords && p.location && typeof p.location.latitude === 'number') {
    distanceKm = haversineKm(
      refCoords.latitude,
      refCoords.longitude,
      p.location.latitude,
      p.location.longitude
    ).toFixed(1);
  }
  return {
    address: p.displayAddress || '',
    distanceKm,
    price,
    priceQualifier,
    bedrooms: p.bedrooms ?? '',
    bathrooms: p.bathrooms ?? '',
    propertyType: p.propertySubType || '',
    tenure: (p.tenure && p.tenure.tenureType) || '',
    size: p.displaySize || '',
    councilTaxBand: '',
    epcRating: '',
    groundRent: '',
    serviceCharge: '',
    letAvailableDate: p.letAvailableDate || '',
    agent: (p.customer && (p.customer.branchDisplayName || p.customer.companyName)) || '',
    firstVisibleDate: p.firstVisibleDate || '',
    url: p.propertyUrl ? 'https://www.rightmove.co.uk' + p.propertyUrl.split('#')[0] : '',
  };
}

function parseNextDataFromHtml(html) {
  const m = html.match(NEXT_DATA_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return null;
  }
}

async function fetchSearchResultsAtIndex(baseUrl, index) {
  const u = new URL(baseUrl);
  u.searchParams.set('index', String(index));
  const res = await fetch(u.toString(), { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const data = parseNextDataFromHtml(html);
  return data?.props?.pageProps?.searchResults || null;
}

async function scrapeAllPages(firstSearchResults, pageUrl, refCoords) {
  const byId = new Map();
  const addAll = (sr) => {
    for (const p of sr.properties || []) {
      if (!byId.has(p.id)) byId.set(p.id, normalizeProperty(p, refCoords));
    }
  };
  addAll(firstSearchResults);

  const options = (firstSearchResults.pagination && firstSearchResults.pagination.options) || [];
  const currentIndex = Number((firstSearchResults.searchParameters && firstSearchResults.searchParameters.index) || 0);
  const remaining = options.filter((o) => Number(o.value) !== currentIndex);

  state.channel = (firstSearchResults.searchParameters && firstSearchResults.searchParameters.channel) || '';
  state.resultCount = firstSearchResults.resultCount || 0;
  state.total = options.length || 1;
  state.scraped = 1;
  state.rows = Array.from(byId.values());
  broadcast();

  await runPool(remaining.length, PAGE_FETCH_CONCURRENCY, async (i) => {
    const idx = Number(remaining[i].value);
    try {
      const sr = await fetchSearchResultsAtIndex(pageUrl, idx);
      if (sr) addAll(sr);
    } catch (e) {
      state.log.push(`Results page index ${idx} failed: ${e.message}`);
    }
    state.scraped++;
    state.rows = Array.from(byId.values());
    broadcast();
  });

  if (state.resultCount > state.rows.length + 5) {
    state.note =
      `Rightmove reports ${state.resultCount.toLocaleString()} total matches, but only exposes ` +
      `${state.rows.length.toLocaleString()} through pagination (its ~1,000-result cap). Narrow the ` +
      `search below ~1,000 matches to get everything.`;
  }
}

// ---- Deep scrape: visit each listing's own page for fields that only exist there ----
// (council tax band, EPC rating, ground rent, service charge).
// These render client-side after the page's own JS runs, so we open the real
// listing in hidden, minimized windows and read the live DOM instead of just
// fetching HTML. NOTE: the label-text regexes below are a best-effort scan of
// the rendered page text - they're the part most likely to need adjustment if
// Rightmove changes their detail-page layout. If they stop matching, send an
// example of the "Tenure" / "Material information" section HTML from a live
// listing and the selectors here can be tightened.
//
// This deliberately waits for the whole page to finish loading (rather than
// racing ahead once the fields we want appear) and blocks nothing. That's
// slower, but a leaner/faster version of this (skip-ahead polling + blocking
// images/fonts/stylesheets) turned out to overwhelm Chrome even at low
// concurrency - this is the version that held up reliably.
function extractDetailFieldsInPage() {
  const getText = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.trim() : '';
  };

  const size = getText('[data-testid="info-reel-SIZE-text"]');

  let tenure = '';
  const tenureBtn = document.querySelector('[data-testid="info-reel-tenure-button"]');
  if (tenureBtn) {
    const aria = tenureBtn.getAttribute('aria-label') || '';
    const m = aria.match(/tenure\s+([A-Za-z]+)/i);
    tenure = m ? m[1] : getText('[data-testid="info-reel-tenure-button"] p');
  }

  const bodyText = document.body.innerText || '';
  const grab = (re) => {
    const m = bodyText.match(re);
    return m ? (m[1] || '').trim() : '';
  };

  return {
    size,
    tenure,
    councilTaxBand: grab(/Council [Tt]ax[^\n]{0,20}?Band\s*([A-H])\b/),
    epcRating: grab(/EPC [Rr]ating[:\s]*([A-G])\b/),
    groundRent: grab(/Ground [Rr]ent[:\s]*£?([\d,]+(?:\.\d+)?(?:\s*per\s*\w+)?)/),
    serviceCharge: grab(/Service [Cc]harge[:\s]*£?([\d,]+(?:\.\d+)?(?:\s*per\s*\w+)?)/),
  };
}

// Must be called BEFORE chrome.tabs.update() triggers the navigation, not
// after - otherwise a fast-loading page can reach 'complete' before this
// listener is even attached, and we'd sit waiting for an event that already
// happened until the timeout fires (a false "timeout" on a page that
// actually loaded fine).
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for page load'));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    }
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Returns true if the tab is still usable, false if it's gone and the
// caller needs a replacement (e.g. Chrome closed it under memory pressure,
// or a previous crash-recovery pass closed it out from under an in-flight
// runner). Any other failure (bad load, timeout) just fails this one
// listing without condemning the tab itself.
async function scrapeOneDetail(tabId, row, attempt = 1) {
  if (!row.url) return true;
  try {
    const loaded = waitForTabComplete(tabId, 25000);
    await chrome.tabs.update(tabId, { url: row.url });
    try {
      await loaded;
    } catch (e) {
      // Didn't see a 'complete' event in time (e.g. some background
      // connection keeps the tab technically "loading" forever). The
      // fields we want have usually rendered by now regardless, so try
      // extracting anyway instead of throwing the row away.
    }
    await sleep(300);

    // The tab can end up somewhere we're not allowed to read - a blank
    // page if navigation never really started, a browser error page from
    // a failed load, or occasionally a bot-check/interstitial page - none
    // of which are covered by host_permissions. That's usually transient,
    // so retry the listing once before giving up on it.
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !tab.url.startsWith('https://www.rightmove.co.uk/')) {
      throw new Error(`page didn't load properly (ended up at ${tab.url || 'a blank page'})`);
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractDetailFieldsInPage,
    });
    const result = results && results[0] && results[0].result;
    if (result) {
      if (result.size && result.size.toLowerCase() !== 'ask agent') {
        row.size = row.size || result.size;
      }
      if (result.tenure) row.tenure = row.tenure || result.tenure;
      row.councilTaxBand = result.councilTaxBand;
      row.epcRating = result.epcRating;
      row.groundRent = result.groundRent;
      row.serviceCharge = result.serviceCharge;
    }
    return true;
  } catch (e) {
    const tabGone = /No tab with id/i.test(e.message);
    if (!tabGone && attempt < 2 && state.running) {
      await sleep(800);
      return scrapeOneDetail(tabId, row, attempt + 1);
    }
    state.log.push(`Detail fetch failed for ${row.url}: ${e.message}`);
    return !tabGone;
  }
}

async function createPoolWindow() {
  const win = await chrome.windows.create({
    url: 'about:blank',
    focused: false,
    state: 'minimized',
    type: 'popup',
  });
  return { windowId: win.id, tabId: win.tabs[0].id };
}

async function deepScrapeAll(requestedConcurrency) {
  state.phase = 'details';
  state.total = state.rows.length;
  state.scraped = 0;
  broadcast();

  const concurrency = Math.max(1, Math.min(requestedConcurrency || DETAIL_SCRAPE_CONCURRENCY, state.rows.length || 1));
  const pool = [];

  async function saveOpenWindows() {
    await chrome.storage.local.set({ [OPEN_WINDOWS_KEY]: pool.map((p) => p.windowId) }).catch(() => {});
  }

  try {
    // Window creation itself is what tends to choke an overloaded Chrome. If
    // it fails partway through (or the user hits Stop while we're still
    // opening windows), everything already created must still be cleaned up
    // below - otherwise a failed high-concurrency attempt leaks windows that
    // never close, making the next attempt even more likely to choke. Window
    // IDs are saved to storage as they're created (not just held in memory)
    // so that even if the service worker itself gets killed before reaching
    // the cleanup below, the next startup can still find and close them.
    for (let i = 0; i < concurrency && state.running; i++) {
      pool.push(await createPoolWindow());
      await saveOpenWindows();
    }

    let next = 0;
    async function runner(entry) {
      while (state.running) {
        const i = next++;
        if (i >= state.rows.length) return;
        const tabOk = await scrapeOneDetail(entry.tabId, state.rows[i]);
        if (!tabOk && state.running) {
          // The tab this runner was using is gone - replace it rather than
          // let every remaining listing on this runner fail the same way.
          try {
            const fresh = await createPoolWindow();
            entry.windowId = fresh.windowId;
            entry.tabId = fresh.tabId;
            await saveOpenWindows();
          } catch (e) {
            state.log.push(`Could not open a replacement window: ${e.message}`);
          }
        }
        state.scraped++;
        broadcast();
        await sleep(300 + Math.random() * 300);
      }
    }
    await Promise.all(pool.map((p) => runner(p)));
  } catch (e) {
    state.log.push(`Deep scrape stopped early: ${e.message}`);
  } finally {
    await Promise.all(pool.map((p) => chrome.windows.remove(p.windowId).catch(() => {})));
    await chrome.storage.local.remove(OPEN_WINDOWS_KEY).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_SCRAPE') {
    (async () => {
      state = makeIdleState();
      state.running = true;
      state.phase = 'pages';
      broadcast();
      await chrome.storage.local.remove(SAVED_ROWS_KEY).catch(() => {});

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/^https:\/\/www\.rightmove\.co\.uk\/.*find\.html/.test(tab.url || '')) {
        state.running = false;
        state.phase = 'idle';
        state.log.push('Switch to a Rightmove search results tab first.');
        broadcast();
        return;
      }

      let resp;
      try {
        resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SEARCH_RESULTS' });
      } catch (e) {
        resp = null;
      }
      if (!resp || !resp.searchResults) {
        state.running = false;
        state.phase = 'idle';
        state.log.push('Could not read search results on this tab. Reload the page and try again.');
        broadcast();
        return;
      }

      let refCoords = null;
      if (msg.referencePostcode) {
        try {
          refCoords = await geocodePostcode(msg.referencePostcode);
        } catch (e) {
          state.log.push(`Distance column skipped: ${e.message}`);
        }
      }

      // The tab's own __NEXT_DATA__ is a snapshot from whenever the page last
      // fully loaded - if filters/sort changed since then via Rightmove's
      // client-side routing, the on-screen count moves on but this embedded
      // copy doesn't, so its result count and listings can be stale. Refetch
      // page 0 fresh over the network (same as every later page) so the
      // whole scrape is built from one consistent, up-to-date source. Fall
      // back to the tab's snapshot only if that refetch itself fails.
      let firstSearchResults;
      try {
        firstSearchResults = await fetchSearchResultsAtIndex(resp.url, 0);
      } catch (e) {
        firstSearchResults = null;
      }
      if (!firstSearchResults) {
        firstSearchResults = resp.searchResults;
        state.log.push('Could not refresh results from the network - falling back to the page\'s own data, which may be stale if filters changed since it last fully loaded.');
      }

      await scrapeAllPages(firstSearchResults, resp.url, refCoords);

      if (msg.deep && state.running) {
        await deepScrapeAll(msg.detailConcurrency);
      }

      state.running = false;
      state.phase = 'done';
      broadcast();
    })();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'STOP_SCRAPE') {
    state.running = false;
    broadcast();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_STATE') {
    sendResponse({ state });
    return true;
  }
});
