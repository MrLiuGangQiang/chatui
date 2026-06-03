function composerSafeBottom(value, fallback = 168) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function activeOutputBottomTarget({ composerTop, viewportHeight, margin = 24 }) {
  return Math.max(80, (Number.isFinite(composerTop) ? composerTop : viewportHeight) - margin);
}

function isNodeAwayFromOutputFocus({ nodeRect, messagesRect = null, composerTop, viewportHeight, margin = 72 }) {
  if (!nodeRect) return false;
  const focusBottom = (Number.isFinite(composerTop) ? composerTop : viewportHeight) - margin;
  const viewportTop = messagesRect?.top || 0;
  const viewportBottom = messagesRect?.bottom ? Math.min(messagesRect.bottom, focusBottom) : focusBottom;
  const lowerTolerance = Math.max(48, Math.min(140, margin));
  return nodeRect.bottom > viewportBottom + lowerTolerance || nodeRect.bottom < viewportTop + 80 || nodeRect.top > viewportBottom || nodeRect.bottom < viewportTop;
}

function distanceToBottom(scroller) {
  if (!scroller) return 0;
  const viewport = Number.isFinite(scroller.clientHeight) ? scroller.clientHeight : 0;
  return Math.max(0, (Number(scroller.scrollHeight) || 0) - (Number(scroller.scrollTop) || 0) - viewport);
}

function isNearBottom(scroller, threshold = 120) {
  return distanceToBottom(scroller) <= threshold;
}

function createAutoFollowState(options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 120;
  const suppressMs = Number.isFinite(options.suppressMs) ? options.suppressMs : 140;
  const now = options.now || (() => Date.now());
  const state = {
    isAutoFollowing: true,
    userScrolledAway: false,
    lastUserScrollAt: 0,
    suppressScrollUntil: 0,
    lastScrollTop: 0,
  };

  function begin(scroller = null) {
    state.isAutoFollowing = true;
    state.userScrolledAway = false;
    state.lastUserScrollAt = 0;
    if (scroller) state.lastScrollTop = Number(scroller.scrollTop) || 0;
    return state;
  }

  function suppress() {
    state.suppressScrollUntil = now() + suppressMs;
  }

  function canFollow(scroller = null) {
    return state.isAutoFollowing && !state.userScrolledAway;
  }

  function markEvent(event, scroller) {
    if (!scroller) return state;
    const type = String(event?.type || 'scroll');
    const currentTop = Number(scroller.scrollTop) || 0;
    const near = isNearBottom(scroller, threshold);
    const suppressed = now() < state.suppressScrollUntil;
    const wheelUp = type === 'wheel' && Number(event?.deltaY || 0) < -1;
    const wheelDown = type === 'wheel' && Number(event?.deltaY || 0) > 1;
    const directUserGesture = type === 'touchstart' || type === 'touchmove' || type === 'pointerdown' || type === 'mousedown';
    const scrollUp = type === 'scroll' && currentTop < state.lastScrollTop - 1;
    const scrollbarAway = type === 'scroll' && !suppressed && !near;

    if (!suppressed && (wheelUp || directUserGesture || scrollUp || scrollbarAway)) {
      state.isAutoFollowing = false;
      state.userScrolledAway = true;
      state.lastUserScrollAt = now();
    } else if (near || wheelDown) {
      state.isAutoFollowing = true;
      state.userScrolledAway = false;
    }

    state.lastScrollTop = currentTop;
    return state;
  }

  return { state, begin, suppress, canFollow, markEvent, isNearBottom: scroller => isNearBottom(scroller, threshold) };
}

module.exports = { composerSafeBottom, activeOutputBottomTarget, isNodeAwayFromOutputFocus, distanceToBottom, isNearBottom, createAutoFollowState };
