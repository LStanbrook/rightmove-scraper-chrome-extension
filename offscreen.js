// Runs OCR on floorplan images. This has to happen in an offscreen document
// (a real page context) rather than the background service worker, because
// Tesseract.js needs to spawn its own Worker and use WebAssembly - neither
// is available inside an MV3 service worker.
//
// A single Tesseract worker is created lazily and reused for every
// floorplan in a scrape rather than one per image - creating one costs
// ~1-2s of model loading, and recognize() calls simply queue up on a
// shared worker instead of needing N of them for N concurrent listings
// (which would also multiply memory use, since each worker loads its own
// copy of the ~7MB engine + language data).

// Several conventions show up on real Rightmove floorplans: "624 sq ft",
// "751 Sq Ft.", "567 ft²" with no "sq" at all, and "629.7 sq. feet" spelled
// out with a decimal. Tesseract also reliably misreads the "²" as "?", and
// (verified against real floorplans reading "806 SQ FT" as "£08 5Q FT" and
// "94 sq ft" as "94 5q ft") sometimes misreads the "S" in "SQ" as a "5" -
// both accepted as equivalent markers.
const SQFT_RE = /(\d[\d,]{0,6}(?:\.\d+)?)\s*(?:[s5][qo]\.?\s*ft\b|[s5][qo]\.?\s*feet\b|ft\.?\s*[²2?])/gi;
const MIN_PLAUSIBLE_SQFT = 50;
const MAX_PLAUSIBLE_SQFT = 20000;
const SQM_TO_SQFT = 10.7639;
// Labels that mean a nearby figure is NOT the whole property's own total:
// "external" area (always larger than internal - counts wall thickness,
// so blindly preferring the biggest number on the page would systematically
// pick this over the correct internal figure), a separate structure
// (verified against a real floorplan pairing a house's main total with a
// much smaller "SUMMER HOUSE 107 SQFT" figure for its outbuilding, which a
// plain reading-order or largest-value pick both got wrong), or an
// explicitly excluded sub-area (verified against a real floorplan stating
// "Total: 56 m2" alongside "Excluded Areas: Walls: 5 m2" - the latter is
// smaller and would never win a largest-value pick anyway, but is excluded
// defensively rather than relying on that).
const EXTERNAL_AREA_RE = /external/i;
const SEPARATE_STRUCTURE_RE = /summer\s*house|annex(?:e)?|outbuilding|garden\s*room|granny\s*flat|garage/i;
const EXCLUDED_SUBAREA_RE = /excluded|\bwalls?\b/i;
const INTERNAL_AREA_RE = /internal/i;
// How far back from a match to look for one of the labels above - scoped to
// the same OCR text block (a blank line marks a new one) as a cap, so a
// label describing an earlier, unrelated block can't be picked up.
const LABEL_LOOKBACK_CHARS = 60;

function contextFor(text, index) {
  const blockStart = text.lastIndexOf('\n\n', index - 1);
  const contextStart = Math.max(0, blockStart + 2, index - LABEL_LOOKBACK_CHARS);
  return text.slice(contextStart, index);
}

// Shared by the sq ft and sq m total extractors below: given a list of
// candidate {value, context} readings, picks the one to trust.
function pickBestTotal(matches) {
  const candidates = matches.map(({ value, context }) => ({
    value,
    internal: INTERNAL_AREA_RE.test(context),
    excluded: EXTERNAL_AREA_RE.test(context) || SEPARATE_STRUCTURE_RE.test(context) || EXCLUDED_SUBAREA_RE.test(context),
  }));
  const internalOnes = candidates.filter((c) => c.internal);
  if (internalOnes.length) return Math.max(...internalOnes.map((c) => c.value));
  const eligible = candidates.filter((c) => !c.excluded);
  return eligible.length ? Math.max(...eligible.map((c) => c.value)) : null;
}

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('lib/tesseract/tesseract-core-lstm.wasm.js'),
      langPath: chrome.runtime.getURL('lib/tesseract'),
      gzip: true,
      // Tesseract.js defaults to spawning its worker via a Blob URL
      // wrapping `importScripts("<workerPath>")`, rather than loading
      // workerPath directly - found (via a real offscreen-document
      // DevTools console) to be exactly what a Chrome extension's CSP
      // blocks: a blob: worker's importScripts() call to a
      // chrome-extension:// resource is refused, even though a direct
      // same-origin worker load is allowed. Forcing a direct
      // `new Worker(workerPath)` instead sidesteps that blob indirection
      // entirely.
      workerBlobURL: false,
    }).then(async (worker) => {
      // Floorplans are scattered text over line art, not prose - SPARSE_TEXT
      // (PSM 11, "find as much text as possible in no particular order")
      // reads them far more completely than Tesseract.js's own default of
      // SINGLE_BLOCK. Verified against real floorplans: strictly better or
      // equal on every image that already worked (still reads e.g. "916 sq
      // ft" / "742.71 Sq Ft" correctly), and turns a near-total miss into
      // reading 4 of 5 room dimensions on one that otherwise only yielded
      // a single fragment of text.
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
      return worker;
    });
  }
  return workerPromise;
}

