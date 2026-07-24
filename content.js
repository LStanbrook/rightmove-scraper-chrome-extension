// Runs on Rightmove search-results pages. Rightmove server-renders each page's
// results into a <script id="__NEXT_DATA__"> JSON blob (Next.js hydration data) -
// that already contains price, beds, baths, tenure, size, agent, key features etc.
// for every card on the page, so we just read it straight out of the DOM.

function readSearchResults() {
  const el = document.getElementById('__NEXT_DATA__');
  if (!el) return null;
  let data;
  try {
    data = JSON.parse(el.textContent);
  } catch (e) {
    return null;
  }
  return data?.props?.pageProps?.searchResults || null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_SEARCH_RESULTS') {
    sendResponse({ searchResults: readSearchResults(), url: location.href });
  }
  return true;
});
