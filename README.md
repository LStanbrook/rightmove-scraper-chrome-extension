# Rightmove Scraper Chrome Extension

Chrome/Edge extension that scrapes every listing across a Rightmove search's
result pages (price, beds, baths, tenure, size, agent, and more) and exports
everything to an Excel file.

## How it works

- Rightmove's search results page embeds a JSON blob with structured data
  for every listing card. The extension reads that directly instead of
  scraping visible text, and pages through the rest of the results the same
  way in the background.
- Ticking "Fetch full details" additionally opens a few hidden windows
  (count set by "Parallel windows", which only appears once that's ticked -
  it has no effect otherwise) to pull fields that only exist on each
  listing's own page - council tax band, EPC rating, ground rent, service
  charge. This is slower since it's a real page load per listing; if Chrome
  gets sluggish, lower "Parallel windows". A checklist appears alongside it
  to choose which of those fields to actually fetch.
  - One option, "Estimate size from floorplan when missing or an outlier",
    is off by default: Rightmove doesn't always have a size figure on file
    at all (shows "Ask agent"), but the floorplan image usually has the
    Gross Internal Area printed on it. When this is on, the extension OCRs
    the floorplan (via a locally-bundled Tesseract.js - no external
    service, no API key) for any listing with no size, and looks for a
    total in whatever form it's stated - "NNN sq ft", "NNN ft²", or
    "NNN sq. feet" all show up in practice. This only works when the
    floorplan actually states a total (some, especially stylised marketing
    floorplans, don't) and OCR isn't perfect, so the result goes into its
    own "Size (OCR est., sq ft)" column rather than into "Size" itself -
    it's always visible which listings got a real Rightmove figure versus
    an OCR guess. Floorplans sometimes print more than one figure - a
    smaller separate structure's own area (an annex, summer house, garage)
    next to the main total, or a Gross External Area alongside the Gross
    Internal one - so a figure explicitly labelled "internal" is preferred
    when there is one, and anything labelled "external" or belonging to a
    separate structure is never used, even as a fallback: reporting either
    as the property's own size would be actively misleading rather than
    just imprecise, so it's treated the same as finding nothing. Newer,
    EPC-derived floorplans often state only a metric total ("71m²", no sq
    ft conversion anywhere on the image, sometimes as a small table with
    the "sq.m" label and its value on separate lines rather than side by
    side) - that's read and converted too, still counting as a direct
    total rather than an estimate. Smaller floorplan images (some agents,
    particularly for new-build developments, never provide a larger one)
    are also OCR'd upscaled, alongside the original - verified against a
    real 370px-wide floorplan whose size table was unreadable at native
    resolution but came through correctly once upscaled, and separately
    against a real ~1200px floorplan where upscaling had the opposite
    effect, blurring an already-clean read just enough to lose it - so
    neither resolution is preferred outright; whichever pass actually
    finds a real total wins. OCR fairly often drops the decimal point from
    a small area figure ("50.9" read as "509") - since the underlying
    convention (one decimal place for a total, two for a room dimension)
    is consistent, an implausible whole-number reading is reinterpreted
    with the decimal restored rather than trusted or discarded outright,
    which avoids both reporting a confidently wrong, ~10x-too-large number
    and losing a room's dimensions to the fallback below entirely. If no
    reliable total is stated either, it falls back further to summing the
    individual room dimensions printed on the floorplan (e.g. "3.50m x
    3.11m" per room) - a rougher estimate (it tends to run a little low,
    since hallways and cupboards aren't always dimensioned), so it gets
    its own separate "Size (rooms sum est., sq ft)" column rather than
    being mixed in with direct reads. Both OCR columns are
    still used as a fallback for Price per Sq Ft and the "size" ranking
    when "Size" is blank - and take priority over "Size" itself, for
    those two purposes only, if a re-check found a different figure than
    the listed one, since that's exactly the situation the re-check
    exists to catch. Adds a few real seconds of processing per listing
    that needs it.
  - It also re-checks a listing that already has a size if that size is a
    clear statistical outlier against the rest of the batch (computed
    once per scrape, in log space so it isn't skewed by the natural mix of
    small and large properties) - usually a sign of a data-entry error
    (a missing or extra digit) rather than a genuinely unusual property.
    The floorplan reading still only ever populates the separate OCR
    column, so a real, just-unusual property can't have its own figure
    overwritten by a lower-confidence guess.
- Rightmove caps how many results can actually be paged through (roughly
  1,000, regardless of your total match count). To get everything, narrow
  the search below ~1,000 results - e.g. split by price band, bedrooms, or
  area - and run a scrape per slice.
- Columns differ slightly for sale vs. rental searches (e.g. tenure vs. let
  available date), and every export includes computed Price per
  Bedroom/Bathroom/Sq Ft. The exported rows are sorted by "Score" (best
  first) rather than scrape order. The URL column is a real clickable
  hyperlink, not just plain text.
- Optionally enter a UK postcode under "Distance from" to add a straight-line
  "Distance (km)" column. Distance is (re)computed live from whatever
  postcode is currently in that box, every time it's needed - it's not
  calculated once at scrape time and baked in, so changing the postcode
  after scraping (without re-scraping) updates the distance column
  immediately instead of silently continuing to show distance from a
  stale or absent reference point. The postcode is remembered between
  popup opens, so it doesn't need re-entering every time.
- "Rank by importance" gives distance / size / price / bedrooms / bathrooms
  (that default order/weighting) each a 0-10 slider, visualized as a live
  pie chart, to get a 0-100% "Score" column so you can sort listings by what
  actually matters to you - not just the order of importance, but by how
  much (e.g. price mattering twice as much as bedrooms). Drag a slider to 0
  to drop that trait from the ranking entirely. Distance's slider is greyed
  out and left out of the pie until a "Distance from" postcode is set,
  since it can't affect anything without one. Recomputed live from whatever
  the sliders say right now, every time it's needed - re-ranking after a
  scrape (or before exporting) always reflects the current sliders, not
  whatever they were set to during the scrape.
  - The per-metric scores are combined with a weighted *geometric* mean,
    not a plain average - a plain average can't let a bad score truly tank
    the total (a metric at 50% weight can never pull the score below 50 if
    everything else is perfect, whatever the weight, since the other half
    of the weight is a guaranteed floor). The geometric mean has no such
    floor: a poor score on a heavily-weighted metric drags the total down
    hard, while a lightly-weighted metric still only has proportionally
    small influence - so a listing 9km away with an otherwise-perfect
    score scores ~13% overall if distance is half your ranking, but ~76%
    if distance is only a twentieth of it.
  - Price/bedrooms/bathrooms/size are scored by percentile rank within the
    batch (what fraction of listings this value beats), not min-max - a
    single freak outlier (e.g. a parking space at a tenth of everyone
    else's price) just takes the top or bottom rank without dragging
    anyone else's rank with it, so it can't compress or flatten everyone
    else's score the way min-max scaling would. It also means every
    distinct value gets its own distinct score - e.g. weighting only size
    spreads the biggest properties out across the top of the range instead
    of many of them tying at 100%. Price is additionally weighted on a
    curve: a listing merely a bit pricier than the cheapest barely loses
    score, while one way over loses a lot more.
  - Distance instead uses a fixed decay from the actual km value (score
    halves every 1.5km: 0km=100%, 1.5km=50%, 3km=25%, 6km=6%), rather than
    being relative to the batch. A relative curve doesn't work for
    distance - in a search spanning a wide area, "2km away" is a tiny
    fraction of that range, so it'd round to ~100 no matter how steep the
    curve, regardless of how far it really is from the closest listing.
    With the fixed decay, only genuinely close listings score near 100.
  - The displayed percentage is rounded, but sorting (exports, Top
    Matches, Open Top 10) always uses the unrounded score underneath, so
    two listings that happen to display the same rounded percentage still
    rank in their true order.
  - Every listing stays in the ranking, but one missing most of what
    you're ranking by (e.g. a parking space with no bedrooms/bathrooms/
    size) has its score pulled toward a neutral 50% in proportion to how
    much is missing, so it can't "win" purely by acing the one or two
    metrics it happens to have - a listing only missing one common field
    like size is barely affected.
- "Open Top 10" opens the current top 10 ranked listings in new tabs, using
  whatever ranking order is currently set.

## Install (unpacked)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and select this folder.

## Use

1. Do a search on rightmove.co.uk and land on the results (list) page.
2. Click the extension icon.
3. Optionally enter a postcode under "Distance from", tick "Fetch full
   details" and choose which of those fields to pull, and/or adjust
   "Parallel windows".
4. Click "Scrape all pages". Watch progress in the popup.
5. Click "Download Excel" once it's done (or at any point after clicking
   Stop - it exports whatever's been scraped so far).
6. Click "Open Top 10" to open the current top-ranked listings in new tabs.

## Known limitations

- Council tax / EPC / ground rent / service charge extraction is a
  best-effort text scan of the listing page (`extractDetailFieldsInPage` in
  `background.js`). If Rightmove changes its layout and these come back
  blank, the selectors may need updating.
- Only tested against the standard for-sale/to-rent search list view
  (`.../find.html`), not the map view.
- Tesseract.js's browser worker defaults to spawning via a Blob URL
  wrapping `importScripts("<workerPath>")`, rather than loading the
  worker script directly - which a Chrome extension's CSP blocks (a
  blob: worker's importScripts() call to a chrome-extension:// resource
  is refused, even though loading it directly as the worker's own
  script is allowed). Worked around with `workerBlobURL: false` in
  `offscreen.js`. If a future Tesseract.js update reintroduces OCR
  silently finding nothing (no errors, no matches, ever), this is the
  first thing to check - confirm via the offscreen document's own
  DevTools console (`chrome://extensions` → "Inspect views:
  offscreen.html", only available while a scrape is actively running).
