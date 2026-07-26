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
  - One option, "Estimate size from floorplan when missing", is off by
    default: Rightmove doesn't always have a size figure on file at all
    (shows "Ask agent"), but the floorplan image usually has the Gross
    Internal Area printed on it. When this is on and a listing has no size,
    the extension OCRs the floorplan image (via a locally-bundled
    Tesseract.js - no external service, no API key) and looks for a
    "NNN sq ft" or "NNN ft²" total on it (both conventions show up in
    practice). This only works when the floorplan actually states a total
    (some, especially stylised marketing floorplans, don't - a "75m2, no
    sq ft anywhere" floorplan is left alone rather than guessed at)
    and OCR isn't perfect, so the result goes into its own "Size (OCR est.,
    sq ft)" column rather than into "Size" itself - it's always visible
    which listings got a real Rightmove figure versus an OCR guess. It's
    still used as a fallback for Price per Sq Ft and the "size" ranking
    when "Size" is blank. Adds a few real seconds of processing per listing
    that needs it.
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
- The floorplan-size OCR was validated against real Rightmove floorplans
  (the OCR engine itself, run standalone, reads the printed area correctly
  when one exists) but not against the full in-extension pipeline (the
  offscreen document + Chrome's OCR message passing) end-to-end in a live
  browser session. If it doesn't seem to be working, check the offscreen
  document's console via `chrome://extensions` → "Inspect views" for
  errors, and report back what they say.
