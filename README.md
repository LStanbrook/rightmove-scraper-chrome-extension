# Rightmove Scraper Chrome Extension

Chrome/Edge extension that scrapes every listing across a Rightmove search's
result pages (price, beds, baths, tenure, size, agent, and more) and exports
everything to CSV.

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
- CSV columns differ slightly for sale vs. rental searches (e.g. tenure vs.
  let available date), and every export includes computed Price per
  Bedroom/Bathroom/Sq Ft.
- Optionally enter a UK postcode under "Distance from" to add a straight-line
  "Distance (km)" column.
- "Rank by importance" lets you drag price / bedrooms / bathrooms / size /
  distance into a priority order to get a 0-100% "Suitability Score" column,
  so you can sort listings by what actually matters to you.

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
5. Click "Download CSV" once it's done (or at any point after clicking Stop
   - it exports whatever's been scraped so far).

## Known limitations

- Council tax / EPC / ground rent / service charge extraction is a
  best-effort text scan of the listing page (`extractDetailFieldsInPage` in
  `background.js`). If Rightmove changes its layout and these come back
  blank, the selectors may need updating.
- Only tested against the standard for-sale/to-rent search list view
  (`.../find.html`), not the map view.
