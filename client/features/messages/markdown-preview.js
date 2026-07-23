(function initChatUIFeaturesMessagesMarkdownPreview(root) {
  'use strict';

  function escapeHtml(value = '') {
    return String(value ?? '').replace(/[&<>"'`]/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
    }[ch]));
  }

  function renderInline(value = '') {
    const codeTokens = [];
    let text = String(value ?? '').replace(/`([^`]+)`/g, (_, code) => {
      const index = codeTokens.push('<code>' + escapeHtml(code) + '</code>') - 1;
      return `\u0000${index}\u0000`;
    });
    text = escapeHtml(text);
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    return text.replace(/\u0000(\d+)\u0000/g, (_, index) => codeTokens[Number(index)] || '');
  }

  function splitTableRow(line = '') {
    const source = String(line || '').trim();
    let start = source.startsWith('|') ? 1 : 0;
    let end = source.length;
    if (end > start && source.endsWith('|') && source[end - 2] !== '\\') end -= 1;
    const cells = [];
    let cell = '';
    for (let index = start; index < end; index += 1) {
      const character = source[index];
      const next = source[index + 1];
      if (character === '\\' && (next === '|' || next === '\\')) { cell += next; index += 1; continue; }
      if (character === '|') { cells.push(cell.trim()); cell = ''; continue; }
      cell += character;
    }
    cells.push(cell.trim());
    return cells;
  }

  function isTableSeparator(line = '') {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ''));
  }

  function tableAlignments(line = '') {
    return splitTableRow(line).map(value => {
      if (/^:\s*-{3,}\s*:$/.test(value)) return 'center';
      if (/^:\s*-{3,}\s*$/.test(value)) return 'left';
      if (/^-{3,}\s*:$/.test(value)) return 'right';
      return 'left';
    });
  }

  function alignedCell(tag, value, alignment = '') {
    const className = alignment ? ` class="md-align-${alignment}"` : '';
    return `<${tag}${className}>${renderInline(value)}</${tag}>`;
  }

  function renderMarkdownPreview(source = '') {
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let paragraph = [];
    let listType = '';
    let inFence = false;
    let fenceLines = [];

    const closeParagraph = () => {
      if (!paragraph.length) return;
      html.push('<p>' + renderInline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    };
    const closeList = () => {
      if (!listType) return;
      html.push(`</${listType}>`);
      listType = '';
    };
    const openList = type => {
      closeParagraph();
      if (listType === type) return;
      closeList();
      listType = type;
      html.push(`<${type}>`);
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      const fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
      if (fence) {
        closeParagraph();
        closeList();
        if (inFence) {
          html.push('<pre class="markdown-preview-code"><code>' + escapeHtml(fenceLines.join('\n')) + '</code></pre>');
          fenceLines = [];
          inFence = false;
        } else {
          inFence = true;
          fenceLines = [];
        }
        continue;
      }
      if (inFence) {
        fenceLines.push(line);
        continue;
      }
      if (!trimmed) {
        closeParagraph();
        closeList();
        continue;
      }

      const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        closeParagraph();
        closeList();
        const level = Math.min(4, Math.max(2, heading[1].length + 1));
        html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }

      if (i + 1 < lines.length && trimmed.includes('|') && isTableSeparator(lines[i + 1])) {
        closeParagraph();
        closeList();
        const headers = splitTableRow(trimmed);
        const alignments = tableAlignments(lines[i + 1]);
        const body = [];
        i += 2;
        while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim()) {
          body.push(splitTableRow(lines[i]));
          i += 1;
        }
        i -= 1;
        html.push('<div class="markdown-preview-table-wrap table-wrap"><table><thead><tr>' + headers.map((cell, index) => alignedCell('th', cell, alignments[index])).join('') + '</tr></thead><tbody>' + body.map(row => '<tr>' + row.map((cell, index) => alignedCell('td', cell, alignments[index])).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }

      const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
      if (unordered) {
        openList('ul');
        html.push('<li>' + renderInline(unordered[1]) + '</li>');
        continue;
      }
      const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (ordered) {
        openList('ol');
        html.push('<li>' + renderInline(ordered[1]) + '</li>');
        continue;
      }
      const quote = trimmed.match(/^>\s?(.+)$/);
      if (quote) {
        closeParagraph();
        closeList();
        html.push('<blockquote>' + renderInline(quote[1]) + '</blockquote>');
        continue;
      }
      paragraph.push(trimmed);
    }

    if (inFence) html.push('<pre class="markdown-preview-code"><code>' + escapeHtml(fenceLines.join('\n')) + '</code></pre>');
    closeParagraph();
    closeList();
    return '<div class="markdown-preview-lite markdown-body">' + html.join('') + '</div>';
  }

  const api = Object.freeze({ renderMarkdownPreview, escapeHtml });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatUIFeaturesMessagesMarkdownPreview = api;
  if (root?.window) root.window.ChatUIFeaturesMessagesMarkdownPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
