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
// out with a decimal. Tesseract also reliably misreads the "²" as "?"
// (verified against real floorplan images), so that's accepted as an
// equivalent marker specifically in the ft-only form.
const SQFT_RE = /(\d[\d,]{0,6}(?:\.\d+)?)\s*(?:sq\.?\s*ft\b|sq\.?\s*feet\b|ft\.?\s*[²2?])/i;
const MIN_PLAUSIBLE_SQFT = 50;
const MAX_PLAUSIBLE_SQFT = 20000;

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

// UK floorplans conventionally print the total ("Gross Internal Area")
// figure first, near the top, with per-floor/per-room breakdowns (which
// sum to it) appearing further down - so the first plausible "NNN sq ft"
// match in reading order is taken as the total, rather than trying to
// semantically distinguish a total from a sub-total.
function extractStatedSqFt(text) {
  const m = text.match(SQFT_RE);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(value) || value < MIN_PLAUSIBLE_SQFT || value > MAX_PLAUSIBLE_SQFT) return null;
  return value;
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
const SQM_TO_SQFT = 10.7639;
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
      const stated = extractStatedSqFt(text);
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
