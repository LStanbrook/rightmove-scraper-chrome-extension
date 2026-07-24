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

const SQFT_RE = /(\d[\d,]{1,6})\s*sq\.?\s*ft\b/i;
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'OCR_FLOORPLAN') return false;
  (async () => {
    try {
      const worker = await getWorker();
      const { data } = await worker.recognize(msg.imageUrl);
      sendResponse({ sqft: extractSqFt(data.text || '') });
    } catch (e) {
      sendResponse({ sqft: null, error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});
