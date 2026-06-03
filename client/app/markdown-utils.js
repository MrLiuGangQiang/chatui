const GFM_EMOJI_SHORTCODES = Object.freeze({
  smile: '😄',
  rocket: '🚀',
  heart: '❤️',
  thumbs_up: '👍',
  '+1': '👍',
  thumbs_down: '👎',
  '-1': '👎',
  white_check_mark: '✅',
  checkered_flag: '🏁',
  warning: '⚠️',
  fire: '🔥',
  tada: '🎉',
  star: '⭐',
  sparkles: '✨',
  bug: '🐛',
  memo: '📝',
  bulb: '💡',
  eyes: '👀',
  x: '❌',
  heavy_check_mark: '✔️',
  information_source: 'ℹ️',
});

function replaceGfmEmojiShortcodes(value = '', shortcodes = GFM_EMOJI_SHORTCODES) {
  const text = String(value || '');
  let output = '';
  let index = 0;
  let atLineStart = true;
  let inFence = false;
  let fenceChar = '';
  let fenceLength = 0;

  while (index < text.length) {
    if (atLineStart) {
      const lineEnd = text.indexOf('\n', index);
      const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const marker = fence[1];
        const rest = fence[2] || '';
        const char = marker[0];
        const closing = /^\s*$/.test(rest);
        if (inFence) {
          if (char === fenceChar && marker.length >= fenceLength && closing) {
            inFence = false;
            fenceChar = '';
            fenceLength = 0;
          }
        } else {
          inFence = true;
          fenceChar = char;
          fenceLength = marker.length;
        }
      }
    }

    if (!inFence && text[index] === '`') {
      const ticks = text.slice(index).match(/^`+/)?.[0] || '`';
      const end = text.indexOf(ticks, index + ticks.length);
      if (end !== -1) {
        const code = text.slice(index, end + ticks.length);
        output += code;
        atLineStart = code.endsWith('\n');
        index = end + ticks.length;
        continue;
      }
    }

    if (!inFence && text[index] === ':') {
      const match = text.slice(index).match(/^:([a-zA-Z0-9_+\-]+):/);
      if (match) {
        const emoji = shortcodes[match[1]];
        if (emoji) {
          output += emoji;
          index += match[0].length;
          atLineStart = false;
          continue;
        }
      }
    }

    output += text[index];
    atLineStart = text[index] === '\n';
    index += 1;
  }
  return output;
}

function isMathPlaceholder(value = '') {
  return /^@@MATH\d+@@$/.test(String(value || ''));
}

function extractMathSegments(value = '') {
  const text = String(value || '');
  const math = [];
  let output = '';
  let index = 0;
  let atLineStart = true;
  let inFence = false;
  let fenceChar = '';
  let fenceLength = 0;

  const addMath = (raw, displayMode) => {
    const placeholder = `@@MATH${math.length}@@`;
    math.push({ raw, displayMode });
    output += placeholder;
  };
  const appendChar = () => {
    output += text[index];
    atLineStart = text[index] === '\n';
    index += 1;
  };

  while (index < text.length) {
    if (atLineStart) {
      const lineEnd = text.indexOf('\n', index);
      const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const marker = fence[1];
        const rest = fence[2] || '';
        const char = marker[0];
        const closing = /^\s*$/.test(rest);
        if (inFence) {
          if (char === fenceChar && marker.length >= fenceLength && closing) {
            inFence = false;
            fenceChar = '';
            fenceLength = 0;
          }
        } else {
          inFence = true;
          fenceChar = char;
          fenceLength = marker.length;
        }
      }
    }

    if (inFence) {
      appendChar();
      continue;
    }

    if (text.startsWith('$$', index)) {
      const end = text.indexOf('$$', index + 2);
      if (end !== -1) {
        addMath(text.slice(index + 2, end), true);
        index = end + 2;
        continue;
      }
    }
    if (text.startsWith('\\[', index)) {
      const end = text.indexOf('\\]', index + 2);
      if (end !== -1) {
        addMath(text.slice(index + 2, end), true);
        index = end + 2;
        continue;
      }
    }
    if (text.startsWith('\\(', index)) {
      const end = text.indexOf('\\)', index + 2);
      if (end !== -1) {
        addMath(text.slice(index + 2, end), false);
        index = end + 2;
        continue;
      }
    }
    if (text[index] === '$' && text[index + 1] !== '$') {
      let end = index + 1;
      while (end < text.length && (text[end] !== '$' || text[end - 1] === '\\')) end += 1;
      if (end < text.length && end > index + 1) {
        const raw = text.slice(index + 1, end);
        if (!/^\s*$/.test(raw)) {
          addMath(raw, false);
          index = end + 1;
          continue;
        }
      }
    }
    appendChar();
  }
  return { text: output, math };
}

