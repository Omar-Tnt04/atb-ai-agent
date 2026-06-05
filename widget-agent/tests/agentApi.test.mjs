import assert from 'node:assert/strict';
import { normalizeAgentResponse } from '../src/services/agentApi.js';

const response = normalizeAgentResponse({
  success: true,
  status: 'resource_metadata',
  assistantMessage: 'I found your Credit Card Limit Notice.',
  data: {
    actions: [
      {
        type: 'download_pdf',
        label: 'Download PDF',
        resourceId: 'credit-card-limit',
        title: 'Credit Card Limit Notice',
        downloadUrl: '/resources/download/0123456789abcdef0123456789abcdef',
      },
    ],
    ai: {
      toolInput: {},
    },
  },
});

assert.equal(response.quickActions.length, 1);
assert.equal(response.quickActions[0].action, 'download');
assert.equal(response.quickActions[0].label, 'Download PDF');
assert.equal(
  response.quickActions[0].url,
  'http://localhost:5000/resources/download/0123456789abcdef0123456789abcdef',
);

const rawLaragonResponse = normalizeAgentResponse({
  success: true,
  status: 'resource_metadata',
  assistantMessage: 'I found your Credit Card Limit Notice.',
  data: {
    actions: [
      {
        type: 'download_pdf',
        label: 'Download PDF',
        downloadUrl: 'http://localhost:9000/atb-general-resources/documents/raw.pdf',
      },
    ],
  },
});

assert.equal(rawLaragonResponse.quickActions.length, 0);

console.log('widget agentApi tests passed');
