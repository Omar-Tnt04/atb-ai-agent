const assert = require('node:assert/strict');
const { greetingResponse } = require('../src/services/greeting.service');
assert.match(greetingResponse(' Bonjour ! '), /^Bonjour/);
assert.match(greetingResponse('Hi there!'), /^Hello/);
for (const query of ['Bonjour, quels services propose ATB PAY ?', 'hello show me the contact page', 'salut comment contacter ATB', '', 'payment']) assert.equal(greetingResponse(query), null, 'Do not swallow a substantive request');
console.log('Greeting regression checks passed');