function restoreMathSegments(value, math = [], { katex = null, escapeHtml = String } = {}) {
  return String(value || '').replace(/@@MATH(\d+)@@/g, (match, index) => {
    const item = math[Number(index)];
    if (!item) return '';
    try {
      if (!katex) throw new Error('KaTeX not loaded');
      return katex.renderToString(item.raw, {
        displayMode: item.displayMode,
        throwOnError: false,
        strict: false,
        trust: false,
        output: 'html',
      });
    } catch {
      return item.displayMode
        ? `<div class="math-fallback">${escapeHtml(item.raw)}</div>`
        : `<span class="math-fallback">${escapeHtml(item.raw)}</span>`;
    }
  });
}

function restoreRawMathSegments(value, math = []) {
  return String(value || '').replace(/@@MATH(\d+)@@/g, (match, index) => {
    const item = math[Number(index)];
    if (!item) return '';
    return item.displayMode ? `$$${item.raw}$$` : `$${item.raw}$`;
  });
}

function slugifyHeading(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[`~!@#$%^&*()+=[\]{};:'",.<>/?\\|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function normalizeExtendedMarkdown(value = '', { renderMarkdown = text => String(text || ''), escapeAttr = String } = {}) {
  const lines = String(value || '').split('\n');
  const footnotes = [];
  const references = new Map();
  const content = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLength = 0;
  let activeFootnote = null;

  const flushFootnote = () => {
    if (!activeFootnote) return;
    const text = (activeFootnote.lines || []).join('\n').trim();
    footnotes.push({ id: activeFootnote.id, text });
    activeFootnote = null;
  };

  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1];
      const rest = fence[2] || '';
      const char = marker[0];
      const closing = /^\s*$/.test(rest);
      if (inFence) {
        if (char === fenceChar && marker.length >= fenceLength && closing) {
          inFence = false;
          fenceChar = '';
          fenceLength = 0;
        }
      } else {
        inFence = true;
        fenceChar = char;
        fenceLength = marker.length;
      }
      if (activeFootnote) activeFootnote.lines.push(line.replace(/^ {4}/, ''));
      else content.push(line);
      continue;
    }

    if (!inFence) {
      const footnote = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
      if (footnote) {
        flushFootnote();
        activeFootnote = { id: footnote[1], lines: [footnote[2]] };
        continue;
      }
      if (activeFootnote) {
        if (/^(?: {2,}|\t)/.test(line)) {
          activeFootnote.lines.push(line.replace(/^(?: {2,}|\t)/, ''));
          continue;
        }
        if (/^\s*$/.test(line)) {
          activeFootnote.lines.push('');
          continue;
        }
        flushFootnote();
      }
      const reference = line.match(/^\[([^\]]+)\]:\s*(\S+)(?:\s+["']([^"']+)["'])?\s*$/);
      if (reference && !reference[1].startsWith('^')) {
        references.set(reference[1].toLowerCase(), { url: reference[2], title: reference[3] || '' });
        content.push(line);
        continue;
      }
    }

    if (activeFootnote) activeFootnote.lines.push(line);
    else content.push(line);
  }
  flushFootnote();

  let normalized = replaceGfmEmojiShortcodes(content.join('\n'));
  normalized = normalized.replace(/!\[([^\]]*)\]\[([^\]]+)\]/g, (match, alt, id) => {
    const reference = references.get(String(id).toLowerCase());
    if (!reference) return match;
    const title = reference.title ? ` "${reference.title.replace(/"/g, '&quot;')}"` : '';
    return `![${alt}](${reference.url}${title})`;
  });
  normalized = normalized.replace(/(?<!!)\[([^\]]+)\]\[([^\]]+)\]/g, (match, text, id) => {
    const reference = references.get(String(id).toLowerCase());
    if (!reference) return match;
    const title = reference.title ? ` "${reference.title.replace(/"/g, '&quot;')}"` : '';
    return `[${text}](${reference.url}${title})`;
  });
  normalized = normalized.replace(/==([^=\n][\s\S]*?[^=\n])==/g, '<mark>$1</mark>');
  normalized = normalized.replace(/~([^~\n]+)~/g, '<sub>$1</sub>');
  normalized = normalized.replace(/\^([^\^\n]+)\^/g, '<sup>$1</sup>');
  normalized = normalized.replace(/\[\^([^\]]+)\]/g, '<sup class="footnote-ref"><a href="#fn-$1" id="fnref-$1">[$1]</a></sup>');

  if (footnotes.length) {
    normalized += '\n\n<section class="footnotes">\n<ol>\n'
      + footnotes.map(item => {
        const html = renderMarkdown(String(item.text || '')).replace(/^<p>|<\/p>$/g, '');
        return `<li id="fn-${escapeAttr(item.id)}">${html} <a href="#fnref-${escapeAttr(item.id)}" class="footnote-backref">↩</a></li>`;
      }).join('\n')
      + '\n</ol>\n</section>';
  }
  return normalized;
}

