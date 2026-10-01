// Public destination verified on 2026-09-08; preserve historical source provenance.
function currentDestination(link) {
  if (!link || !link.url) return link;
  let parsed;
  try { parsed = new URL(link.url); } catch { return link; }
  if (!['https:', 'http:'].includes(parsed.protocol) ||
      !['atb.tn', 'www.atb.tn'].includes(parsed.hostname) ||
      parsed.pathname !== '/produits/services-ATBPAY-presentation.php' || parsed.search) return link;
  return { ...link, sourceUrl: link.sourceUrl || link.url,
    url: 'https://atb.tn/particuliers/banque-a-distance/atb-pay',
    destinationVerifiedAt: '2026-09-08' };
}
module.exports = { currentDestination };
