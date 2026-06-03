'use strict';

function normalizeNewlines(value = '') {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function hasConservativeInlineMathTail(text = '') {
  const src = normalizeNewlines(text);
  const tail = src.slice(Math.max(0, src.lastIndexOf('\n') + 1));
  let escaped = false;
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch !== '$') continue;
    if (tail[i + 1] === '$' || tail[i - 1] === '$') continue;
    return true;
  }
  return false;
}

function splitLinesWithOffsets(text = '') {
  const src = normalizeNewlines(text);
  const lines = [];
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') {
      lines.push({ text: src.slice(start, i), start, end: i + 1, hasNl: true });
      start = i + 1;
    }
  }
  if (start < src.length) lines.push({ text: src.slice(start), start, end: src.length, hasNl: false });
  return { src, lines };
}

function isBlank(line) { return /^\s*$/.test(line); }
function isFence(line) {
  const direct = line.match(/^\s{0,3}(`{3,}|~{3,})([^`]*)$/);
  if (direct) return direct;
  return line.match(/^\s{0,3}>\s?(`{3,}|~{3,})([^`]*)$/);
}
function isMathFence(line) { return /^\s*\$\$\s*$/.test(line); }
function isContainerFence(line) { return /^\s*:{3,}\s*\S*/.test(line); }
function isDetailsOpen(line) { return /^\s*<details(?:\s|>|$)/i.test(line); }
function isDetailsClose(line) { return /^\s*<\/details\s*>/i.test(line); }
function isListLine(line) { return /^\s{0,3}(?:[-+*]|\d{1,9}[.)])\s+/.test(line); }
function isTableSeparator(line) { return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }
function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line) || /^\s*\S.*\|.*\S\s*$/.test(line); }
function isAdmonitionStart(line) { return /^\s*!!!\s+\S+/.test(line); }
function isIndentedContinuation(line) { return /^\s{2,}\S/.test(line); }
function isBlockStart(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s{0,3}>\s?/.test(line)
    || /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || isListLine(line)
    || isTableRow(line)
    || isAdmonitionStart(line)
    || isContainerFence(line)
    || isDetailsOpen(line)
    || isFence(line)
    || isMathFence(line);
}

function findStableBoundary(text = '') {
  const { src, lines } = splitLinesWithOffsets(text);
  if (!src) return 0;
  let stable = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let inMathBlock = false;
  for (const lineInfo of lines) {
    const line = lineInfo.text;
    const complete = lineInfo.hasNl;
    const fence = isFence(line);
    if (!inMathBlock && fence) {
      const marker = fence[1];
      const ch = marker[0];
      const info = String(fence[2] || '').trim();
      if (inFence) {
        if (ch === fenceChar && marker.length >= fenceLen && !info) {
          inFence = false; fenceChar = ''; fenceLen = '';
          stable = lineInfo.end;
        }
      } else {
        inFence = true; fenceChar = ch; fenceLen = marker.length;
      }
      continue;
    }
    if (inFence) continue;
    if (isMathFence(line)) {
      inMathBlock = !inMathBlock;
      if (!inMathBlock && complete) stable = lineInfo.end;
      continue;
    }
    if (inMathBlock) continue;
    if (isBlank(line) && complete && !hasConservativeInlineMathTail(src.slice(0, lineInfo.end))) stable = lineInfo.end;
  }
  if (!inFence && !inMathBlock && src.endsWith('\n') && !hasConservativeInlineMathTail(src)) stable = Math.max(stable, src.length);
  if (hasConservativeInlineMathTail(src)) {
    const lastLineStart = Math.max(0, src.lastIndexOf('\n', src.length - 2) + 1);
    stable = Math.min(stable, lastLineStart);
  }
  return Math.max(0, Math.min(stable, src.length));
}

function splitStableTail(text = '') {
  const src = normalizeNewlines(text);
  const index = findStableBoundary(src);
  return { stable: src.slice(0, index), tail: src.slice(index), index };
}

module.exports = { findStableBoundary, splitStableTail, hasConservativeInlineMathTail };