function repairMarkdownPunctuation(value = '') {
  return String(value || '');
}

function repairCollapsedMarkdownBlocks(value = '') {
  return String(value || '');
}

function splitTableRow(value) {
  return String(value || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function preserveCodeSpans(value = '', prefix = 'MD') {
  const placeholders = [];
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, match => {
      const key = `@@${prefix}_CODE_${placeholders.length}@@`;
      placeholders.push(match);
      return key;
    })
    .replace(/`[^`]*`/g, match => {
      const key = `@@${prefix}_CODE_${placeholders.length}@@`;
      placeholders.push(match);
      return key;
    });
  return { text, placeholders };
}

function restoreCodeSpans(value = '', placeholders = [], prefix = 'MD') {
  let text = String(value || '');
  placeholders.forEach((item, index) => {
    text = text.replace(`@@${prefix}_CODE_${index}@@`, item);
  });
  return text;
}

function normalizeMathExpression(value = '') {
  return String(value || '')
    .replace(/(?:<|&lt;)\s*sup\s*(?:>|&gt;)\s*([^<>&]+?)\s*(?:<|&lt;)\s*\/\s*sup\s*(?:>|&gt;)/gi, '^{$1}')
    .replace(/(?:<|&lt;)\s*sub\s*(?:>|&gt;)\s*([^<>&]+?)\s*(?:<|&lt;)\s*\/\s*sub\s*(?:>|&gt;)/gi, '_{$1}')
    .replace(/\^\s*\{\s*([^{}]+?)\s*\}/g, '^{$1}')
    .replace(/_\s*\{\s*([^{}]+?)\s*\}/g, '_{$1}');
}

function repairLooseMathHtml(value = '') {
  const preserved = preserveCodeSpans(value, 'MATHHTML');
  const text = normalizeMathExpression(preserved.text);
  return restoreCodeSpans(text, preserved.placeholders, 'MATHHTML');
}

function replaceOutsideMathPlaceholders(text = '', replacer = value => value) {
  return String(text || '').split(/(@@MATH\d+@@)/g).map(part => (isMathPlaceholder(part) ? part : replacer(part))).join('');
}

function normalizeLooseMath(value = '') {
  const code = preserveCodeSpans(value, 'LOOSEMATH');
  const links = [];
  let protectedText = code.text.replace(/!?\[[^\]\n]*\]\([^\s)]+(?:\s+"[^"]*")?\)/g, match => {
    const key = `@@LOOSEMATH_LINK_${links.length}@@`;
    links.push(match);
    return key;
  });
  const math = extractMathSegments(protectedText);
  let text = replaceOutsideMathPlaceholders(math.text, part => part
    .replace(/(?<![\w$])([A-Za-z]|\d+)\s*\^\s*([+-]?\d+|[A-Za-z])(?![\w$])/g, (_, base, exp) => `$${base}^{${exp}}$`)
    .replace(/(?<![\w$])([A-Za-z])\s*_\s*([+-]?\d+|[A-Za-z])(?![\w$])/g, (_, base, sub) => `$${base}_{${sub}}$`));
  text = restoreRawMathSegments(text, math.math);
  links.forEach((item, index) => {
    text = text.replace(`@@LOOSEMATH_LINK_${index}@@`, item);
  });
  return restoreCodeSpans(text, code.placeholders, 'LOOSEMATH');
}

function prepareMarkdownSource(value = '') {
  return normalizeExtendedMarkdown(normalizeLooseMath(repairLooseMathHtml(repairCollapsedMarkdownBlocks(repairMarkdownPunctuation(value)))));
}

function renderLists(value) {
  const lines = String(value || '').split('\n');
  const output = [];
  let inUnordered = false;
  let inOrdered = false;

  function closeLists() {
    if (inUnordered) {
      output.push('</ul>');
      inUnordered = false;
    }
    if (inOrdered) {
      output.push('</ol>');
      inOrdered = false;
    }
  }

  for (const line of lines) {
    const unordered = line.match(/^\s*[-*]\s+(.+)/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)/);
    if (unordered) {
      if (inOrdered) closeLists();
      if (!inUnordered) {
        output.push('<ul>');
        inUnordered = true;
      }
      output.push(`<li>${unordered[1]}</li>`);
    } else if (ordered) {
      if (inUnordered) closeLists();
      if (!inOrdered) {
        output.push('<ol>');
        inOrdered = true;
      }
      output.push(`<li>${ordered[1]}</li>`);
    } else {
      closeLists();
      output.push(line);
    }
  }
  closeLists();
  return output.join('\n');
}

function renderLegacyCodeBlockHtml(block, { escapeHtml = String, escapeAttr = String, copyIconSvg = '' } = {}) {
  const raw = String(block?.raw || '');
  const lang = /^(?:text|txt|plain|plaintext)$/i.test(block?.lang || '') ? '' : String(block?.lang || '');
  const langHtml = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
  const copyButton = `<button class="inline-copy code-copy-icon" type="button" title="复制代码" aria-label="复制代码" data-copy-text="${escapeAttr(raw)}">${copyIconSvg}</button>`;
  return `<div class="code-block">${langHtml}${copyButton}<pre><code>${escapeHtml(raw)}</code></pre></div>`;
}

function extractLegacyCodeBlocks(value) {
  const blocks = [];
  const text = String(value || '').replace(/```([\w-]*)?\n?([\s\S]*?)```/g, (match, lang, rawCode) => {
    const raw = String(rawCode || '').replace(/\n$/, '');
    if (!raw.trim()) return '';
    const placeholder = `@@CODE${blocks.length}@@`;
    blocks.push({ lang: lang || '', raw });
    return placeholder;
  });
  return { text, blocks };
}

function restoreLegacyCodeBlocks(value, blocks = [], options = {}) {
  let output = String(value || '');
  blocks.forEach((block, index) => {
    output = output.replace(`@@CODE${index}@@`, renderLegacyCodeBlockHtml(block, options));
  });
  return output;
}

function renderLegacyInlineMarkdown(value) {
  return String(value || '')
    .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]*?)__/g, '<strong>$1</strong>')
    .replace(/~~([\s\S]*?)~~/g, '<del>$1</del>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" />')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function wrapLegacyParagraphs(value) {
  return String(value || '').split(/\n{2,}/)
    .map(block => /^\s*<(h\d|ul|ol|blockquote|pre|div|table|hr|img)/.test(block) ? block : `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function renderMarkdownLegacy(value, { escapeHtml = String, escapeAttr = String, copyIconSvg = '' } = {}) {
  const extracted = extractLegacyCodeBlocks(value);
  let html = escapeHtml(extracted.text);
  html = renderTables(html);
  html = renderLegacyInlineMarkdown(html);
  html = renderLists(html);
  html = wrapLegacyParagraphs(html);
  return restoreLegacyCodeBlocks(html, extracted.blocks, { escapeHtml, escapeAttr, copyIconSvg });
}

function renderTables(value) {
  const lines = String(value || '').split('\n');
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (
      index + 1 < lines.length
      && /^\s*\|.*\|\s*$/.test(lines[index])
      && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])
    ) {
      const headers = splitTableRow(lines[index]);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      const thead = `<thead><tr>${headers.map(cell => `<th>${cell}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td>${row[cellIndex] || ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
    } else {
      out.push(lines[index]);
    }
  }
  return out.join('\n');
}

module.exports = {
  GFM_EMOJI_SHORTCODES,
  replaceGfmEmojiShortcodes,
  normalizeExtendedMarkdown,
  prepareMarkdownSource,
  renderLists,
  renderLegacyCodeBlockHtml,
  extractLegacyCodeBlocks,
  restoreLegacyCodeBlocks,
  renderLegacyInlineMarkdown,
  wrapLegacyParagraphs,
  renderMarkdownLegacy,
  extractMathSegments,
  restoreMathSegments,
  restoreRawMathSegments,
  slugifyHeading,
  repairMarkdownPunctuation,
  repairCollapsedMarkdownBlocks,
  preserveCodeSpans,
  restoreCodeSpans,
  normalizeMathExpression,
  repairLooseMathHtml,
  normalizeLooseMath,
  splitTableRow,
  renderTables,
};
