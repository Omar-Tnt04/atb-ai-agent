// Smooth, route-aware loading statuses (in "-ing" form) shown while the agent works, instead
// of a generic three-dot indicator. The sequence is a best-effort guess from the request,
// since the backend route is only known once the response arrives.
export const LOADING_STATUS = {
  searching: 'Searching resources...',
  readingDocument: 'Reading document...',
  extractingImage: 'Extracting image text...',
  generating: 'Generating document...',
  preparing: 'Preparing answer...',
  browsing: 'Checking the page now...',
  openingPage: 'Opening the relevant ATB page...',
  findingForm: 'Looking for the right form...',
  checkingDocs: 'Checking official documents...',
  navigating: 'Navigating in the browser...',
};

// Steps shown while the REAL browser-use agent drives Chrome. Kept here so the cycling status reads
// naturally during the (slow) navigation rather than sitting on a generic spinner.
export const BROWSER_AGENT_SEQUENCE = [
  LOADING_STATUS.openingPage,
  LOADING_STATUS.navigating,
  LOADING_STATUS.findingForm,
  LOADING_STATUS.checkingDocs,
];

const IMAGE_RE = /\b(image|photo|picture|receipt|scan|scanned|qr|screenshot|jpe?g|png|webp)\b/;
const GENERATE_RE = /\b(generate|create|produce|report|csv)\b/;
const DOCUMENT_RE =
  /\b(pdf|document|statement|notice|certificate|policy|guide|bill|invoice)\b/;
const BROWSE_RE =
  /\b(find|search|look\s+for|explore|navigate|browse|scan|check\s+out|visit|inspect|what\s+(is|are|does|do|can)|how\s+(does|do|can)|where\s+(is|are|can)|tell\s+me\s+about|show\s+me|list|describe|explain|summarize)\b/i;
const PAGE_RE =
  /\b(page|site|website|demo|homepage|menu|section|feature|option|content|widget|service|product|offer|available|information|detail)\b/i;

export function selectLoadingSequence({ message = '', hasFiles = false, mode = 'auto' } = {}) {
  const text = String(message || '').toLowerCase();
  // Before a response identifies an executing job, do not claim browser activity.
  if (mode === 'ask' || mode === 'act') {
    return [LOADING_STATUS.searching, LOADING_STATUS.preparing];
  }

  if (IMAGE_RE.test(text)) {
    return [LOADING_STATUS.searching, LOADING_STATUS.extractingImage, LOADING_STATUS.preparing];
  }
  if (hasFiles) {
    return [LOADING_STATUS.searching, LOADING_STATUS.readingDocument, LOADING_STATUS.preparing];
  }
  if (GENERATE_RE.test(text)) {
    return [LOADING_STATUS.searching, LOADING_STATUS.generating, LOADING_STATUS.preparing];
  }
  if (DOCUMENT_RE.test(text)) {
    return [LOADING_STATUS.searching, LOADING_STATUS.readingDocument, LOADING_STATUS.preparing];
  }
  if (BROWSE_RE.test(text) && PAGE_RE.test(text)) {
    return [LOADING_STATUS.browsing, LOADING_STATUS.preparing];
  }
  return [LOADING_STATUS.searching, LOADING_STATUS.preparing];
}

export default selectLoadingSequence;