// Floorplans often print more than one "NNN sq ft" figure - per-floor
// breakdowns alongside the whole-property total, or a separate structure's
// own area next to the main total. Prefers a figure explicitly labelled
// "internal" when there is one; otherwise falls back to any unlabelled
// figure (most floorplans only ever state one total, with no "internal" /
// "external" wording at all); external-area and separate-structure figures
// are never used, even as a last resort - reporting either as if it were
// the property's own internal size would be actively misleading rather
// than merely imprecise, and it's safer to fall through to the room-
// dimension estimate (or find nothing) than to report a confidently wrong
// number. When more than one figure remains eligible (e.g. unlabelled
// per-floor breakdowns next to an unlabelled total), the total can never
// be smaller than a sub-area also stated on the same floorplan, so the
// largest is taken.
function extractStatedSqFt(text) {
  const matches = [];
  let match;
  SQFT_RE.lastIndex = 0; // stateful (global) regex - reset before each use
  while ((match = SQFT_RE.exec(text)) !== null) {
    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value) || value < MIN_PLAUSIBLE_SQFT || value > MAX_PLAUSIBLE_SQFT) continue;
    matches.push({ value, context: contextFor(text, match.index) });
  }
  return pickBestTotal(matches);
}

// Newer, EPC-derived floorplans often print only a metric total - no sq ft
// conversion anywhere on the image at all (verified against several real
// floorplans reading "71m?", "Total: 56 m2" and "Total Area: 75.0 m?" -
// Tesseract misreads the "²" the same way here as it does for sq ft).
// Only trusts a number with an m²-style unit actually attached to it -
// unlike extractStatedSqFt above, there's no bare-number label-anchored
// fallback here: tried one (any number following a "gross internal area"/
// "total" label), but it produced a real false positive in testing - a
// floorplan whose sq ft total was itself unreadable ("APPROXIMATE GROSS
// INTERNAL FLOOR AREA £08 5Q FT / 75 QM", both units mangled) had the
// fallback grab "08" (part of the ruined sq ft figure sitting closer to
// the label) instead of "75" (the correct, but more distant, sqm figure).
// With no way to confirm which unit a bare number was even in, it's safer
// to find nothing here than to risk repeating that.
const SQM_UNIT_RE = /(\d[\d,]{0,4}(?:\.\d+)?)\s*(?:sq\.?\s*m\b|m2\b|m²|m\?)/gi;

function sqmToSqFt(sqm) {
  const sqft = Math.round(sqm * SQM_TO_SQFT);
  return sqft >= MIN_PLAUSIBLE_SQFT && sqft <= MAX_PLAUSIBLE_SQFT ? sqft : null;
}

function extractStatedSqMTotal(text) {
  const matches = [];
  let match;
  SQM_UNIT_RE.lastIndex = 0;
  while ((match = SQM_UNIT_RE.exec(text)) !== null) {
    const sqft = sqmToSqFt(Number(match[1].replace(/,/g, '')));
    if (sqft === null) continue;
    matches.push({ value: sqft, context: contextFor(text, match.index) });
  }
  return pickBestTotal(matches);
}

