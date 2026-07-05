// Smooth, route-aware loading statuses (in "-ing" form) shown while the agent works, instead
// of a generic three-dot / "Thinking" indicator. The sequence is a best-effort guess from the
// request, since the backend route is only known once the response arrives.
export const LOADING_STATUS = {
  searching: 'Searching resources...',
  readingDocument: 'Reading document...',
  extractingImage: 'Extracting image text...',
  generating: 'Generating document...',
  preparing: 'Preparing answer...',
};

const IMAGE_RE = /\b(image|photo|picture|receipt|scan|scanned|qr|screenshot|jpe?g|png|webp)\b/;
const GENERATE_RE = /\b(generate|create|produce|export|report|csv)\b/;
const DOCUMENT_RE =
  /\b(pdf|document|statement|notice|certificate|file|download|open|read|policy|guide|form|bill|invoice)\b/;

export function selectLoadingSequence({ message = '', hasFiles = false } = {}) {
  const text = String(message || '').toLowerCase();

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
  return [LOADING_STATUS.searching, LOADING_STATUS.preparing];
}

export default selectLoadingSequence;
