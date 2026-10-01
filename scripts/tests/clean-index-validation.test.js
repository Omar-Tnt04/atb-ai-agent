const assert = require('node:assert/strict');
const {cleanSiteIndex, deduplicatePages}=require('../lib/site-index-clean');
const {validateCleanIndex}=require('../validate-clean-site-index');
const good=cleanSiteIndex({meta:{targetUrl:'https://atb.tn'},pages:[{url:'https://atb.tn/a',title:'',headings:[],textPreview:'A',documentLinks:[{documentUrl:'https://www.bct.gov.tn/public.pdf',filename:'public.pdf'}]},{url:'https://atb.tn/a',title:'Observed title',textPreview:'Longer captured evidence'}]});
assert.equal(good.pages.length,1);assert.equal(good.rawStats.pagesCrawled,2);assert.equal(good.cleanStats.pagesCrawled,1);
assert.equal(good.pages[0].title,'Observed title');assert.deepEqual(validateCleanIndex(good),[]);
for(const mutate of [x=>x.cleanStats.pagesCrawled++,x=>x.pages.push(x.pages[0]),x=>x.pages[0].url='https://evil.example/a',x=>x.uniqueDocuments[0].documentUrl='javascript:alert(1)',x=>x.uniqueDocuments[0].sourcePages=[],x=>x.uniqueDocuments[0].occurrencesCount=-1]) {
 const copy=structuredClone(good);mutate(copy);assert.ok(validateCleanIndex(copy).length);
}
assert.deepEqual(deduplicatePages([]),[]);
console.log('Clean-index schema, provenance and deduplication checks passed');
