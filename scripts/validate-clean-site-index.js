function validateCleanIndex(index) {
  const errors = [];
  const host = value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : ''; } catch { return ''; } };
  const expectedHost = host(index.meta?.targetUrl);
  if (!expectedHost) errors.push('meta.targetUrl must be an HTTP(S) URL');
  for (const [key, identity, countKey] of [['pages','url','pagesCrawled'],['uniqueDocuments','documentUrl','uniqueDocumentsFound'],['uniqueDocumentActions','linkText','uniqueDocumentActionsFound']]) {
    const items = index[key];
    if (!Array.isArray(items)) { errors.push(key + ' must be an array'); continue; }
    if (index.cleanStats?.[countKey] !== items.length) errors.push('cleanStats.' + countKey + ' does not match ' + key);
    const seen = new Set();
    for (const [i,item] of items.entries()) {
      const id=item?.[identity];
      if (!id || typeof id !== 'string') errors.push(key+'['+i+'] missing identity');
      if (identity !== 'linkText' && (!host(id) || (key === 'pages' && host(id) !== expectedHost))) errors.push(key+'['+i+'] invalid or off-domain URL');
      if (seen.has(id)) errors.push(key+'['+i+'] duplicate identity');
      seen.add(id);
      if (key === 'pages' && typeof item.title !== 'string') errors.push(key+'['+i+'] missing title');
      if (key !== 'pages') {
        if (key === 'uniqueDocuments' && !item.filename) errors.push(key+'['+i+'] missing filename');
        if (!Array.isArray(item.sourcePages) || !item.sourcePages.length || item.sourcePages.length>10) errors.push(key+'['+i+'] invalid sourcePages');
        else if (item.sourcePages.some(x=>host(x)!==expectedHost)) errors.push(key+'['+i+'] off-domain source page');
        if (!Number.isInteger(item.occurrencesCount) || item.occurrencesCount < (item.sourcePages?.length || 0)) errors.push(key+'['+i+'] invalid occurrencesCount');
      }
    }
  }
  return errors;
}
module.exports = { validateCleanIndex };
