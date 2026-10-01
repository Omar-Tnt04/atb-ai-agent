const assert = require('node:assert/strict');
const { currentDestination } = require('../src/services/currentDestination.service');
const old = {url:'https://atb.tn/produits/services-ATBPAY-presentation.php', sourceFile:'captured-context'};
const result = currentDestination(old);
assert.equal(result.sourceUrl, old.url);
assert.equal(result.url, 'https://atb.tn/particuliers/banque-a-distance/atb-pay');
assert.equal(result.sourceFile, old.sourceFile);
assert.equal(old.sourceUrl, undefined);
for (const url of ['https://atb.tn.evil.example/produits/services-ATBPAY-presentation.php', 'https://atb.tn/unrelated', 'javascript:alert(1)', old.url+'?q=x']) {
  const link = {url}; assert.equal(currentDestination(link), link);
}
assert.equal(currentDestination(null), null);
console.log('Verified destination mapping checks passed');
