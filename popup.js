const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const downloadBtn = document.getElementById('downloadBtn');
const openTopBtn = document.getElementById('openTopBtn');
const deepToggle = document.getElementById('deepToggle');
const deepToggleLabel = document.querySelector('.deep-toggle');
const concurrencyInput = document.getElementById('concurrencyInput');
const concurrencyRow = document.querySelector('.concurrency-row');
const refPostcodeInput = document.getElementById('refPostcode');
const refLocationRow = document.querySelector('.ref-location');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const noteEl = document.getElementById('note');
const logEl = document.getElementById('log');
const topMatchesEl = document.getElementById('topMatches');
const rankListEl = document.getElementById('rankList');

let lastState = null;

function render(state) {
  if (!state) return;
  lastState = state;

  startBtn.disabled = state.running;
  stopBtn.disabled = !state.running;
  downloadBtn.disabled = state.running || state.rows.length === 0;
  openTopBtn.disabled = state.running || state.rows.length === 0;
  deepToggle.disabled = state.running;
  deepToggleLabel.classList.toggle('disabled', state.running);
  concurrencyInput.disabled = state.running;
  concurrencyRow.classList.toggle('disabled', state.running);
  refPostcodeInput.disabled = state.running;
  refLocationRow.classList.toggle('disabled', state.running);
  rankListEl.classList.toggle('disabled', state.running);
  rankListEl.querySelectorAll('li').forEach((li) => li.setAttribute('draggable', state.running ? 'false' : 'true'));

  if (state.running) {
    progressWrap.classList.remove('hidden');
    const pct = state.total ? Math.round((state.scraped / state.total) * 100) : 0;
    progressFill.style.width = pct + '%';
    const label = state.phase === 'details' ? 'Fetching listing details' : 'Scraping results pages';
    progressText.textContent = `${label}: ${state.scraped} / ${state.total} (${pct}%)`;
    statusEl.textContent = `Found ${state.rows.length} listings so far...`;
  } else if (state.phase === 'done') {
    progressWrap.classList.add('hidden');
    statusEl.textContent = `Done. ${state.rows.length} listings scraped.`;
  } else if (state.rows.length > 0) {
    progressWrap.classList.add('hidden');
    statusEl.textContent = `${state.rows.length} listings ready.`;
  } else {
    progressWrap.classList.add('hidden');
    statusEl.textContent = 'Open a Rightmove search results page, then come back here.';
  }

  if (state.note) {
    noteEl.textContent = state.note;
    noteEl.classList.remove('hidden');
  } else {
    noteEl.classList.add('hidden');
  }

  logEl.textContent = state.log.join('\n');
  renderTopMatches();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') render(msg.state);
});

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
  if (resp && resp.state) render(resp.state);
});

