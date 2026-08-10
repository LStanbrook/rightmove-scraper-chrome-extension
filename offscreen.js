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
// both accepted as equivalent markers. The gap between the number and its
// unit allows at most one line break, not a full blank-line block gap -
// necessary, not just tidy: verified against a real table-style floorplan
// where a plain \s* wrongly bridged "73.7" (actually its sq.m figure) all
// the way down to an unrelated "sq.ft" label two blocks later, belonging
// to a different, unreadable number.
const SQFT_RE = /(\d[\d,]{0,6}(?:\.\d+)?)[ \t]*\n?[ \t]*(?:[s5][qo]\.?\s*ft\b|[s5][qo]\.?\s*feet\b|ft\.?\s*[²2?])/gi;
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
      // Canvas-exported PNGs (see upscaleIfSmall below) carry no DPI
      // metadata, so Tesseract's underlying engine auto-estimates one for
      // every image and logs "Estimating resolution as NNN" to the console
      // each time - harmless, but noisy. Fixing it to a plausible value
      // skips that estimation step (and the log line) entirely.
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT, user_defined_dpi: '300' });
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
// a bare-number label-anchored fallback was tried here too (any number
// following a "gross internal area"/"total" label), but it produced a
// real false positive in testing - a floorplan whose sq ft total was
// itself unreadable ("APPROXIMATE GROSS INTERNAL FLOOR AREA £08 5Q FT /
// 75 QM", both units mangled) had the fallback grab "08" (part of the
// ruined sq ft figure sitting closer to the label) instead of "75" (the
// correct, but more distant, sqm figure) - that label alone can't say
// which unit a nearby bare number is even in. Same line-break cap between
// number and unit as SQFT_RE above, for the same reason.
const SQM_UNIT_RE = /(\d[\d,]{0,4}(?:\.\d+)?)[ \t]*\n?[ \t]*(?:sq\.?\s*m\b|m2\b|m²|m\?)/gi;
// A narrower table-style layout instead puts the "sq.m" label on its own
// line, with the value following after (verified against a real
// new-build-style floorplan reading "sq.m\n\n73.7\n\nsq.ft\n\nM3" - the sq
// ft figure itself is unrecoverable, but "sq.m" is safe to anchor on where
// "gross internal area"/"total" weren't: it's the unit itself, not a
// generic label that could be sitting next to either unit's figure. Even
// so, this produced its own real false positive: a floorplan whose actual
// total was entirely unreadable ("471 sq[garbled]... Sue sqm") had the
// wide 20-char lookahead skip clean past several room labels and grab an
// unrelated "11" from the next room's "11'3" imperial dimension, reporting
// it as 11 sqm (118 sq ft) instead of finding nothing. Tightened to 8
// chars - comfortably more than the 2-char gap the real working case
// needs - and rejects a number immediately followed by a foot-mark, since
// that's specifically what a room's imperial width/length looks like.
const SQM_LABEL_RE = /sq\.?\s*m\b\D{0,8}?(\d[\d,]{0,4}(?:\.\d+)?)(?!['’])/i;
// A UK floorplan's overall total is conventionally given to one decimal
// place ("50.9 m²"), and Tesseract dropping that specific character is a
// real, recurring failure - verified against two separate real floorplans
// where "50.9" and "73.7" both came out as plain "509" and "737". Reporting
// either literally (as ~5479 or ~793 sq ft rather than the correct ~548 or
// ~793) is exactly the kind of confidently-wrong number this file otherwise
// goes out of its way to avoid, so a 3-digit whole-number reading too big
// for an un-rounded total to plausibly need is instead reinterpreted with
// the decimal restored one digit from the end.
const NO_DECIMAL_MAX_SQM = 200;

function recoverSqm(raw) {
  const value = Number(raw);
  if (raw.includes('.') || raw.length !== 3 || value <= NO_DECIMAL_MAX_SQM) return value;
  return value / 10;
}

function sqmToSqFt(sqm) {
  const sqft = Math.round(sqm * SQM_TO_SQFT);
  return sqft >= MIN_PLAUSIBLE_SQFT && sqft <= MAX_PLAUSIBLE_SQFT ? sqft : null;
}

function extractStatedSqMTotal(text) {
  const matches = [];
  let match;
  SQM_UNIT_RE.lastIndex = 0;
  while ((match = SQM_UNIT_RE.exec(text)) !== null) {
    const sqft = sqmToSqFt(recoverSqm(match[1].replace(/,/g, '')));
    if (sqft === null) continue;
    matches.push({ value: sqft, context: contextFor(text, match.index) });
  }
  const best = pickBestTotal(matches);
  if (best !== null) return best;
  const labelMatch = text.match(SQM_LABEL_RE);
  return labelMatch ? sqmToSqFt(recoverSqm(labelMatch[1].replace(/,/g, ''))) : null;
}

// Fallback for floorplans with no stated total at all (or one too garbled
// to read - e.g. "SQ FT" misread as "OFT", losing both unit letters):
// individual room dimensions like "3.50m x 3.11m" are usually still
// legible even then, so sum their areas for a rough estimate instead.
// Deliberately targets only the metric pairing, even though many
// floorplans also print the same room in feet/inches ("13'1" x 16'0"")
// right next to it - matching both would double-count every room. The
// literal "m" unit is captured but not required on either side: it's
// common for OCR to drop it from one or both numbers (verified against a
// real floorplan reading "7.95x3.80m", "271 1.98m" and "1287 105\"" for its
// three rooms - only the first kept its unit letter). A pair with no unit
// at all is still accepted, but only when BOTH numbers are decimals - genuine
// metric readings are always written with a decimal point ("3.78m"), while
// this floorplan's feet-inches pairing OCRs as glued whole-number inches
// ("128\"x 105\"") with no decimal point anywhere, so requiring one is
// enough to keep the two apart without relying on the unit letter at all.
// The separator also tolerates a stray "/" next to the "x" (verified
// against a real floorplan reading "2.25m x/1.10m" - Tesseract sometimes
// picks up a fragment of the nearby feet-inches reading's punctuation),
// as long as an actual "x" is still present.
const ROOM_DIM_RE = /(\d+(?:\.\d+)?)(m)?[ \t/]*x[ \t/]*(\d+(?:\.\d+)?)(m)?\b/gi;
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

// Room dimensions are conventionally given to two decimal places
// ("3.78m"), and losing that decimal is the single biggest reason real
// floorplans with clearly-printed dimensions still produce no estimate:
// verified against two real floorplans where 5 of 7 rooms and 4 of 6 rooms
// respectively lost their decimal on one side ("4.58" -> "458" etc.),
// dropping the whole floorplan below the 3-room minimum even though every
// room was legible on the image itself. A 3-digit whole-number reading
// that's implausible as-is is reinterpreted with the decimal restored two
// digits from the end (matching that two-decimal-place convention) if
// doing so lands it back in a plausible range - checked empirically
// against both floorplans' true dimensions and correct in every case.
function recoverRoomDim(str) {
  const value = Number(str);
  if (str.includes('.') || value <= MAX_ROOM_DIM_M || str.length !== 3) return value;
  const shifted = value / 100;
  return shifted >= MIN_ROOM_DIM_M ? shifted : value;
}

function estimateSqFtFromRooms(text) {
  let totalSqM = 0;
  let roomCount = 0;
  let match;
  ROOM_DIM_RE.lastIndex = 0; // stateful (global) regex - reset before each use
  while ((match = ROOM_DIM_RE.exec(text)) !== null) {
    const aStr = match[1];
    const bStr = match[3];
    const hasUnit = match[2] != null || match[4] != null;
    if (!hasUnit && !(aStr.includes('.') && bStr.includes('.'))) continue;
    const a = recoverRoomDim(aStr);
    const b = recoverRoomDim(bStr);
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
// "OCR found nothing" from the outside. Below this, it's not a genuine
// full-resolution floorplan at all - just abandoned rather than upscaled.
const MIN_PLAUSIBLE_WIDTH = 100;
// Some real floorplans (particularly newer, stylised new-build templates)
// simply don't have a larger source image available at all - Rightmove
// itself only ever serves the small one. Verified against a real 370px-
// wide example whose small size table read as pure noise at native
// resolution, but came through cleanly (correctly keeping the decimal
// point in "73.7") once upscaled 4x to ~1480px - 3x wasn't quite enough
// and still lost the decimal. Already-large floorplans are left alone:
// this only kicks in below the target width, so the common case pays no
// extra OCR time for it.
const TARGET_OCR_WIDTH = 1500;
const MAX_UPSCALE = 4;

async function upscaleIfSmall(blob, size) {
  if (size.width >= TARGET_OCR_WIDTH) return blob;
  const scale = Math.min(MAX_UPSCALE, Math.ceil(TARGET_OCR_WIDTH / size.width));
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = size.width * scale;
  canvas.height = size.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

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
          error: `floorplan image is only ${size.width}x${size.height}px - too small to be a real floorplan (likely a broken or placeholder image)`,
        });
        return;
      }
      const worker = await getWorker();
      const { data: nativeData } = await worker.recognize(blob);
      const nativeText = nativeData.text || '';
      // Upscaling helps genuinely small images, but was found (via a real
      // floorplan already a comfortable 1200px wide) to sometimes blur an
      // already-readable image just enough to break it - it read a clean
      // "471 sq ft" at native resolution but lost the figure entirely once
      // upscaled. So native resolution is always tried too, not skipped in
      // favour of upscaling.
      let upscaledText = null;
      if (size.width < TARGET_OCR_WIDTH) {
        const ocrBlob = await upscaleIfSmall(blob, size);
        const upscaledData = await worker.recognize(ocrBlob);
        upscaledText = upscaledData.data.text || '';
      }
      // For a stated total, the two OCR passes' candidates are merged
      // (rather than trying one, then only falling back to the other on a
      // total miss) - checked against two real floorplans where a
      // low-quality read of one pass "succeeded" by cleanly finding a
      // smaller, wrong figure (an annex, a per-floor subtotal) while
      // missing the real total's text entirely, silently masking the
      // correct answer the other pass would have found. Simply
      // concatenating both texts lets the existing internal/excluded
      // candidate logic in extractStatedSqFt/extractStatedSqMTotal weigh
      // every figure either pass found, exactly as if they'd all appeared
      // on one longer floorplan.
      const combinedText = upscaledText !== null ? nativeText + '\n\n' + upscaledText : nativeText;
      const stated = extractStatedSqFt(combinedText) ?? extractStatedSqMTotal(combinedText);
      // Room-sum estimates are NOT merged the same way - unlike picking the
      // best single total, summing rooms from both passes would double-
      // count every room read at both resolutions. Each pass's own room
      // reading is tried as a separate, independent attempt instead.
      const roomSum =
        stated === null
          ? (estimateSqFtFromRooms(nativeText) ?? (upscaledText !== null ? estimateSqFtFromRooms(upscaledText) : null))
          : null;
      sendResponse({
        sqft: stated !== null ? stated : roomSum,
        source: stated !== null ? 'stated' : roomSum !== null ? 'roomSum' : null,
        // Only read by the caller for one sample listing per scrape (see
        // background.js) - lets a "found nothing" outcome be distinguished
        // from "read garbage/blank" without logging this for every listing.
        debug: { blobSize: blob.size, width: size.width, height: size.height, textLength: combinedText.length, textPreview: combinedText.slice(0, 200) },
      });
    } catch (e) {
      sendResponse({ sqft: null, error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});
