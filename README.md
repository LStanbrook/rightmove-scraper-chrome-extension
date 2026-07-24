# Rightmove Scraper Chrome Extension

Chrome/Edge extension that scrapes every listing across a Rightmove search's
result pages (price, beds, baths, tenure, size, agent, and more) and exports
everything to an Excel file.

## How it works

- Rightmove's search results page embeds a JSON blob with structured data
  for every listing card. The extension reads that directly instead of
  scraping visible text, and pages through the rest of the results the same
  way in the background.
- Ticking "Also fetch full details" additionally opens a few hidden windows
  (count set by "Parallel windows") to pull fields that only exist on each
  listing's own page - council tax band, EPC rating, ground rent, service
  charge. This is slower since it's a real page load per listing; if Chrome
  gets sluggish, lower "Parallel windows".
- Rightmove caps how many results can actually be paged through (roughly
  1,000, regardless of your total match count). To get everything, narrow
  the search below ~1,000 results - e.g. split by price band, bedrooms, or
  area - and run a scrape per slice.
- Columns differ slightly for sale vs. rental searches (e.g. tenure vs. let
  available date), and every export includes computed Price per
  Bedroom/Bathroom/Sq Ft. The exported rows are sorted by "Score" (best
  first) rather than scrape order.
- Optionally enter a UK postcode under "Distance from" to add a straight-line
  "Distance (km)" column.
- "Rank by importance" gives distance / size / price / bedrooms / bathrooms
  (that default order/weighting) each a 0-10 slider, visualized as a live
  pie chart, to get a 0-100% "Score" column so you can sort listings by what
  actually matters to you - not just the order of importance, but by how
  much (e.g. price mattering twice as much as bedrooms). Drag a slider to 0
  to drop that trait from the ranking entirely. Distance's slider is greyed
  out and left out of the pie until a "Distance from" postcode is set,
  since it can't affect anything without one. Price and distance are
  weighted on a curve rather than linearly, so a listing that's merely a
  bit pricier or a bit further barely loses score, while one that's way
  over on either loses more - the penalty accelerates the further out it
  gets, rather than scaling evenly step for step. The curve is deliberately
  gentle rather than steep, since a steep one crushes every "close" listing
  toward the same displayed 100%, making genuinely different nearby
  distances look identical - the displayed percentage is necessarily
  rounded, but sorting (exports, Top Matches, Open Top 10) always uses the
  unrounded score underneath, so listings that display the same percentage
  still rank in their true order. Every listing stays in the ranking, but
  one missing most of what you're ranking by (e.g. a parking space with no
  bedrooms/bathrooms/size) has its score pulled toward a neutral 50% in
  proportion to how much is missing, so it can't "win" purely by acing the
  one or two metrics it happens to have - a listing only missing one common
  field like size is barely affected. Price/distance outliers are also
  clamped to roughly the 5th-95th percentile of the batch before scoring,
  so one freak listing can't skew everyone else's score.
- "Open Top 10" opens the current top 10 ranked listings in new tabs, using
  whatever ranking order is currently set.

## Install (unpacked)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and select this folder.

## Use

1. Do a search on rightmove.co.uk and land on the results (list) page.
2. Click the extension icon.
3. Optionally enter a postcode under "Distance from", tick "Also fetch full
   details", and/or adjust "Parallel windows".
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