startBtn.addEventListener('click', () => {
  const detailConcurrency = Math.max(1, Math.min(10, Number(concurrencyInput.value) || 4));
  const referencePostcode = refPostcodeInput.value.trim();
  chrome.runtime.sendMessage({
    type: 'START_SCRAPE',
    deep: deepToggle.checked,
    detailConcurrency,
    referencePostcode,
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SCRAPE' });
});

// Rental exports get letAvailableDate instead of tenure/ground rent/service
// charge, which don't apply when you're renting rather than buying.
const BUY_COLUMNS = [
  ['suitabilityScore', 'Suitability Score'],
  ['address', 'Address'],
  ['distanceKm', 'Distance (km)'],
  ['price', 'Price'],
  ['priceQualifier', 'Price Qualifier'],
  ['bedrooms', 'Bedrooms'],
  ['bathrooms', 'Bathrooms'],
  ['propertyType', 'Property Type'],
  ['tenure', 'Tenure'],
  ['groundRent', 'Ground Rent'],
  ['serviceCharge', 'Service Charge'],
  ['size', 'Size'],
  ['pricePerBedroom', 'Price per Bedroom'],
  ['pricePerBathroom', 'Price per Bathroom'],
  ['pricePerSqFt', 'Price per Sq Ft'],
  ['councilTaxBand', 'Council Tax Band'],
  ['epcRating', 'EPC Rating'],
  ['agent', 'Agent'],
  ['firstVisibleDate', 'Date Listed'],
  ['url', 'URL'],
];

const RENT_COLUMNS = [
  ['suitabilityScore', 'Suitability Score'],
  ['address', 'Address'],
  ['distanceKm', 'Distance (km)'],
  ['price', 'Price'],
  ['priceQualifier', 'Price Qualifier'],
  ['bedrooms', 'Bedrooms'],
  ['bathrooms', 'Bathrooms'],
  ['propertyType', 'Property Type'],
  ['letAvailableDate', 'Let Available Date'],
  ['size', 'Size'],
  ['pricePerBedroom', 'Price per Bedroom'],
  ['pricePerBathroom', 'Price per Bathroom'],
  ['pricePerSqFt', 'Price per Sq Ft'],
  ['councilTaxBand', 'Council Tax Band'],
  ['epcRating', 'EPC Rating'],
  ['agent', 'Agent'],
  ['firstVisibleDate', 'Date Listed'],
  ['url', 'URL'],
];

// Size comes through as free text like "1,234 sq. ft." - pull the number
// back out so it can be used in maths. Rightmove's UK listings are in sq ft
// (areaSizeUnit: "sqft" in their own search params), so this assumes that.
function parseSizeSqFt(sizeStr) {
  if (!sizeStr) return null;
  const m = String(sizeStr).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// ---- Suitability score: combine several differently-scaled metrics into
// one ranking number, based on the drag-and-drop order (most important
// first). Order is turned into weights linearly - with 5 metrics, 1st place
// counts 5x as much as 5th place, 2nd place 4x, and so on. ----
// `curve` bends the penalty for the "bad" end of a metric's range so it
// accelerates instead of scaling linearly - e.g. going from 2km to 4km away
// costs more score than going from 0km to 2km did. 1 (or omitted) is plain
// linear; higher values punish the bad end more sharply. Applied to price
// and distance since both have long, punishing tails.
const RANK_METRICS = {
  price: { key: 'price', better: 'lower', curve: 2 },
  bedrooms: { key: 'bedrooms', better: 'higher' },
  bathrooms: { key: 'bathrooms', better: 'higher' },
  size: { key: 'size', better: 'higher', parse: parseSizeSqFt },
  distanceKm: { key: 'distanceKm', better: 'lower', curve: 2 },
};
const RANK_ORDER_STORAGE_KEY = 'rmScraperRankOrder';

function numericValue(row, metric) {
  const raw = row[metric.key];
  if (raw === '' || raw === null || raw === undefined) return null;
  const parsed = metric.parse ? metric.parse(raw) : Number(raw);
  return parsed === null || Number.isNaN(parsed) ? null : parsed;
}

function getRankOrder() {
  return Array.from(rankListEl.querySelectorAll('li')).map((li) => li.dataset.metric);
}

function getWeights() {
  const order = getRankOrder();
  const n = order.length;
  return order.map((metricKey, i) => ({ ...RANK_METRICS[metricKey], weight: n - i }));
}

// Linear-interpolated percentile of an already-sorted numeric array.
function percentile(sortedValues, p) {
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

// Min-max normalizes each metric across the given rows (so "best of what's
// actually on offer" scores 100%, "worst" scores 0%), then combines them
// into one 0-100 score per row using a weighted average. A row missing a
// metric or two (e.g. no bathrooms figure) just has those excluded from its
// own average rather than being penalised for them - but a row missing most
// of what's being ranked by doesn't get scored at all (see below).
function computeScores(rows, weights) {
  const active = weights.filter((w) => w.weight > 0);
  if (!active.length) return rows.map(() => null);
  const totalWeight = active.reduce((sum, w) => sum + w.weight, 0);

  // Min/max taken from the 5th-95th percentile rather than the true
  // extremes, so a single freak outlier (e.g. a Β£15k parking space
  // dragging price all the way down) can't stretch the whole scale and
  // make every normal listing look artificially close to "perfect".
  // Values outside that band are clamped to it rather than dropped.
  const ranges = {};
  for (const w of active) {
    const values = rows.map((r) => numericValue(r, w)).filter((v) => v !== null).sort((a, b) => a - b);
    ranges[w.key] = values.length ? { min: percentile(values, 0.05), max: percentile(values, 0.95) } : null;
  }

  return rows.map((row) => {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const w of active) {
      const range = ranges[w.key];
      if (!range) continue;
      const v = numericValue(row, w);
      if (v === null) continue;
      const clamped = Math.min(range.max, Math.max(range.min, v));
      let norm = range.max === range.min ? 0.5 : (clamped - range.min) / (range.max - range.min);
      if (w.better === 'lower') norm = 1 - norm;
      if (w.curve && w.curve !== 1) {
        // norm is "goodness" here (1 = best) - curve the "badness" tail
        // (1 - norm) so it falls off faster the worse it gets, then flip
        // back to goodness.
        norm = 1 - Math.pow(1 - norm, w.curve);
      }
      weightedSum += norm * w.weight;
      weightTotal += w.weight;
    }
    // A listing only missing one or two metrics (e.g. no size figure) still
    // gets fairly judged on the rest. But one that's missing most of what
    // you're ranking by - a parking space with no bedrooms/bathrooms/size -
    // shouldn't be able to "win" on the strength of a single easy metric
    // like price. Require data covering most of the weight before scoring.
    return weightTotal >= totalWeight * 0.5 ? Math.round((weightedSum / weightTotal) * 100) : null;
  });
}

function saveRankOrder() {
  localStorage.setItem(RANK_ORDER_STORAGE_KEY, JSON.stringify(getRankOrder()));
}

function loadRankOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(RANK_ORDER_STORAGE_KEY) || 'null');
    if (!Array.isArray(saved)) return;
    for (const metricKey of saved) {
      const li = rankListEl.querySelector(`li[data-metric="${metricKey}"]`);
      if (li) rankListEl.appendChild(li);
    }
  } catch (e) {
    // ignore
  }
}

