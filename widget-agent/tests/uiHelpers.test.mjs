import assert from 'node:assert/strict';
import { balanceMarkdown } from '../src/utils/markdownBalance.js';
import { LOADING_STATUS, selectLoadingSequence } from '../src/utils/loadingStatus.js';

// --- balanceMarkdown keeps bold rendering while text streams in ---
assert.equal(balanceMarkdown('**Status:'), '**Status:**', 'closes a dangling bold run');
assert.equal(balanceMarkdown('**Status:** Pending'), '**Status:** Pending', 'leaves balanced bold');
assert.equal(balanceMarkdown('Here is your `cod'), 'Here is your `cod`', 'closes inline code');
assert.equal(balanceMarkdown('Amount: 42 *'), 'Amount: 42 ', 'drops a trailing lone star');
assert.equal(balanceMarkdown(''), '', 'empty stays empty');
// preserves masked values untouched
assert.equal(
  balanceMarkdown('**Card:** ************4455'),
  '**Card:** ************4455',
  'masked card value untouched',
);

// --- route-aware loading statuses (in -ing form) ---
assert.deepEqual(
  selectLoadingSequence({ message: 'Read the QR merchant payment receipt image' }),
  [LOADING_STATUS.searching, LOADING_STATUS.extractingImage, LOADING_STATUS.preparing],
  'image content -> extracting image text',
);
assert.deepEqual(
  selectLoadingSequence({ message: 'Download my card statement PDF' }),
  [LOADING_STATUS.searching, LOADING_STATUS.readingDocument, LOADING_STATUS.preparing],
  'document -> reading document',
);
assert.deepEqual(
  selectLoadingSequence({ message: 'Generate my account statement', hasFiles: false }),
  [LOADING_STATUS.searching, LOADING_STATUS.generating, LOADING_STATUS.preparing],
  'generate -> generating document',
);
assert.deepEqual(
  selectLoadingSequence({ message: 'hello there' }),
  [LOADING_STATUS.searching, LOADING_STATUS.preparing],
  'default -> searching then preparing',
);
assert.deepEqual(
  selectLoadingSequence({ message: 'here is a file', hasFiles: true }),
  [LOADING_STATUS.searching, LOADING_STATUS.readingDocument, LOADING_STATUS.preparing],
  'uploaded file -> reading document',
);
// every status starts with an "-ing" verb and ends with an ellipsis
Object.values(LOADING_STATUS).forEach((status) => {
  assert.match(status, /^[A-Za-z]+ing\b/, `${status} starts with an -ing verb`);
  assert.match(status, /\.\.\.$/, `${status} ends with an ellipsis`);
});

console.log('widget uiHelpers tests passed');

for (const mode of ['ask', 'act']) {
  assert.deepEqual(selectLoadingSequence({message: 'Download an official PDF form', mode}),
    [LOADING_STATUS.searching, LOADING_STATUS.preparing],
    'A keyword alone must not claim that a browser action has started');
}
