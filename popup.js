const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const downloadBtn = document.getElementById('downloadBtn');
const openTopBtn = document.getElementById('openTopBtn');
const deepToggle = document.getElementById('deepToggle');
const deepToggleLabel = document.querySelector('.deep-toggle');
const concurrencyInput = document.getElementById('concurrencyInput');
const concurrencyRow = document.querySelector('.concurrency-row');
const detailFieldsEl = document.querySelector('.detail-fields');
const detailFieldCheckboxes = document.querySelectorAll('.detail-field');
const refPostcodeInput = document.getElementById('refPostcode');
const refLocationRow = document.querySelector('.ref-location');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const noteEl = document.getElementById('note');
const logEl = document.getElementById('log');
const topMatchesEl = document.getElementById('topMatches');
const weightListEl = document.getElementById('weightList');
const weightPieEl = document.getElementById('weightPie');
const weightPanelEl = document.querySelector('.weight-panel');

let lastState = null;

const DETAIL_FIELDS_STORAGE_KEY = 'rmScraperDetailFields';

function getDetailFields() {
  const fields = {};
  detailFieldCheckboxes.forEach((cb) => {
    fields[cb.dataset.field] = cb.checked;
  });
  return fields;
}

function saveDetailFields() {
  localStorage.setItem(DETAIL_FIELDS_STORAGE_KEY, JSON.stringify(getDetailFields()));
}

