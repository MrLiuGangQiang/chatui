(function initChatUIMessageActions(root) {
  'use strict';

function copySuccessState(successIconSvg, previousHtml) {
  return { className: 'copied', html: successIconSvg, restoreHtml: previousHtml, timeoutMs: 2000 };
}

function normalizeRenderedCopyText(text = '') {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  const lines = normalized.split('\n');
  const nonEmpty = lines.filter(line => line.trim()).length;
  const blank = lines.length - nonEmpty;
  const mostlyInterleavedBlanks = nonEmpty >= 2 && blank >= nonEmpty - 1 && lines.every((line, index) => line.trim() || index % 2 === 1);
  return mostlyInterleavedBlanks ? lines.filter(line => line.trim()).join('\n') : normalized.replace(/\n{2,}/g, '\n');
}

const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);

function normalizeVisibleLines(text = '') {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .filter(line => line.trim())
    .join('\n')
    .trim();
}

function visibleTextFromNode(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType !== 1) return '';
  const tag = node.tagName || '';
  if (tag === 'BR') return '\n';
  if (tag === 'IMG') return node.alt || '';
  if (tag === 'PRE') return normalizeVisibleLines(node.innerText || node.textContent || '');
  const text = Array.from(node.childNodes || []).map(visibleTextFromNode).join('');
  return BLOCK_TAGS.has(tag) ? `\n${text.trim()}\n` : text;
}

function visibleCopyTextFromElement(element) {
  return normalizeVisibleLines(visibleTextFromNode(element));
}

function messageCopyText(rawText = '', renderedText = '', element = null) {
  const visible = visibleCopyTextFromElement(element);
  const rendered = visible || normalizeRenderedCopyText(renderedText);
  return rendered || String(rawText || '').trim();
}

async function copyText(text, clipboard, documentRef) {
  const fallbackCopy = () => {
    if (!documentRef?.body) return false;
    const textarea = documentRef.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    documentRef.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try { copied = !!documentRef.execCommand?.('copy'); }
    finally { textarea.remove(); }
    return copied;
  };

  // Prefer the synchronous legacy path while the trusted click still has user activation.
  // Some Chromium/profile combinations leave navigator.clipboard.writeText() pending
  // instead of rejecting; awaiting it first makes the UI look like the button did nothing.
  if (fallbackCopy()) return true;

  try {
    if (clipboard?.writeText) {
      await Promise.race([
        clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard write timeout')), 350)),
      ]);
      return true;
    }
  } catch (err) {
    // Headless/HTTP contexts may reject clipboard writes even after a user-like click.
  }
  return fallbackCopy();
}

const api = Object.freeze({ copySuccessState, copyText, normalizeRenderedCopyText, visibleCopyTextFromElement, messageCopyText });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIMessageActions = api;
if (root?.window) root.window.ChatUIMessageActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
