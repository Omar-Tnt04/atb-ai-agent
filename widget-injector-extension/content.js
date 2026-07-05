// SYNC NOTE — this file is a copy of widget-agent/public/atb-widget-loader.js with
// extension-specific overrides (WIDGET_POSITION, WIDGET_BOTTOM_OFFSET).
//
// What auto-updates via localhost:5174:
//   ChatWidget.jsx, chatWidget.css, all React/UI code — the iframe reloads the live
//   widget app, so no content.js change is needed for widget UI/style/logic changes.
//
// What must be manually synced here:
//   Iframe creation, same-page bridge, postMessage handlers, size constants, position
//   config. If atb-widget-loader.js loader logic changes, copy those changes here and
//   restore the extension-specific overrides below.
(function () {
  console.log('[ATB_WIDGET_EXTENSION] content script running on', location.href);

  // Skip direct document downloads — the widget cannot be usefully embedded in a PDF/Office file.
  if (/\.(pdf|docx?|xlsx?|pptx?)(\?.*)?$/i.test(location.pathname)) {
    console.log('[ATB_WIDGET_EXTENSION] skip reason: document file type in pathname');
    return;
  }

  // sessionStorage persists across navigations within one tab but clears on tab close.
  // withinSession=true → beforeunload fired earlier this tab session (page navigation, agent running).
  // withinSession=false → brand-new or reopened tab → discard any pending job, start fresh.
  var withinSession = false;
  try { withinSession = !!sessionStorage.getItem('__ATB_WITHIN_SESSION__'); } catch (e) {}
  window.addEventListener('beforeunload', function () {
    try { sessionStorage.setItem('__ATB_WITHIN_SESSION__', '1'); } catch (e) {}
  });

  var _cfg = window.__ATB_WIDGET_CONFIG__;
  var DEFAULT_WIDGET_URL = (_cfg && _cfg.widgetUrl) || 'http://localhost:5174';
  var DEFAULT_API_URL = (_cfg && _cfg.apiUrl) || 'http://localhost:5000';
  var LOADER_STATE_KEY = '__ATB_AI_BANKING_AGENT_WIDGET__';
  var IFRAME_ID = 'atb-ai-banking-agent-widget';
  // Bridge key: stores pending-job state in atb.tn localStorage (accessible to content.js).
  // Used as a reliable fallback when the iframe's partitioned localStorage is empty after reload.
  var BRIDGE_STATE_KEY = '__ATB_AI_WIDGET_BRIDGE__';
  var BRIDGE_STATE_TTL_MS = 60 * 60 * 1000;
  var COLLAPSED_SIZE = {
    width: 72,
    height: 72,
  };
  var OPEN_SIZE = {
    width: 368,
    height: 594,
  };
  var CLOSED_LAUNCHER_CENTER = {
    x: 36,
    y: 36,
  };
  var CLOSED_LAUNCHER_OFFSET = {
    x: 10,
    y: 10,
  };
  var PANEL_SIZE = {
    width: 340,
    height: 500,
  };
  var BUBBLE_SIZE = 52;
  var BUBBLE_EDGE_MARGIN = 6;
  var OPEN_SIDE_PADDING = 14;
  var OPEN_TOP_PADDING = 14;
  var OPEN_VERTICAL_GAP = 14;
  var DRAG_CLICK_THRESHOLD = 4;
  // Extension overrides: bottom-right keeps us on the same side as most chat widgets.
  // WIDGET_BOTTOM_OFFSET = 96 positions above ATB's own native bottom-right bubble (~80px tall).
  var WIDGET_POSITION = 'bottom-right';
  var WIDGET_BOTTOM_OFFSET = 96;

  if (window[LOADER_STATE_KEY] || document.getElementById(IFRAME_ID)) {
    console.log('[EXTENSION] widget already injected, skipping');
    return;
  }

  // ---- Same-page control bridge -------------------------------------------------------------
  // The loader runs in the HOST page, so it can read the host DOM (the iframe cannot, cross-origin).
  // It builds a generic snapshot on request and executes a small set of SAFE actions only:
  // scroll, highlight, and same-page anchor navigation. It never submits forms, types, logs in,
  // pays, or clicks arbitrary buttons.
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

  function atbRegistrableDomain(hostname) {
    var parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    return parts.slice(-2).join('.');
  }

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
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'none' };
    var internal = atbRegistrableDomain(url.hostname) === atbRegistrableDomain(location.hostname);
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
  function executePageActions(actions) {
    var result = { ok: false, performed: [], label: '', missing: false, navigateHref: '' };
    if (!actions || !actions.length) {
      return result;
    }
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i] || {};
      var el = action.ref ? pageCtlRefs[action.ref] : null;

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
          window.open(docCls.url, '_blank', 'noopener,noreferrer');
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

  var currentScript = document.currentScript;
  var widgetUrl =
    (currentScript && currentScript.getAttribute('data-widget-url')) ||
    DEFAULT_WIDGET_URL;
  var apiUrl =
    (currentScript && currentScript.getAttribute('data-api-url')) ||
    DEFAULT_API_URL;

  window[LOADER_STATE_KEY] = {
    status: 'loading',
  };

  function withEmbedUrl(urlValue, apiUrlValue) {
    var url;

    try {
      url = new URL(urlValue, window.location.href);
    } catch (error) {
      url = new URL(DEFAULT_WIDGET_URL);
    }

    var basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = basePath.endsWith('/embed') ? basePath : (basePath || '') + '/embed';
    url.searchParams.set('embed', 'true');
    url.searchParams.set('apiUrl', apiUrlValue);
    // Bust the browser cache on every ATB page load so widget UI changes (Vite HMR or
    // manual edits) are visible after a page refresh without reloading the extension.
    url.searchParams.set('devTime', Date.now());
    return url.toString();
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getViewportSize() {
    return {
      width: window.innerWidth || document.documentElement.clientWidth,
      height: window.innerHeight || document.documentElement.clientHeight,
    };
  }

  function getFrameRect(iframe) {
    var rect = iframe.getBoundingClientRect();

    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function getClampedBubbleCenter(bubbleCenter) {
    var viewport = getViewportSize();
    var visibleBubbleRadius = BUBBLE_SIZE / 2 + BUBBLE_EDGE_MARGIN;
    var minCenterX = Math.min(visibleBubbleRadius, viewport.width / 2);
    var maxCenterX = Math.max(minCenterX, viewport.width - visibleBubbleRadius);
    var minCenterY = Math.min(visibleBubbleRadius, viewport.height / 2);
    var maxCenterY = Math.max(minCenterY, viewport.height - visibleBubbleRadius);

    return {
      x: clamp(bubbleCenter.x, minCenterX, maxCenterX),
      y: clamp(bubbleCenter.y, minCenterY, maxCenterY),
    };
  }

  function setFrameRect(iframe, rect, anchor) {
    var viewport = getViewportSize();
    var left;
    var top;

    if (anchor) {
      var clampedBubbleCenter = getClampedBubbleCenter({
        x: rect.left + anchor.x,
        y: rect.top + anchor.y,
      });

      left = clampedBubbleCenter.x - anchor.x;
      top = clampedBubbleCenter.y - anchor.y;
    } else {
      left = clamp(rect.left, 0, Math.max(0, viewport.width - rect.width));
      top = clamp(rect.top, 0, Math.max(0, viewport.height - rect.height));
    }

    iframe.style.left = left + 'px';
    iframe.style.top = top + 'px';
    iframe.style.right = 'auto';
    iframe.style.bottom = 'auto';
    iframe.style.width = rect.width + 'px';
    iframe.style.height = rect.height + 'px';
  }

  function getLayoutForBubble(bubbleCenter) {
    var viewport = getViewportSize();
    var alignLeft = bubbleCenter.x < viewport.width / 2;
    var openDown = bubbleCenter.y < viewport.height / 2;
    var launcherLeft = alignLeft
      ? OPEN_SIDE_PADDING
      : OPEN_SIZE.width - OPEN_SIDE_PADDING - BUBBLE_SIZE;
    var launcherTop = openDown
      ? OPEN_TOP_PADDING
      : OPEN_SIZE.height - OPEN_TOP_PADDING - BUBBLE_SIZE;
    var panelLeft = alignLeft
      ? OPEN_SIDE_PADDING
      : OPEN_SIZE.width - OPEN_SIDE_PADDING - PANEL_SIZE.width;
    var panelTop = openDown
      ? OPEN_TOP_PADDING + BUBBLE_SIZE + OPEN_VERTICAL_GAP
      : OPEN_TOP_PADDING;

    return {
      launcherLeft: launcherLeft,
      launcherTop: launcherTop,
      launcherCenter: {
        x: launcherLeft + BUBBLE_SIZE / 2,
        y: launcherTop + BUBBLE_SIZE / 2,
      },
      panelLeft: panelLeft,
      panelTop: panelTop,
    };
  }

  function getClosedLayout() {
    return {
      launcherLeft: CLOSED_LAUNCHER_OFFSET.x,
      launcherTop: CLOSED_LAUNCHER_OFFSET.y,
      launcherCenter: CLOSED_LAUNCHER_CENTER,
      panelLeft: OPEN_SIDE_PADDING,
      panelTop: OPEN_TOP_PADDING,
    };
  }

  function getFullscreenDragLayout(bubbleCenter) {
    var viewport = getViewportSize();
    var clampedBubbleCenter = getClampedBubbleCenter(bubbleCenter);
    var gap = 24;
    var pagePadding = 8;
    var alignLeft = clampedBubbleCenter.x < viewport.width / 2;
    var openDown = clampedBubbleCenter.y < viewport.height / 2;
    var launcherLeft = clampedBubbleCenter.x - BUBBLE_SIZE / 2;
    var launcherTop = clampedBubbleCenter.y - BUBBLE_SIZE / 2;
    var preferredPanelLeft = alignLeft
      ? clampedBubbleCenter.x + BUBBLE_SIZE / 2 + gap
      : clampedBubbleCenter.x - BUBBLE_SIZE / 2 - gap - PANEL_SIZE.width;
    var preferredPanelTop = openDown
      ? clampedBubbleCenter.y + BUBBLE_SIZE / 2 + gap
      : clampedBubbleCenter.y - BUBBLE_SIZE / 2 - gap - PANEL_SIZE.height;

    return {
      launcherLeft: launcherLeft,
      launcherTop: launcherTop,
      launcherCenter: clampedBubbleCenter,
      panelLeft: clamp(
        preferredPanelLeft,
        pagePadding,
        Math.max(pagePadding, viewport.width - PANEL_SIZE.width - pagePadding),
      ),
      panelTop: clamp(
        preferredPanelTop,
        pagePadding,
        Math.max(pagePadding, viewport.height - PANEL_SIZE.height - pagePadding),
      ),
    };
  }

  function postLayout(iframe, layout) {
    iframe.contentWindow.postMessage(
      {
        type: 'ATB_WIDGET_LAYOUT',
        launcherLeft: layout.launcherLeft,
        launcherTop: layout.launcherTop,
        panelLeft: layout.panelLeft,
        panelTop: layout.panelTop,
        panelWidth: PANEL_SIZE.width,
        panelHeight: PANEL_SIZE.height,
      },
      '*',
    );
  }

  function injectWidget() {
    if (document.getElementById(IFRAME_ID)) {
      window[LOADER_STATE_KEY].status = 'loaded';
      return;
    }

    var iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    iframe.title = 'ATB AI Banking Agent';
    iframe.allow = 'clipboard-write';
    iframe.setAttribute('allowtransparency', 'true');
    iframe.src = withEmbedUrl(widgetUrl, apiUrl);
    console.log('[ATB_WIDGET_EXTENSION] iframe src=' + iframe.src);
    iframe.style.position = 'fixed';
    iframe.style.width = COLLAPSED_SIZE.width + 'px';
    iframe.style.height = COLLAPSED_SIZE.height + 'px';
    iframe.style.border = 'none';
    iframe.style.zIndex = '2147483647';
    iframe.style.borderRadius = '0';
    iframe.style.background = 'transparent';
    iframe.style.colorScheme = 'normal';
    iframe.style.transition = 'width 180ms ease, height 180ms ease';
    var vp = getViewportSize();
    setFrameRect(iframe, {
      left: WIDGET_POSITION === 'bottom-left'
        ? 24
        : vp.width - COLLAPSED_SIZE.width - 24,
      top: vp.height - COLLAPSED_SIZE.height - WIDGET_BOTTOM_OFFSET,
      width: COLLAPSED_SIZE.width,
      height: COLLAPSED_SIZE.height,
    }, CLOSED_LAUNCHER_CENTER);

    var isOpen = false;
    var launcherCenter = CLOSED_LAUNCHER_CENTER;
    var dragState = null;

    function getBubbleCenter() {
      var rect = getFrameRect(iframe);

      return {
        x: rect.left + launcherCenter.x,
        y: rect.top + launcherCenter.y,
      };
    }

    function endDrag() {
      if (!dragState) {
        return;
      }

      var didDrag =
        Math.hypot(dragState.totalX, dragState.totalY) > DRAG_CLICK_THRESHOLD;
      var finalBubbleCenter = dragState.bubbleCenter;
      var finalLayout;

      if (isOpen) {
        finalLayout = getLayoutForBubble(finalBubbleCenter);
        launcherCenter = finalLayout.launcherCenter;
        setFrameRect(iframe, {
          left: finalBubbleCenter.x - launcherCenter.x,
          top: finalBubbleCenter.y - launcherCenter.y,
          width: OPEN_SIZE.width,
          height: OPEN_SIZE.height,
        }, launcherCenter);
        postLayout(iframe, finalLayout);
      } else {
        finalLayout = getClosedLayout();
        launcherCenter = finalLayout.launcherCenter;
        setFrameRect(iframe, {
          left: finalBubbleCenter.x - launcherCenter.x,
          top: finalBubbleCenter.y - launcherCenter.y,
          width: COLLAPSED_SIZE.width,
          height: COLLAPSED_SIZE.height,
        }, launcherCenter);
        postLayout(iframe, finalLayout);
      }

      iframe.style.transition = dragState.originalTransition;
      iframe.contentWindow.postMessage(
        didDrag ? { type: 'ATB_WIDGET_DRAG_FINISHED' } : { type: 'ATB_WIDGET_LAUNCHER_CLICK' },
        '*',
      );
      dragState = null;
    }

    function moveBubbleByDelta(dx, dy) {
      if (!dragState) {
        return;
      }

      dragState.totalX += dx;
      dragState.totalY += dy;
      dragState.bubbleCenter = getClampedBubbleCenter({
        x: dragState.bubbleCenter.x + dx,
        y: dragState.bubbleCenter.y + dy,
      });

      var dragLayout = getFullscreenDragLayout(dragState.bubbleCenter);
      launcherCenter = dragLayout.launcherCenter;
      postLayout(iframe, dragLayout);
    }

    function moveBubbleToPointer(clientX, clientY) {
      if (!dragState) {
        return;
      }

      var nextBubbleCenter = getClampedBubbleCenter({
        x: clientX - dragState.grabOffsetX,
        y: clientY - dragState.grabOffsetY,
      });
      var dx = nextBubbleCenter.x - dragState.bubbleCenter.x;
      var dy = nextBubbleCenter.y - dragState.bubbleCenter.y;

      dragState.lastX = clientX;
      dragState.lastY = clientY;
      dragState.totalX += dx;
      dragState.totalY += dy;
      dragState.bubbleCenter = nextBubbleCenter;

      var dragLayout = getFullscreenDragLayout(dragState.bubbleCenter);
      launcherCenter = dragLayout.launcherCenter;
      postLayout(iframe, dragLayout);
    }

    function startDrag(message) {
      if (dragState) {
        return;
      }

      var currentRect = getFrameRect(iframe);
      var bubbleCenter = getClampedBubbleCenter(getBubbleCenter());
      var dragLayout = getFullscreenDragLayout(bubbleCenter);
      var viewport = getViewportSize();
      var startClientX = Number(message.clientX || 0);
      var startClientY = Number(message.clientY || 0);
      var pointerViewportX = currentRect.left + startClientX;
      var pointerViewportY = currentRect.top + startClientY;

      dragState = {
        originalTransition: iframe.style.transition,
        bubbleCenter: dragLayout.launcherCenter,
        grabOffsetX: pointerViewportX - bubbleCenter.x,
        grabOffsetY: pointerViewportY - bubbleCenter.y,
        lastX: pointerViewportX,
        lastY: pointerViewportY,
        totalX: 0,
        totalY: 0,
      };

      iframe.style.transition = 'none';
      launcherCenter = dragLayout.launcherCenter;
      setFrameRect(iframe, {
        left: 0,
        top: 0,
        width: viewport.width,
        height: viewport.height,
      });
      postLayout(iframe, dragLayout);
    }

    window.addEventListener('message', function (event) {
      var message = event.data || {};

      if (event.source !== iframe.contentWindow) {
        return;
      }

      if (message.type === 'ATB_PAGE_INSPECT_REQUEST') {
        iframe.contentWindow.postMessage(
          {
            type: 'ATB_PAGE_SNAPSHOT',
            requestId: message.requestId,
            snapshot: buildPageSnapshot(),
          },
          '*',
        );
        return;
      }

      if (message.type === 'ATB_SITE_CONTEXT_REQUEST') {
        iframe.contentWindow.postMessage(
          {
            type: 'ATB_SITE_CONTEXT_RESPONSE',
            requestId: message.requestId,
            context: buildSiteContext(),
          },
          '*',
        );
        return;
      }

      if (message.type === 'ATB_PAGE_ACTION') {
        var actionResult = executePageActions(message.actions);
        iframe.contentWindow.postMessage(
          {
            type: 'ATB_PAGE_ACTION_RESULT',
            requestId: message.requestId,
            result: actionResult,
          },
          '*',
        );
        // Deferred safe navigation: reload the tab only after the widget has received the ACK
        // (and saved its resume breadcrumb), so the multi-step goal can continue on the new page.
        if (actionResult.navigateHref) {
          window.setTimeout(function () {
            location.assign(actionResult.navigateHref);
          }, 120);
        }
        return;
      }

      // Bridge: widget asks content.js to save pending-job state in atb.tn localStorage.
      if (message.type === 'ATB_WIDGET_SAVE_BRIDGE') {
        try {
          window.localStorage.setItem(BRIDGE_STATE_KEY, JSON.stringify({ ...message.state, ts: Date.now() }));
          console.log('[ATB_WIDGET_EXTENSION] bridge state saved for job:', message.state && message.state.pendingBrowserJob && message.state.pendingBrowserJob.jobId);
        } catch (bridgeErr) { /* ignore */ }
        return;
      }

      if (message.type === 'ATB_WIDGET_CLEAR_BRIDGE') {
        try { window.localStorage.removeItem(BRIDGE_STATE_KEY); } catch (clearErr) { /* ignore */ }
        return;
      }

      var isClosedMessage =
        message === 'ATB_WIDGET_CLOSED' ||
        (message.type === 'atb-widget:resize' && message.state === 'closed');
      var isOpenMessage =
        message === 'ATB_WIDGET_OPEN' ||
        (message.type === 'atb-widget:resize' && message.state !== 'closed');

      if (!isClosedMessage && !isOpenMessage) {
        if (message.type === 'ATB_WIDGET_DRAG_START') {
          startDrag(message);
          return;
        }

        if (message.type === 'ATB_WIDGET_DRAG_END') {
          endDrag();
          return;
        }

        if (message.type === 'ATB_WIDGET_DRAG_MOVE') {
          var dragDx = Number(message.dx || 0);
          var dragDy = Number(message.dy || 0);
          var hasClientPosition =
            Number.isFinite(Number(message.clientX)) &&
            Number.isFinite(Number(message.clientY));

          if (dragState) {
            if (hasClientPosition) {
              moveBubbleToPointer(
                Number(message.clientX),
                Number(message.clientY),
              );
              return;
            }

            moveBubbleByDelta(dragDx, dragDy);
            return;
          }

          var currentRect = getFrameRect(iframe);
          setFrameRect(iframe, {
            left: currentRect.left + dragDx,
            top: currentRect.top + dragDy,
            width: currentRect.width,
            height: currentRect.height,
          }, launcherCenter);
          return;
        }

        return;
      }

      var bubbleCenter = getBubbleCenter();

      if (isClosedMessage) {
        isOpen = false;
        var closedLayout = getClosedLayout();
        launcherCenter = closedLayout.launcherCenter;
        setFrameRect(iframe, {
          left: bubbleCenter.x - launcherCenter.x,
          top: bubbleCenter.y - launcherCenter.y,
          width: COLLAPSED_SIZE.width,
          height: COLLAPSED_SIZE.height,
        }, launcherCenter);
        postLayout(iframe, closedLayout);
        return;
      }

      isOpen = true;
      var layout = getLayoutForBubble(bubbleCenter);
      launcherCenter = layout.launcherCenter;
      setFrameRect(iframe, {
        left: bubbleCenter.x - launcherCenter.x,
        top: bubbleCenter.y - launcherCenter.y,
        width: OPEN_SIZE.width,
        height: OPEN_SIZE.height,
      }, launcherCenter);
      postLayout(iframe, layout);
    });

    window.addEventListener('resize', function () {
      var bubbleCenter = getBubbleCenter();

      if (!isOpen) {
        var closedLayout = getClosedLayout();
        launcherCenter = closedLayout.launcherCenter;
        setFrameRect(iframe, {
          left: bubbleCenter.x - CLOSED_LAUNCHER_CENTER.x,
          top: bubbleCenter.y - CLOSED_LAUNCHER_CENTER.y,
          width: COLLAPSED_SIZE.width,
          height: COLLAPSED_SIZE.height,
        }, CLOSED_LAUNCHER_CENTER);
        postLayout(iframe, closedLayout);
        return;
      }

      var layout = getLayoutForBubble(bubbleCenter);
      launcherCenter = layout.launcherCenter;
      setFrameRect(iframe, {
        left: bubbleCenter.x - launcherCenter.x,
        top: bubbleCenter.y - launcherCenter.y,
        width: OPEN_SIZE.width,
        height: OPEN_SIZE.height,
      }, launcherCenter);
      postLayout(iframe, layout);
    });

    iframe.addEventListener('load', function () {
      postLayout(iframe, getClosedLayout());
      var rect = iframe.getBoundingClientRect();
      var cs = window.getComputedStyle(iframe);
      console.log('[ATB_WIDGET_EXTENSION] iframe load. src:', iframe.src);
      console.log('[ATB_WIDGET_EXTENSION] iframe rect: left=' + Math.round(rect.left) + ' top=' + Math.round(rect.top) + ' w=' + Math.round(rect.width) + ' h=' + Math.round(rect.height));
      console.log('[ATB_WIDGET_EXTENSION] iframe computed: display=' + cs.display + ' visibility=' + cs.visibility + ' opacity=' + cs.opacity + ' zIndex=' + cs.zIndex);
      // Bridge restore: check atb.tn localStorage for a pending browser-use job the widget
      // saved via ATB_WIDGET_SAVE_BRIDGE. If found, proactively open the iframe and forward
      // state — does not rely on the iframe's own partitioned localStorage.
      try {
        if (!withinSession) {
          // Fresh tab (or reopened after close) — clear stale bridge so content.js does not
          // restore a job from a dead prior session, and tell the widget iframe to discard any
          // pendingBrowserJob it finds in its own localStorage.
          window.localStorage.removeItem(BRIDGE_STATE_KEY);
          console.log('[ATB_WIDGET_EXTENSION] fresh tab — bridge cleared, sending FORCE_FRESH');
          window.setTimeout(function () {
            if (iframe && iframe.contentWindow) {
              iframe.contentWindow.postMessage({ type: 'ATB_WIDGET_FORCE_FRESH' }, '*');
            }
          }, 100);
          return;
        }
        var bridgeRaw = window.localStorage.getItem(BRIDGE_STATE_KEY);
        if (bridgeRaw) {
          var bridgeState = JSON.parse(bridgeRaw);
          if (bridgeState && bridgeState.pendingBrowserJob && bridgeState.ts &&
              (Date.now() - bridgeState.ts) < BRIDGE_STATE_TTL_MS) {
            console.log('[ATB_WIDGET_EXTENSION] bridge pending job found:', bridgeState.pendingBrowserJob.jobId, '— forcing iframe open');
            var bubCen = getBubbleCenter();
            var openLay = getLayoutForBubble(bubCen);
            launcherCenter = openLay.launcherCenter;
            isOpen = true;
            setFrameRect(iframe, {
              left: bubCen.x - launcherCenter.x,
              top: bubCen.y - launcherCenter.y,
              width: OPEN_SIZE.width,
              height: OPEN_SIZE.height,
            }, launcherCenter);
            postLayout(iframe, openLay);
            window.setTimeout(function () {
              iframe.contentWindow.postMessage({ type: 'ATB_WIDGET_BRIDGE_RESTORE', state: bridgeState }, '*');
            }, 350);
          } else {
            console.log('[ATB_WIDGET_EXTENSION] bridge state found but no pending job or expired');
          }
        } else {
          console.log('[ATB_WIDGET_EXTENSION] no bridge state in atb.tn localStorage');
        }
      } catch (bridgeReadErr) {
        console.log('[ATB_WIDGET_EXTENSION] bridge read error:', bridgeReadErr.message);
      }
    });

    console.log('[ATB_WIDGET_EXTENSION] injecting widget iframe');
    document.body.appendChild(iframe);
    window[LOADER_STATE_KEY].status = 'loaded';

    // If host-page JS removes the widget iframe, reinject after a short delay.
    if (typeof MutationObserver !== 'undefined') {
      var _reinjObs = new MutationObserver(function() {
        if (!document.getElementById(IFRAME_ID)) {
          console.log('[ATB_WIDGET_EXTENSION] iframe removed from DOM — reinjecting');
          _reinjObs.disconnect();
          window.setTimeout(injectWidget, 250);
        }
      });
      _reinjObs.observe(document.body, { childList: true });
    }

    // Dev helper: __atbWidgetReset() from ATB page DevTools console.
    // Clears atb.tn localStorage bridge + tells iframe to clear its own widget keys.
    window.__atbWidgetReset = function () {
      try { window.localStorage.removeItem(BRIDGE_STATE_KEY); } catch (e) {}
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'ATB_WIDGET_DEV_RESET' }, '*');
      }
      console.log('[ATB_WIDGET_EXTENSION] widget state cleared. Reload page to start fresh.');
    };
    console.log('[ATB_WIDGET_EXTENSION] dev reset available: __atbWidgetReset()');
  }

  // Fetch live tunnel URLs from the dev backend on every page load so the extension
  // never needs a manual reload when tunnel URLs rotate between npm run dev sessions.
  // Falls back to the static widget-config.js values if the backend is unreachable.
  fetch(DEFAULT_API_URL + '/dev/widget-config', { cache: 'no-store' })
    .then(function(resp) { return resp.ok ? resp.json() : null; })
    .then(function(cfg) {
      if (cfg && cfg.widgetUrl) widgetUrl = cfg.widgetUrl;
      if (cfg && cfg.apiUrl) apiUrl = cfg.apiUrl;
    })
    .catch(function() {
      console.log('[ATB_WIDGET_EXTENSION] /dev/widget-config unreachable, using widget-config.js fallback');
    })
    .finally(function() {
      console.log('[ATB_WIDGET_EXTENSION] widgetUrl=' + widgetUrl + ' apiUrl=' + apiUrl);
      if (document.body) {
        injectWidget();
      } else {
        document.addEventListener('DOMContentLoaded', injectWidget, { once: true });
      }
    });
})();
