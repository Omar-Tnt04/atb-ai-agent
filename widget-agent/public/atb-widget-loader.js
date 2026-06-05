(function () {
  var DEFAULT_WIDGET_URL = 'http://localhost:5174';
  var DEFAULT_API_URL = 'http://localhost:5000';
  var LOADER_STATE_KEY = '__ATB_AI_BANKING_AGENT_WIDGET__';
  var IFRAME_ID = 'atb-ai-banking-agent-widget';
  var COLLAPSED_SIZE = {
    width: 176,
    height: 176,
  };
  var OPEN_SIZE = {
    width: 660,
    height: 936,
  };
  var CLOSED_LAUNCHER_CENTER = {
    x: 88,
    y: 88,
  };
  var CLOSED_LAUNCHER_OFFSET = {
    x: 50,
    y: 50,
  };
  var PANEL_SIZE = {
    width: 520,
    height: 720,
  };
  var BUBBLE_SIZE = 76;
  var BUBBLE_EDGE_MARGIN = 8;
  var OPEN_SIDE_PADDING = 70;
  var OPEN_TOP_PADDING = 50;
  var OPEN_VERTICAL_GAP = 40;
  var DRAG_CLICK_THRESHOLD = 4;

  if (window[LOADER_STATE_KEY] || document.getElementById(IFRAME_ID)) {
    return;
  }

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
    iframe.style.position = 'fixed';
    iframe.style.width = COLLAPSED_SIZE.width + 'px';
    iframe.style.height = COLLAPSED_SIZE.height + 'px';
    iframe.style.border = 'none';
    iframe.style.zIndex = '2147483647';
    iframe.style.borderRadius = '0';
    iframe.style.background = 'transparent';
    iframe.style.colorScheme = 'normal';
    iframe.style.transition = 'width 180ms ease, height 180ms ease';
    setFrameRect(iframe, {
      left: getViewportSize().width - COLLAPSED_SIZE.width - 24,
      top: getViewportSize().height - COLLAPSED_SIZE.height - 24,
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

    document.body.appendChild(iframe);
    window[LOADER_STATE_KEY].status = 'loaded';
  }

  if (document.body) {
    injectWidget();
  } else {
    document.addEventListener('DOMContentLoaded', injectWidget, { once: true });
  }
})();
