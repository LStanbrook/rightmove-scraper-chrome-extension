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

// Two conventions show up on real Rightmove floorplans: "624 sq ft" and,
// just as commonly, "567 ft²" with no "sq" at all. Tesseract also reliably
// misreads the "²" as "?" (verified against real floorplan images), so
// that's accepted as an equivalent marker specifically in the ft-only form.
const SQFT_RE = /(\d[\d,]{1,6})\s*(?:sq\.?\s*ft\b|ft\.?\s*[²2?])/i;
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
    });
  }
  return workerPromise;
}

// UK floorplans conventionally print the total ("Gross Internal Area")
// figure first, near the top, with per-floor/per-room breakdowns (which
// sum to it) appearing further down - so the first plausible "NNN sq ft"
// match in reading order is taken as the total, rather than trying to
// semantically distinguish a total from a sub-total.
function extractSqFt(text) {
  const m = text.match(SQFT_RE);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(value) || value < MIN_PLAUSIBLE_SQFT || value > MAX_PLAUSIBLE_SQFT) return null;
  return value;
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
      sendResponse({
        sqft: extractSqFt(text),
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
