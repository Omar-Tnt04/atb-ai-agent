import { widgetRuntime, widgetStorage } from './widgetRuntime.js';
export function createPageControl() {
  var pageCtlRefs = {};
  var pageCtlCounter = 0;
  var pageCtlHighlights = [];

  function atbVisible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) {
      return false;
    }
    var style = window.getComputedStyle(el);
    return !(
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    );
  }

  function atbText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function atbAssignRef(el) {
    var ref = 'atb-ctl-' + ++pageCtlCounter;
    pageCtlRefs[ref] = el;
    return ref;
  }

  // Classify which page region an element sits in (side menu / nav / header / footer) so the
  // matcher can prioritise real navigation entry points over generic body sections. Generic —
  // based on tag, ARIA role, and class-name hints only, no site-specific selectors.
  function atbRegionKind(el) {
    var node = el;
    while (node && node !== document.body && node.nodeType === 1) {
      var tag = (node.tagName || '').toLowerCase();
      var role = ((node.getAttribute && node.getAttribute('role')) || '').toLowerCase();
      var cls = (node.className && node.className.toString
        ? node.className.toString()
        : '').toLowerCase();
      if (tag === 'aside' ||
        /(^|[\s_-])(sidebar|side-menu|sidemenu|side-nav|sidenav|left-menu|leftmenu)([\s_-]|$)/.test(cls)) {
        return 'sidebar';
      }
      if (tag === 'header' || role === 'banner') return 'header';
      if (tag === 'footer' || role === 'contentinfo') return 'footer';
      if (tag === 'nav' || role === 'navigation' || role === 'menu' || role === 'menubar' ||
        /(^|[\s_-])(nav|navbar|navigation|menu)([\s_-]|$)/.test(cls)) {
        return 'nav';
      }
      node = node.parentElement;
    }
    return 'link';
  }

  function atbInViewport(el) {
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    return r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw &&
      r.width > 0 && r.height > 0;
  }

  // ---- Safety policy (mirrors backend pageControl.service.js; loader re-validates every action) --
  // Safe document types the loader may open, and href patterns it will NEVER click/open.
  var ATB_SAFE_DOC_RE = /\.(pdf|docx?|xlsx?)(?=$|[?#])/i;
  var ATB_FORBIDDEN_HREF_RE =
    /(^javascript:|^mailto:|^tel:|\b(login|log-in|signin|sign-in|logout|log-out|deconnexion|authentification|password|mot-de-passe|motdepasse|otp|pin|payment|paiement|pay|transfer|transfert|virement|delete|supprimer|cancel|annuler|submit|valider)\b)/i;

  // Classify a link: 'document' (safe file), 'internal' (safe same-domain page), 'external',
  // 'forbidden', or 'none'. Used both for snapshot metadata and for execution-time validation.
  function atbClassifyHref(href) {
    var raw = String(href || '').trim();
    if (!raw || raw === '#') return { kind: 'none' };
    if (ATB_FORBIDDEN_HREF_RE.test(raw)) return { kind: 'forbidden' };
    var url;
    try {
      url = new URL(raw, location.href);
    } catch (e) {
      return { kind: 'none' };
    }
    if (url.protocol !== 'https:' || url.username || url.password) return { kind: 'none' };
    var internal = ['atb.tn', 'www.atb.tn'].includes(url.hostname);
    if (ATB_SAFE_DOC_RE.test(url.pathname)) {
      var m = url.pathname.match(ATB_SAFE_DOC_RE);
      var ext = (m ? m[0] : '').replace('.', '').toLowerCase();
      return { kind: internal ? 'document' : 'forbidden', fileType: ext, internal: internal, url: url.href };
    }
    if (!internal) return { kind: 'external' };
    return { kind: 'internal', internal: true, url: url.href };
  }

  // ---- Generic site-context extraction --------------------------------------------------------
  // Prefix sct* to avoid collision with existing atb* helpers above.

  function sctClean(text, maxLen) {
    var t = (text || '').replace(/\s+/g, ' ').trim();
    return maxLen ? t.slice(0, maxLen) : t;
  }

  // Relaxed visibility for read-only content (headings, text blocks): accept opacity:0 elements
  // so carousel/slider items that animate in are still captured as page content.
  // Only skips elements whose layout is fully removed (display:none parent chain).
  function sctHeadingVisible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function sctAbsUrl(href) {
    try { return new URL(href, location.href).href; } catch (e) { return ''; }
  }

  function sctFileExt(href) {
    var m = String(href || '').match(/\.(pdf|docx?|xlsx?|pptx?|zip|csv|txt)(?:[?#]|$)/i);
    return m ? m[1].toLowerCase() : '';
  }

  function sctExtractEmails(text) {
    var found = (text || '').match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
    return found.slice(0, 10);
  }

  function sctExtractPhones(text) {
    var found = (text || '').match(/(?:\+?\d[\d\s\-().]{6,14}\d)/g) || [];
    return found.slice(0, 10).map(function (p) { return p.replace(/\s+/g, ' ').trim(); });
  }

  function buildSiteContext() {
    // Headings (cap 30, text max 300 chars).
    // Uses sctHeadingVisible — allows opacity:0 so animated/slider headings are captured.
    var headings = [];
    var headingEls = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < headingEls.length && headings.length < 30; i++) {
      if (!sctHeadingVisible(headingEls[i])) continue;
      var ht = sctClean(atbText(headingEls[i]), 300);
      if (ht) headings.push({ level: parseInt(headingEls[i].tagName.slice(1), 10), text: ht });
    }

    // Text blocks — semantic paragraph elements (cap 40, 300 chars, min 20 chars, deduped).
    // Also uses sctHeadingVisible so text in animated sections is captured.
    var textBlocks = [];
    var seenTb = {};
    var tbEls = document.querySelectorAll('p,blockquote,figcaption');
    for (var j = 0; j < tbEls.length && textBlocks.length < 40; j++) {
      if (!sctHeadingVisible(tbEls[j])) continue;
      var tb = sctClean(atbText(tbEls[j]), 300);
      if (!tb || tb.length < 20 || seenTb[tb]) continue;
      seenTb[tb] = true;
      textBlocks.push(tb);
    }

    // Links (cap 80) + download links (cap 40), deduped by text+href
    var links = [];
    var downloadLinks = [];
    var seenLink = {};
    var seenDl = {};
    var linkEls = document.querySelectorAll('a[href]');
    for (var k = 0; k < linkEls.length; k++) {
      if (!atbVisible(linkEls[k])) continue;
      var lt = sctClean(atbText(linkEls[k]) || linkEls[k].getAttribute('aria-label') || '', 300);
      if (!lt) continue;
      var rawHref = linkEls[k].getAttribute('href') || '';
      var absHref = sctAbsUrl(rawHref);
      if (!absHref) continue;
      var ext = sctFileExt(absHref);
      var dedupeKey = lt + '|' + absHref;
      if (ext) {
        if (downloadLinks.length < 40 && !seenDl[dedupeKey]) {
          seenDl[dedupeKey] = true;
          downloadLinks.push({ text: lt, href: absHref, fileType: ext });
        }
      } else {
        if (links.length < 80 && !seenLink[dedupeKey]) {
          seenLink[dedupeKey] = true;
          links.push({ text: lt, href: absHref });
        }
      }
    }

    // Buttons (cap 40, deduped by text)
    var buttons = [];
    var seenBtn = {};
    var btnEls = document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]');
    for (var bi = 0; bi < btnEls.length && buttons.length < 40; bi++) {
      if (!atbVisible(btnEls[bi])) continue;
      var bt = sctClean(
        atbText(btnEls[bi]) || btnEls[bi].getAttribute('aria-label') || btnEls[bi].getAttribute('value') || '', 300);
      if (bt && !seenBtn[bt]) { seenBtn[bt] = true; buttons.push(bt); }
    }

    // Forms (cap 10) — action url, method, named field list
    var forms = [];
    var formEls = document.querySelectorAll('form');
    for (var fi = 0; fi < formEls.length && forms.length < 10; fi++) {
      if (!atbVisible(formEls[fi])) continue;
      var fieldNames = [];
      var fieldEls = formEls[fi].querySelectorAll('input[name],select[name],textarea[name]');
      for (var ff = 0; ff < fieldEls.length; ff++) {
        var fname = sctClean(
          fieldEls[ff].getAttribute('name') ||
          fieldEls[ff].getAttribute('placeholder') ||
          fieldEls[ff].getAttribute('aria-label') || '', 80);
        if (fname) fieldNames.push(fname);
      }
      forms.push({
        action: sctAbsUrl(formEls[fi].getAttribute('action') || ''),
        method: (formEls[fi].getAttribute('method') || 'get').toLowerCase(),
        fields: fieldNames,
      });
    }

    // Contact facts — scan full body text for emails and phone numbers
    var bodyText = document.body ? sctClean(atbText(document.body), 0) : '';
    var contactFacts = {
      emails: sctExtractEmails(bodyText),
      phones: sctExtractPhones(bodyText),
    };

    var stats = {
      headings: headings.length,
      textBlocks: textBlocks.length,
      links: links.length,
      downloadLinks: downloadLinks.length,
      buttons: buttons.length,
      forms: forms.length,
      textLength: textBlocks.reduce(function (s, t) { return s + t.length; }, 0),
    };

    return {
      source: 'dom',
      url: location.href,
      origin: location.origin,
      title: document.title || '',
      language: document.documentElement.getAttribute('lang') || '',
      timestamp: Date.now(),
      headings: headings,
      textBlocks: textBlocks,
      links: links,
      downloadLinks: downloadLinks,
      buttons: buttons,
      forms: forms,
      contactFacts: contactFacts,
      stats: stats,
    };
  }
  // -------------------------------------------------------------------------------------------

  function buildPageSnapshot() {
    pageCtlRefs = {};
    pageCtlCounter = 0;

    var headings = [];
    var headingEls = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < headingEls.length; i++) {
      if (!atbVisible(headingEls[i])) continue;
      var ht = atbText(headingEls[i]);
      if (!ht) continue;
      headings.push({
        ref: atbAssignRef(headingEls[i]),
        tag: headingEls[i].tagName.toLowerCase(),
        text: ht.slice(0, 160),
      });
    }

    var sections = [];
    var sectionEls = document.querySelectorAll(
      'section,article,[role="region"],main,aside,nav',
    );
    for (var j = 0; j < sectionEls.length; j++) {
      if (!atbVisible(sectionEls[j])) continue;
      var heading = sectionEls[j].querySelector('h1,h2,h3,h4,h5,h6');
      var label = heading
        ? atbText(heading)
        : sectionEls[j].getAttribute('aria-label') ||
          sectionEls[j].id ||
          sectionEls[j].tagName.toLowerCase();
      sections.push({
        ref: atbAssignRef(sectionEls[j]),
        tag: sectionEls[j].tagName.toLowerCase(),
        id: sectionEls[j].id || '',
        label: (label || '').slice(0, 160),
        text: atbText(sectionEls[j]).slice(0, 280),
      });
    }

    var links = [];
    var linkEls = document.querySelectorAll('a[href]');
    for (var k = 0; k < linkEls.length && links.length < 120; k++) {
      if (!atbVisible(linkEls[k])) continue;
      var lt = atbText(linkEls[k]) ||
        linkEls[k].getAttribute('aria-label') ||
        linkEls[k].getAttribute('title') || '';
      lt = lt.replace(/\s+/g, ' ').trim();
      if (!lt) continue;
      var href = linkEls[k].getAttribute('href') || '';
      var cls = atbClassifyHref(href);
      links.push({
        ref: atbAssignRef(linkEls[k]),
        type: 'link',
        kind: atbRegionKind(linkEls[k]),
        tag: 'a',
        text: lt.slice(0, 80),
        href: href.slice(0, 200),
        samePage: href.charAt(0) === '#',
        fileType: cls.fileType || '',
        external: cls.kind === 'external' || cls.kind === 'forbidden',
      });
    }

    // Menu items / role-based links that aren't <a> (common in SPA side menus) — so they get a
    // ref and can be highlighted too, not just anchors.
    var menuEls = document.querySelectorAll('[role="menuitem"],[role="link"],[role="tab"]');
    for (var n = 0; n < menuEls.length && links.length < 160; n++) {
      if (menuEls[n].tagName === 'A') continue;
      if (!atbVisible(menuEls[n])) continue;
      var mt = (atbText(menuEls[n]) || menuEls[n].getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ').trim();
      if (!mt) continue;
      links.push({
        ref: atbAssignRef(menuEls[n]),
        type: 'menuitem',
        kind: atbRegionKind(menuEls[n]),
        tag: menuEls[n].tagName.toLowerCase(),
        text: mt.slice(0, 80),
        href: '',
        samePage: false,
      });
    }

    var buttons = [];
    var buttonEls = document.querySelectorAll('button,[role="button"]');
    for (var m = 0; m < buttonEls.length && buttons.length < 40; m++) {
      if (!atbVisible(buttonEls[m])) continue;
      var bt = (atbText(buttonEls[m]) || buttonEls[m].getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ').trim();
      if (!bt) continue;
      buttons.push({
        ref: atbAssignRef(buttonEls[m]),
        type: 'button',
        kind: atbRegionKind(buttonEls[m]),
        tag: buttonEls[m].tagName.toLowerCase(),
        text: bt.slice(0, 80),
      });
    }

    return {
      url: location.href,
      title: document.title || '',
      headings: headings,
      sections: sections,
      links: links,
      buttons: buttons,
    };
  }

  function atbHighlight(el) {
    var saved = {
      el: el,
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
      boxShadow: el.style.boxShadow,
      background: el.style.backgroundColor,
      borderRadius: el.style.borderRadius,
      transition: el.style.transition,
      zIndex: el.style.zIndex,
      position: el.style.position,
    };
    pageCtlHighlights.push(saved);
    // Lift the element so the outline sits above neighbouring menu items / fixed bars.
    if (window.getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }
    el.style.zIndex = '2147483646';
    el.style.transition =
      'outline 160ms ease, box-shadow 160ms ease, background-color 160ms ease';
    el.style.outline = '3px solid #b91c1c';
    el.style.outlineOffset = '2px';
    if (!saved.borderRadius) el.style.borderRadius = '6px';
    el.style.boxShadow =
      '0 0 0 4px rgba(185,28,28,0.25), 0 6px 18px rgba(185,28,28,0.30)';
    el.style.backgroundColor = 'rgba(185,28,28,0.10)';
    window.setTimeout(function () {
      el.style.outline = saved.outline;
      el.style.outlineOffset = saved.outlineOffset;
      el.style.boxShadow = saved.boxShadow;
      el.style.backgroundColor = saved.background;
      el.style.borderRadius = saved.borderRadius;
      el.style.transition = saved.transition;
      el.style.zIndex = saved.zIndex;
      el.style.position = saved.position;
    }, 3200);
  }

  // Returns a result the loader posts back so the widget can wait for the action to finish before
  // showing its final answer: { ok, performed:[...], label, missing, navigateHref }.
  // navigateHref (if set) tells the message handler to navigate the tab AFTER it posts the ACK,
  // so the widget can save its resume breadcrumb before the page reloads.
  async function executePageActions(actions) {
    var result = { ok: false, performed: [], label: '', missing: false, navigateHref: '' };
    if (!actions || !actions.length) {
      return result;
    }
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i] || {};
      var el = action.ref ? pageCtlRefs[action.ref] : null;
      if (el && !el.isConnected) el = null;

      if (action.type === 'scrollTo' && el) {
        // Only move the page when the target isn't already visible (fixed sidebars need no scroll).
        if (!atbInViewport(el)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        result.ok = true;
        result.performed.push('scrollTo');
        if (!result.label) result.label = atbText(el).slice(0, 80);
      } else if (action.type === 'highlight' && el) {
        if (!atbInViewport(el)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        atbHighlight(el);
        result.ok = true;
        result.performed.push('highlight');
        if (!result.label) result.label = atbText(el).slice(0, 80);
      } else if (action.type === 'clickAnchor' && el && el.tagName === 'A') {
        var href = el.getAttribute('href') || '';
        // Same-page anchors only — never external navigation, never a real .click().
        if (href.charAt(0) === '#' && href.length > 1) {
          var target = document.getElementById(href.slice(1));
          if (target) {
            if (!atbInViewport(target)) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            atbHighlight(target);
            result.ok = true;
            result.performed.push('clickAnchor');
            if (!result.label) result.label = atbText(target).slice(0, 80);
          }
        }
      } else if (action.type === 'openDocument' && el && el.tagName === 'A') {
        // Open a safe document (PDF/Word/Excel) in a new tab — re-validated, never the current tab,
        // so the page and widget stay intact. Never fills or submits anything.
        var docCls = atbClassifyHref(el.getAttribute('href') || '');
        if (docCls.kind === 'document') {
          if (widgetRuntime.openDocument) {
            const reply = await widgetRuntime.openDocument(docCls.url);
            if (!reply?.ok) { result.missing = true; continue; }
          }
          else window.open(docCls.url, '_blank', 'noopener,noreferrer');
          atbHighlight(el);
          result.ok = true;
          result.performed.push('openDocument');
          if (!result.label) result.label = atbText(el).slice(0, 80);
        } else {
          result.missing = true;
        }
      } else if (action.type === 'clickLink' && el && el.tagName === 'A') {
        // Safe same-domain internal navigation only. Deferred until after the ACK is posted.
        var navCls = atbClassifyHref(el.getAttribute('href') || '');
        if (navCls.kind === 'internal') {
          result.ok = true;
          result.performed.push('clickLink');
          result.navigateHref = navCls.url;
          if (!result.label) result.label = atbText(el).slice(0, 80);
        } else {
          result.missing = true;
        }
      } else if (
        action.ref &&
        (action.type === 'scrollTo' || action.type === 'highlight' ||
          action.type === 'clickAnchor' || action.type === 'openDocument' ||
          action.type === 'clickLink')
      ) {
        // Target ref no longer resolves (DOM changed since the snapshot).
        result.missing = true;
      }
      // Any other action type is ignored: no form submit, no typing, no payments, no generic click.
    }
    return result;
  }
  // -------------------------------------------------------------------------------------------


return {
  snapshot: buildPageSnapshot,
  context: buildSiteContext,
  async resumeDocument() {
    const key = 'atb_widget_pending_document';
    const raw = widgetStorage()?.getItem(key);
    if (!raw) return;
    widgetStorage().removeItem(key);
    let pending;
    try { pending = JSON.parse(raw); } catch { return; }
    if (Date.now() - pending.ts > 30000 || location.href !== pending.sourceUrl) return;
    const target = atbClassifyHref(pending.url);
    if (target.kind !== 'document') return;
    const link = Array.from(document.querySelectorAll('a[href]')).find(el => el.href === target.url);
    if (link) { link.scrollIntoView({ block: 'center' }); atbHighlight(link); }
    await widgetRuntime.openDocument?.(target.url);
  },
  async actions(actions) {
    const list = Array.isArray(actions) ? actions.slice(0, 30) : [];
    const result = await executePageActions(list);
    for (const action of list) {
      const target = atbClassifyHref(action.url);
      if (action.type === 'navigateTo' && target.kind === 'internal') {
        result.navigateHref = target.url;
        result.ok = true;
        result.performed.push('navigateTo');
      }
      if (action.type === 'openDocumentUrl' && target.kind === 'document') {
        const source = atbClassifyHref(action.sourceUrl);
        if (source.kind === 'internal' && source.url !== location.href) {
          widgetStorage().setItem('atb_widget_pending_document', JSON.stringify({ url: target.url, sourceUrl: source.url, ts: Date.now() }));
          result.navigateHref = source.url;
          result.ok = true;
          result.performed.push('navigateToDocumentSource');
          continue;
        }
        const link = Array.from(document.querySelectorAll('a[href]')).find(el => el.href === target.url);
        if (link) atbHighlight(link);
        const reply = await widgetRuntime.openDocument?.(target.url);
        if (reply?.ok) { result.ok = true; result.performed.push('openDocumentUrl'); }
      }
    }
    if (result.navigateHref) setTimeout(async () => {
      await widgetRuntime.flush?.();
      location.assign(result.navigateHref);
    }, 120);
    return { ok: result.ok, dispatched: true, result };
  },
  navigate(url) {
    const target = atbClassifyHref(url);
    if (target.kind === 'internal') Promise.resolve(widgetRuntime.flush?.()).then(() => location.assign(target.url));
  },
};
}
