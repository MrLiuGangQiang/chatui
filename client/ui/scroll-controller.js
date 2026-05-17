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
  return nodeRect.bottom > viewportBottom + 40 || nodeRect.bottom < viewportTop + 80 || nodeRect.top > viewportBottom || nodeRect.bottom < viewportTop;
}

module.exports = { composerSafeBottom, activeOutputBottomTarget, isNodeAwayFromOutputFocus };