// Fallback for floorplans with no stated total at all (or one too garbled
// to read - e.g. "SQ FT" misread as "OFT", losing both unit letters):
// individual room dimensions like "3.50m x 3.11m" are usually still
// legible even then, so sum their areas for a rough estimate instead.
// Deliberately only matches the metric pairing (requires a literal "m"),
// even though many floorplans also print the same room in feet/inches
// ("13'1" x 16'0"") right next to it - matching both would double-count
// every room. This tends to run a bit low rather than high: hallways and
// storage cupboards aren't always given their own dimensions, so are
// simply left out of the sum rather than guessed at.
const ROOM_DIM_RE = /(\d+(?:\.\d+)?)\s*m?\s*x\s*(\d+(?:\.\d+)?)\s*m\b/gi;
const MIN_ROOMS_FOR_ESTIMATE = 3;
// Real UK room dimensions essentially never fall outside this range per
// side. Necessary, not just a nicety: verified against a real garbled OCR
// read where a decimal point got dropped ("3.55m" -> "355m" - a stray
// digit merging into what should have been "3.55"), turning one nonsense
// "room" into 1420 m² and completely dominating the sum. Bounding each
// room individually (not just the final total) catches this at the
// source instead of letting one bad match corrupt an otherwise-fine
// estimate.
const MIN_ROOM_DIM_M = 0.5;
const MAX_ROOM_DIM_M = 15;
const MAX_ROOM_AREA_SQM = 100;

function estimateSqFtFromRooms(text) {
  let totalSqM = 0;
  let roomCount = 0;
  let match;
  ROOM_DIM_RE.lastIndex = 0; // stateful (global) regex - reset before each use
  while ((match = ROOM_DIM_RE.exec(text)) !== null) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a < MIN_ROOM_DIM_M || a > MAX_ROOM_DIM_M || b < MIN_ROOM_DIM_M || b > MAX_ROOM_DIM_M) continue;
    const area = a * b;
    if (area > MAX_ROOM_AREA_SQM) continue;
    totalSqM += area;
    roomCount++;
  }
  if (roomCount < MIN_ROOMS_FOR_ESTIMATE) return null;
  const sqft = Math.round(totalSqM * SQM_TO_SQFT);
  if (sqft < MIN_PLAUSIBLE_SQFT || sqft > MAX_PLAUSIBLE_SQFT) return null;
  return sqft;
}

// Fetches the image ourselves (rather than letting Tesseract fetch the URL
// internally) so its actual pixel dimensions can be sanity-checked first -
// if the thumbnail-to-full-resolution URL upgrade in background.js didn't
// land for some reason, OCR would otherwise run silently on a ~300px-wide
// thumbnail, which is too small to read reliably and just looks like
// "OCR found nothing" from the outside.
const MIN_PLAUSIBLE_WIDTH = 400;

async function fetchImage(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching floorplan image`);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { blob, size };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'OCR_FLOORPLAN') return false;
  (async () => {
    try {
      const { blob, size } = await fetchImage(msg.imageUrl);
      if (size.width < MIN_PLAUSIBLE_WIDTH) {
        sendResponse({
          sqft: null,
          error: `floorplan image is only ${size.width}x${size.height}px - too small to read reliably (expected a full-resolution image, likely got a thumbnail)`,
        });
        return;
      }
      const worker = await getWorker();
      const { data } = await worker.recognize(blob);
      const text = data.text || '';
      const stated = extractStatedSqFt(text) ?? extractStatedSqMTotal(text);
      const roomSum = stated === null ? estimateSqFtFromRooms(text) : null;
      sendResponse({
        sqft: stated !== null ? stated : roomSum,
        source: stated !== null ? 'stated' : roomSum !== null ? 'roomSum' : null,
        // Only read by the caller for one sample listing per scrape (see
        // background.js) - lets a "found nothing" outcome be distinguished
        // from "read garbage/blank" without logging this for every listing.
        debug: { blobSize: blob.size, width: size.width, height: size.height, textLength: text.length, textPreview: text.slice(0, 200) },
      });
    } catch (e) {
      sendResponse({ sqft: null, error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});