function updateRankNumbers() {
  rankListEl.querySelectorAll('li').forEach((li, i) => {
    li.querySelector('.rank-num').textContent = i + 1;
  });
}

function getDragAfterElement(y) {
  const items = [...rankListEl.querySelectorAll('li:not(.dragging)')];
  return items.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

let draggingEl = null;
rankListEl.querySelectorAll('li').forEach((li) => {
  li.addEventListener('dragstart', () => {
    draggingEl = li;
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    draggingEl = null;
    updateRankNumbers();
    saveRankOrder();
    renderTopMatches();
  });
});
rankListEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!draggingEl) return;
  const after = getDragAfterElement(e.clientY);
  if (after == null) rankListEl.appendChild(draggingEl);
  else rankListEl.insertBefore(draggingEl, after);
});
loadRankOrder();
updateRankNumbers();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Ranks the given rows by current suitability weights, best first, dropping
// any with no score (missing every ranked metric).
function getRankedRows(rows) {
  const scores = computeScores(rows, getWeights());
  return rows
    .map((row, i) => ({ row, score: scores[i] }))
    .filter((s) => s.score !== null)
    .sort((a, b) => b.score - a.score);
}

function renderTopMatches() {
  const rows = lastState && lastState.rows ? lastState.rows : [];
  if (!rows.length) {
    topMatchesEl.classList.add('hidden');
    topMatchesEl.innerHTML = '';
    return;
  }

  const top = getRankedRows(rows).slice(0, 5);

  if (!top.length) {
    topMatchesEl.classList.add('hidden');
    topMatchesEl.innerHTML = '';
    return;
  }

  topMatchesEl.classList.remove('hidden');
  topMatchesEl.innerHTML =
    '<div>Top matches with current ranking:</div><ol>' +
    top.map((s) => `<li>${s.score}% - ${escapeHtml(s.row.address)}</li>`).join('') +
    '</ol>';
}

// Computed at export time (not when a row is first scraped) so these
// reflect the best data available - e.g. a size filled in later by "full
// details" - rather than being frozen at whatever was known first.
function withDerivedFields(row) {
  const price = Number(row.price) || null;
  const bedrooms = Number(row.bedrooms) || null;
  const bathrooms = Number(row.bathrooms) || null;
  const sqft = parseSizeSqFt(row.size);
  return {
    ...row,
    pricePerBedroom: price && bedrooms ? Math.round(price / bedrooms) : '',
    pricePerBathroom: price && bathrooms ? Math.round(price / bathrooms) : '',
    pricePerSqFt: price && sqft ? Math.round(price / sqft) : '',
  };
}

function toCSV(rows, channel) {
  if (!rows.length) return '';
  const columns = channel === 'RENT' ? RENT_COLUMNS : BUY_COLUMNS;
  const scores = computeScores(rows, getWeights());
  const esc = (v) => {
    const s = (v ?? '').toString();
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map(([, label]) => esc(label)).join(',')];
  rows.forEach((r, i) => {
    const derived = { ...withDerivedFields(r), suitabilityScore: scores[i] ?? '' };
    lines.push(columns.map(([key]) => esc(derived[key])).join(','));
  });
  return lines.join('\r\n');
}

openTopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
    const rows = resp && resp.state ? resp.state.rows : [];
    if (!rows.length) return;
    const top = getRankedRows(rows)
      .slice(0, 10)
      .map((s) => s.row.url)
      .filter(Boolean);
    top.forEach((url, i) => chrome.tabs.create({ url, active: i === 0 }));
  });
});

downloadBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
    const state = resp && resp.state;
    const rows = state ? state.rows : [];
    if (!rows.length) return;
    const csv = '﻿' + toCSV(rows, state.channel);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    // Kept short and free of punctuation Excel/Sheets might mangle when
    // auto-naming the worksheet tab from the filename (sheet names are
    // capped at 31 characters and reject several special characters).
    chrome.downloads.download({
      url,
      filename: `Rightmove results ${date}.csv`,
      saveAs: true,
    });
  });
});
