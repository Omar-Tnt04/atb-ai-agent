'use strict';
require('dotenv').config();
const OpenAI = require('openai');

const { OPENROUTER_API_KEY, ASK_MODE_MODEL } = process.env;

if (!OPENROUTER_API_KEY) {
  console.error(
    '[test-openrouter-model] Missing OPENROUTER_API_KEY.\n' +
      'Set it in backend-node/.env, e.g.:\n' +
      '  OPENROUTER_API_KEY=sk-or-...\n' +
      '  ASK_MODE_MODEL=google/gemma-4-31b-it:free'
  );
  process.exit(1);
}

const client = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

async function main() {
  const model = ASK_MODE_MODEL || 'google/gemma-4-31b-it:free';
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: OpenRouter model connection works.' }],
  });

  console.log(response.choices[0].message.content);
}

main().catch((err) => {
  console.error('[test-openrouter-model] Request failed:', err.message);
  process.exit(1);
});
