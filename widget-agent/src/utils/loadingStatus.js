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
  navigating: 'The browser agent is navigating...',
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
// Serious public-website intents (forms, documents, requests, onboarding, complaints, agency,
// online banking). Mirrors the backend browser-use gate so the loading copy matches the real route.
const BROWSER_AGENT_RE =
  /\b(form|formulaire|document|dossier|fichier|pdf|t[ée]l[ée]charger|download|export|request|demande|apply|application|onboard|become\s+(?:an?\s+)?(?:atb\s+)?(?:customer|client|member)|devenir\s+(?:client|membre)|open\s+(?:an?\s+)?account|ouvrir\s+(?:un\s+)?compte|credit\s+card|debit\s+card|bank\s+card|carte\s+bancaire|carte\b|complaint|r[ée]clamation|plainte|problem|probl[èe]me|support|agency|agence|branch|locator|atm|distributeur|online\s+banking|e-?banking|espace\s+client|official|navigate)\b/i;
const PAGE_INSPECT_RE =
  /\b(highlight|scroll\s+to|summari[sz]e|what(?:'?s| is| are)\s+(?:on\s+)?(?:this\s+)?(?:page|visible|here|shown)|what\s+sections?|what\s+links?)\b/i;
const DOCUMENT_RE =
  /\b(statement|notice|certificate|policy|guide|bill|invoice)\b/;
const BROWSE_RE =
  /\b(find|search|look\s+for|explore|navigate|browse|scan|check\s+out|visit|inspect|what\s+(is|are|does|do|can)|how\s+(does|do|can)|where\s+(is|are|can)|tell\s+me\s+about|show\s+me|list|describe|explain|summarize)\b/i;
const PAGE_RE =
  /\b(page|site|website|demo|homepage|menu|section|feature|option|content|widget|service|product|offer|available|information|detail)\b/i;

export function selectLoadingSequence({ message = '', hasFiles = false } = {}) {
  const text = String(message || '').toLowerCase();

  if (IMAGE_RE.test(text)) {
    return [LOADING_STATUS.searching, LOADING_STATUS.extractingImage, LOADING_STATUS.preparing];
  }
  if (hasFiles) {
    return [LOADING_STATUS.searching, LOADING_STATUS.readingDocument, LOADING_STATUS.preparing];
  }
  // Browser-use intents first (forms/documents/navigation) unless it's a lightweight inspect ask.
  if (BROWSER_AGENT_RE.test(text) && !PAGE_INSPECT_RE.test(text)) {
    return BROWSER_AGENT_SEQUENCE;
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