function loadDetailFields() {
  try {
    const saved = JSON.parse(localStorage.getItem(DETAIL_FIELDS_STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    detailFieldCheckboxes.forEach((cb) => {
      if (typeof saved[cb.dataset.field] === 'boolean') cb.checked = saved[cb.dataset.field];
    });
  } catch (e) {
    // ignore
  }
}

// "Parallel windows" and the detail-field checklist only matter when
// "Fetch full details" is on - both are meaningless otherwise, since the
// fast scrape never opens any hidden windows at all. Keep them out of the
// way until they're relevant.
function updateDeepOptionsVisibility() {
  concurrencyRow.classList.toggle('hidden', !deepToggle.checked);
  detailFieldsEl.classList.toggle('hidden', !deepToggle.checked);
}
deepToggle.addEventListener('change', updateDeepOptionsVisibility);
detailFieldCheckboxes.forEach((cb) => cb.addEventListener('change', saveDetailFields));
loadDetailFields();
updateDeepOptionsVisibility();

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
  detailFieldsEl.classList.toggle('disabled', state.running);
  detailFieldCheckboxes.forEach((cb) => {
    cb.disabled = state.running;
  });
  refPostcodeInput.disabled = state.running;
  refLocationRow.classList.toggle('disabled', state.running);
  weightPanelEl.classList.toggle('disabled', state.running);
  updateWeightDisplay();

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
  chrome.runtime.sendMessage({
    type: 'START_SCRAPE',
    deep: deepToggle.checked,
    detailConcurrency,
    detailFields: getDetailFields(),
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SCRAPE' });
});

// Rental exports get letAvailableDate instead of tenure/ground rent/service
// charge, which don't apply when you're renting rather than buying.
// Third element (isNumber) tells the xlsx writer to write the cell as a
// real number rather than text, so Excel sorts/formats it correctly.
// Fourth element (isUrl) makes it a real clickable hyperlink.
const BUY_COLUMNS = [
  ['score', 'Score', true],
  ['address', 'Address'],
  ['distanceKm', 'Distance (km)', true],
  ['price', 'Price', true],
  ['priceQualifier', 'Price Qualifier'],
  ['bedrooms', 'Bedrooms', true],
  ['bathrooms', 'Bathrooms', true],
  ['propertyType', 'Property Type'],
  ['tenure', 'Tenure'],
  ['groundRent', 'Ground Rent'],
  ['serviceCharge', 'Service Charge'],
  ['size', 'Size'],
  ['sizeOcrSqFt', 'Size (OCR est., sq ft)', true],
  ['sizeRoomSumSqFt', 'Size (rooms sum est., sq ft)', true],
  ['pricePerBedroom', 'Price per Bedroom', true],
  ['pricePerBathroom', 'Price per Bathroom', true],
  ['pricePerSqFt', 'Price per Sq Ft', true],
  ['councilTaxBand', 'Council Tax Band'],
  ['epcRating', 'EPC Rating'],
  ['agent', 'Agent'],
  ['firstVisibleDate', 'Date Listed'],
  ['url', 'URL', false, true],
];

const RENT_COLUMNS = [
  ['score', 'Score', true],
  ['address', 'Address'],
  ['distanceKm', 'Distance (km)', true],
  ['price', 'Price', true],
  ['priceQualifier', 'Price Qualifier'],
  ['bedrooms', 'Bedrooms', true],
  ['bathrooms', 'Bathrooms', true],
  ['propertyType', 'Property Type'],
  ['letAvailableDate', 'Let Available Date'],
  ['size', 'Size'],
  ['sizeOcrSqFt', 'Size (OCR est., sq ft)', true],
  ['sizeRoomSumSqFt', 'Size (rooms sum est., sq ft)', true],
  ['pricePerBedroom', 'Price per Bedroom', true],
  ['pricePerBathroom', 'Price per Bathroom', true],
  ['pricePerSqFt', 'Price per Sq Ft', true],
  ['councilTaxBand', 'Council Tax Band'],
  ['epcRating', 'EPC Rating'],
  ['agent', 'Agent'],
  ['firstVisibleDate', 'Date Listed'],
  ['url', 'URL', false, true],
];

// Size comes through as free text like "1,234 sq. ft." - pull the number
// back out so it can be used in maths. Rightmove's UK listings are in sq ft
// (areaSizeUnit: "sqft" in their own search params), so this assumes that.
function parseSizeSqFt(sizeStr) {
  if (!sizeStr) return null;
  const m = String(sizeStr).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// Rightmove's own size, falling back first to a directly-read floorplan
// total (sizeOcrSqFt) and then to a rougher room-dimensions-summed
// estimate (sizeRoomSumSqFt) - each its own column - only when there's no
// more confident figure available.
function sizeSqFt(row) {
  const fromText = parseSizeSqFt(row.size);
  if (fromText !== null) return fromText;
  if (typeof row.sizeOcrSqFt === 'number') return row.sizeOcrSqFt;
  return typeof row.sizeRoomSumSqFt === 'number' ? row.sizeRoomSumSqFt : null;
}

// ---- Suitability score: combine several differently-scaled metrics into
// one ranking number, weighted by the 0-10 sliders in the popup (visualized
// as a pie chart - slice size is relative importance). A slider at 0 drops
// that metric out of the ranking entirely. ----
// `curve` bends the penalty for the "bad" end of a metric's range so it
// accelerates instead of scaling linearly - e.g. going from 2km to 4km away
// costs more score than going from 0km to 2km did. 1 (or omitted) is plain
// linear; higher values are more forgiving in the middle of the range but
// hit the far/worst end of it much harder. Used for price, where "good"
// only makes sense relative to what's actually on offer in this search.
//
// Distance is handled differently (`decayHalfKm` instead of `curve`):
// price/bedrooms/bathrooms/size are scored relative to the batch's own
// spread (min-max, "best of what's on offer" = 100%), which is right for
// them since there's no fixed absolute idea of a "good" price. But that's
// wrong for distance - if a search happens to span a huge area, "2km away"
// is a tiny fraction of that range, so a relative curve rounds it to ~100
// no matter how steep, however far it really is from the closest listing.
// Distance instead uses a fixed exponential decay from the raw km value
// itself: score halves every `decayHalfKm` km, regardless of what the rest
// of the batch looks like. Only genuinely close listings (a small fraction
// of decayHalfKm) round to 100 - e.g. at 1.5, 0km=100%, 1.5km=50%,
// 3km=25%, 6km=6%, 10km=~2%.
const RANK_METRICS = {
  price: { key: 'price', better: 'lower', curve: 2 },
  bedrooms: { key: 'bedrooms', better: 'higher' },
  bathrooms: { key: 'bathrooms', better: 'higher' },
  size: { key: 'size', better: 'higher', resolve: sizeSqFt },
  distanceKm: { key: 'distanceKm', decayHalfKm: 1.5 },
};
const METRIC_ORDER = ['distanceKm', 'size', 'price', 'bedrooms', 'bathrooms'];
const METRIC_COLORS = {
  price: '#00805e',
  bedrooms: '#1a4fbb',
  bathrooms: '#7a3ec7',
  size: '#d97706',
  distanceKm: '#dc2626',
};
const WEIGHT_STORAGE_KEY = 'rmScraperWeights';

function numericValue(row, metric) {
  if (metric.resolve) {
    const resolved = metric.resolve(row);
    return resolved === null || resolved === undefined || Number.isNaN(resolved) ? null : resolved;
  }
  const raw = row[metric.key];
  if (raw === '' || raw === null || raw === undefined) return null;
  const parsed = metric.parse ? metric.parse(raw) : Number(raw);
  return parsed === null || Number.isNaN(parsed) ? null : parsed;
}

function sliderFor(metricKey) {
  return weightListEl.querySelector(`input[data-metric="${metricKey}"]`);
}

// ---- Live distance-from-postcode ----
// Deliberately NOT computed once at scrape time and baked into each row -
// that went stale (still showing distance from whatever postcode, or none,
// was active during the scrape) if "Distance from" was changed afterwards
// without re-scraping, which could silently show a wildly wrong km figure.
// Instead each row keeps raw lat/lon from Rightmove, and distance is
// (re)computed here from the currently-entered postcode every time it's
// needed, the same way the suitability score is already live.
let refCoords = null; // { latitude, longitude } for refPostcodeKey, once resolved
let refPostcodeKey = ''; // normalized postcode refCoords corresponds to (or is resolving for)
let refCoordsSeq = 0; // guards a stale in-flight lookup from overwriting a newer one

const REF_POSTCODE_STORAGE_KEY = 'rmScraperRefPostcode';

function saveRefPostcode() {
  localStorage.setItem(REF_POSTCODE_STORAGE_KEY, refPostcodeInput.value);
}

function loadRefPostcode() {
  try {
    const saved = localStorage.getItem(REF_POSTCODE_STORAGE_KEY);
    if (saved) refPostcodeInput.value = saved;
  } catch (e) {
    // ignore
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Re-resolves refCoords whenever the postcode box changes. Runs async in
// the background - callers just read whatever's currently cached (null
// while unresolved), and re-render once it settles.
function refreshRefCoords() {
  const key = refPostcodeInput.value.trim().toUpperCase().replace(/\s+/g, '');
  if (key === refPostcodeKey) return;
  refPostcodeKey = key;
  refCoords = null;
  const seq = ++refCoordsSeq;
  if (!key) return;
  fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(key)}`)
    .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (seq !== refCoordsSeq) return; // a newer postcode has since been entered
      if (!ok || !data.result) throw new Error('not found');
      refCoords = { latitude: data.result.latitude, longitude: data.result.longitude };
    })
    .catch(() => {
      if (seq !== refCoordsSeq) return;
      refCoords = null;
    })
    .finally(() => {
      if (seq !== refCoordsSeq) return;
      updateWeightDisplay();
      renderTopMatches();
    });
}

// Distance is meaningless without a successfully-resolved reference
// postcode - rather than let its slider quietly do nothing, its weight is
// forced to 0 (and the slider/pie/label greyed out) until one resolves,
// regardless of wherever the slider itself is set.
function isDistanceUsable() {
  return !!refCoords;
}

// Returns a copy of rows with distanceKm freshly computed from the current
// refCoords, overriding whatever (if anything) was there before.
function withLiveDistance(rows) {
  return rows.map((row) => {
    if (!refCoords || typeof row.lat !== 'number' || typeof row.lon !== 'number') {
      return { ...row, distanceKm: '' };
    }
    return { ...row, distanceKm: haversineKm(refCoords.latitude, refCoords.longitude, row.lat, row.lon).toFixed(1) };
  });
}

function getWeights() {
  const distanceUsable = isDistanceUsable();
  return METRIC_ORDER.map((metricKey) => {
    const sliderValue = Number(sliderFor(metricKey).value) || 0;
    const weight = metricKey === 'distanceKm' && !distanceUsable ? 0 : sliderValue;
    return { ...RANK_METRICS[metricKey], weight };
  });
}

// This value's percentile rank (0..1) within an already-sorted numeric
// array, using mid-rank tie handling - tied values share the average rank
// of their tie group, so e.g. several identical 2-bedroom listings all
// score identically rather than an arbitrary order-dependent split.
//
// Used instead of min-max normalization because min-max needs an outlier
// safeguard (clamping to e.g. the 5th-95th percentile) to stop one freak
// value from stretching the whole scale and compressing everyone else
// toward "looks perfect" - but that clamp then ties every value beyond it
// to the same score, flattening exactly the extreme (biggest/cheapest/etc)
// listings someone weighting that trait heavily cares most about
// differentiating. Percentile rank has neither problem: an outlier just
// takes the top or bottom rank without dragging anyone else's rank with
// it, and every distinct value still gets its own distinct rank - no
// clamp, no plateau.
function percentileRank(sortedValues, v) {
  let countLess = 0;
  let countEqual = 0;
  for (const x of sortedValues) {
    if (x < v) countLess++;
    else if (x === v) countEqual++;
  }
  return (countLess + 0.5 * countEqual) / sortedValues.length;
}

// Ranks each metric across the given rows (percentile rank - see above),
// then combines them into one 0-100 score per row using a weighted
// GEOMETRIC mean (not a plain average - see below). A row missing a
// metric or two (e.g. no bathrooms figure) just has those excluded rather
// than being penalised for them. Every row with at least one known ranked
// metric still gets included and scored (see the coverage blend below) -
// nothing gets dropped from the ranking.
//
// Geometric, not arithmetic: with a plain weighted average, a metric at
// (say) 50% weight can never pull the total below 50 if everything else
// scores 100 - the other half of the weight acts as a guaranteed floor no
// matter how bad that one metric is. That makes it impossible for "far
// away" to really hurt a score once other metrics are strong, regardless
// of how harshly the individual metric itself is curved. A weighted
// geometric mean doesn't have that floor - a poor score on a heavily
// weighted metric drags the total down hard, while a lightly weighted
// metric still only has proportionally small influence.
function computeScores(rows, weights) {
  const active = weights.filter((w) => w.weight > 0);
  if (!active.length) return rows.map(() => null);
  const totalWeight = active.reduce((sum, w) => sum + w.weight, 0);

  // (Not used for distance - see decayHalfKm above, which has its own
  // fixed, non-relative scale.)
  const sortedValues = {};
  for (const w of active) {
    if (w.decayHalfKm) continue;
    const values = rows.map((r) => numericValue(r, w)).filter((v) => v !== null).sort((a, b) => a - b);
    sortedValues[w.key] = values.length ? values : null;
  }

  return rows.map((row) => {
    let logSum = 0;
    let weightTotal = 0;
    for (const w of active) {
      const v = numericValue(row, w);
      if (v === null) continue;
      let norm;
      if (w.decayHalfKm) {
        norm = Math.pow(0.5, Math.max(0, v) / w.decayHalfKm);
      } else {
        const sorted = sortedValues[w.key];
        if (!sorted) continue;
        norm = percentileRank(sorted, v);
        if (w.better === 'lower') norm = 1 - norm;
        if (w.curve && w.curve !== 1) {
          // norm is "goodness" here (1 = best) - curve the "badness" tail
          // (1 - norm) so it falls off faster the worse it gets, then flip
          // back to goodness.
          norm = 1 - Math.pow(1 - norm, w.curve);
        }
      }
      // Floored rather than left at literal 0 so one catastrophic metric
      // doesn't force the geometric mean to exactly 0 regardless of every
      // other metric - it still gets crushed toward 0, just not to a hard
      // wall that would make two very-bad-but-different listings tie.
      logSum += w.weight * Math.log(Math.max(norm, 0.001));
      weightTotal += w.weight;
    }
    if (weightTotal === 0) return null;
    // Blend the row's own score toward a neutral 50% by how much of the
    // ranking's total weight it actually has data for. A listing missing
    // just one commonly-absent metric (e.g. size) has coverage close to 1,
    // so this barely moves it. A listing missing almost everything - a
    // parking space with only a price - has low coverage, so however great
    // its one known metric looks gets pulled most of the way back to
    // "unknown, assume average" instead of standing in as its whole score.
    // Nothing gets excluded outright; a very sparse row just can't coast to
    // the top on a single easy metric.
    const raw = Math.exp(logSum / weightTotal);
    const coverage = weightTotal / totalWeight;
    const blended = raw * coverage + 0.5 * (1 - coverage);
    // Left unrounded here so sorting (CSV, Top Matches, Open Top 10) can
    // still tell apart listings that round to the same displayed
    // percentage but aren't actually tied - round only where the score is
    // shown or exported.
    return blended * 100;
  });
}

function saveWeights() {
  const obj = {};
  METRIC_ORDER.forEach((metricKey) => {
    obj[metricKey] = Number(sliderFor(metricKey).value) || 0;
  });
  localStorage.setItem(WEIGHT_STORAGE_KEY, JSON.stringify(obj));
}

function loadWeights() {
  try {
    const saved = JSON.parse(localStorage.getItem(WEIGHT_STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    METRIC_ORDER.forEach((metricKey) => {
      if (typeof saved[metricKey] === 'number') sliderFor(metricKey).value = saved[metricKey];
    });
  } catch (e) {
    // ignore
  }
}

// Redraws the pie chart (a conic-gradient sized by each slider's share of
// the total), the "X%" label next to each slider, and the disabled/greyed
// state of the distance slider (only usable once a postcode is entered).
function updateWeightDisplay() {
  const distanceUsable = isDistanceUsable();
  const running = !!(lastState && lastState.running);
  weightListEl.querySelectorAll('.weight-slider').forEach((input) => {
    input.disabled = running || (input.dataset.metric === 'distanceKm' && !distanceUsable);
  });
  const distanceLi = weightListEl.querySelector('li[data-metric="distanceKm"]');
  if (distanceLi) distanceLi.classList.toggle('inactive', !distanceUsable);

  const weights = getWeights();
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  let angle = 0;
  const stops = [];
  weights.forEach((w) => {
    const pctEl = weightListEl.querySelector(`li[data-metric="${w.key}"] .weight-pct`);
    if (w.key === 'distanceKm' && !distanceUsable) {
      if (pctEl) pctEl.textContent = '–';
    } else if (pctEl) {
      const pct = total > 0 ? Math.round((w.weight / total) * 100) : 0;
      pctEl.textContent = pct + '%';
    }
    if (w.weight > 0 && total > 0) {
      const start = angle;
      angle += (w.weight / total) * 360;
      stops.push(`${METRIC_COLORS[w.key]} ${start}deg ${angle}deg`);
    }
  });
  weightPieEl.style.background = stops.length ? `conic-gradient(${stops.join(', ')})` : '#eee';
}

weightListEl.querySelectorAll('li').forEach((li) => {
  const swatch = li.querySelector('.weight-swatch');
  if (swatch) swatch.style.background = METRIC_COLORS[li.dataset.metric];
});
weightListEl.querySelectorAll('.weight-slider').forEach((input) => {
  input.addEventListener('input', () => {
    updateWeightDisplay();
    saveWeights();
    renderTopMatches();
  });
});
refPostcodeInput.addEventListener('input', () => {
  refreshRefCoords();
  saveRefPostcode();
  updateWeightDisplay();
  renderTopMatches();
});
loadWeights();
loadRefPostcode();
refreshRefCoords();
updateWeightDisplay();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Ranks the given rows by current suitability weights, best first, dropping
// any with no score (missing every ranked metric).
function getRankedRows(rows) {
  rows = withLiveDistance(rows);
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
    top.map((s) => `<li>${Math.round(s.score)}% - ${escapeHtml(s.row.address)}</li>`).join('') +
    '</ol>';
}

// Computed at export time (not when a row is first scraped) so these
// reflect the best data available - e.g. a size filled in later by "full
// details" - rather than being frozen at whatever was known first.
function withDerivedFields(row) {
  const price = Number(row.price) || null;
  const bedrooms = Number(row.bedrooms) || null;
  const bathrooms = Number(row.bathrooms) || null;
  const sqft = sizeSqFt(row);
  return {
    ...row,
    pricePerBedroom: price && bedrooms ? Math.round(price / bedrooms) : '',
    pricePerBathroom: price && bathrooms ? Math.round(price / bathrooms) : '',
    pricePerSqFt: price && sqft ? Math.round(price / sqft) : '',
  };
}

// Builds the exportable rows for the current ranking, best (highest score)
// first - unscored listings (no ranking weights active at all) sort last
// rather than being dropped.
function buildExportRows(rows, channel) {
  const columns = channel === 'RENT' ? RENT_COLUMNS : BUY_COLUMNS;
  rows = withLiveDistance(rows);
  const scores = computeScores(rows, getWeights());
  const withScores = rows.map((r, i) => ({
    score: scores[i],
    derived: { ...withDerivedFields(r), score: scores[i] === null ? '' : Math.round(scores[i]) },
  }));
  withScores.sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });
  return { columns, rows: withScores.map((w) => w.derived) };
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

// A blob: URL is scoped to this popup document - if the native "Save As"
// dialog (saveAs: true, below) steals focus, Chrome closes the popup, which
// can revoke the blob URL before the download manager finishes reading it.
// That's read as "nothing happened" and needed a retry or two. A data: URL
// isn't tied to any document's lifetime, so it survives the popup closing.
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

downloadBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, async (resp) => {
    const state = resp && resp.state;
    const rows = state ? state.rows : [];
    if (!rows.length) return;
    const { columns, rows: exportRows } = buildExportRows(rows, state.channel);
    const blob = buildXlsx(columns, exportRows);
    const url = await blobToDataUrl(blob);
    const date = new Date().toISOString().slice(0, 10);
    chrome.downloads.download({
      url,
      filename: `Rightmove results ${date}.xlsx`,
      saveAs: true,
    });
  });
});
