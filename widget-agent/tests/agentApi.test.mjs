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

const imageResponse = normalizeAgentResponse({
  success: true,
  status: 'resource_metadata',
  assistantMessage: 'I found your QR Merchant Payment Receipt.',
  data: {
    actions: [
      {
        action: 'open',
        type: 'view_image',
        label: 'View image',
        resourceId: '01_QR_MERCHANT_PAYMENT_RECEIPT',
        title: 'QR Merchant Payment Receipt',
        viewUrl: '/resources/view/abcdefabcdefabcdefabcdefabcdefab',
      },
    ],
  },
});

assert.equal(imageResponse.quickActions.length, 1);
assert.equal(imageResponse.quickActions[0].action, 'open_url');
assert.equal(imageResponse.quickActions[0].label, 'View image');
assert.equal(
  imageResponse.quickActions[0].url,
  'http://localhost:5000/resources/view/abcdefabcdefabcdefabcdefabcdefab',
);

console.log('widget agentApi tests passed');
