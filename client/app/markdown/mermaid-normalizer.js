(function initChatUIMarkdownMermaidNormalizer(global) {
  'use strict';

  function mermaidSafeId(value = '', fallback = 'item') {
    const ascii = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    if (ascii && /^[a-z]/.test(ascii)) return ascii;
    return fallback;
  }

  function mermaidQuoteLabel(value = '') {
    return String(value || '').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function normalizeArchitectureMermaidSource(source = '') {
    const text = String(source || '');
    if (!/^\s*architecture-beta\b/i.test(text)) return text;
    return text.replace(/\[([^\]\n]*[^\x00-\x7F][^\]\n]*)\]/g, (all, label) => {
      const trimmed = String(label || '').trim();
      if (!trimmed || /^['].+[']$/.test(trimmed) || /^["].+["]$/.test(trimmed)) return all;
      return `["${mermaidQuoteLabel(trimmed)}"]`;
    });
  }

  function getSankeyLabelReplacements(source = '') {
    const text = String(source || '');
    if (!/^\s*sankey-beta\b/i.test(text)) return [];
    const seen = new Map();
    const replacements = [];
    const labelFor = (raw) => {
      const label = String(raw || '').trim();
      if (!label || /^[\x00-\x7F]+$/.test(label)) return label;
      if (!seen.has(label)) {
        const id = `sankey_node_${seen.size + 1}`;
        seen.set(label, id);
        replacements.push({ id, label });
      }
      return seen.get(label);
    };
    text.split(/\r?\n/).slice(1).forEach((line) => {
      const parts = line.trim().split(',');
      if (parts.length >= 3) {
        labelFor(parts[0]);
        labelFor(parts[1]);
      }
    });
    return replacements;
  }

  function restoreSankeySvgLabels(container, source = '') {
    const replacements = getSankeyLabelReplacements(source);
    if (!replacements.length || !container?.querySelectorAll) return;
    const map = new Map(replacements.map(item => [item.id, item.label]));
    container.querySelectorAll('text').forEach((node) => {
      for (const [id, label] of map) {
        if ((node.textContent || '').includes(id)) node.textContent = String(node.textContent || '').replaceAll(id, label);
      }
    });
  }

  function normalizeSankeyMermaidSource(source = '') {
    const text = String(source || '');
    if (!/^\s*sankey-beta\b/i.test(text)) return text;
    const replacements = getSankeyLabelReplacements(text);
    const map = new Map(replacements.map(item => [item.label, item.id]));
    return text.split(/\r?\n/).map((line, index) => {
      if (index === 0) return line.trim();
      const parts = line.trim().split(',');
      if (parts.length >= 3) {
        parts[0] = map.get(parts[0].trim()) || parts[0].trim();
        parts[1] = map.get(parts[1].trim()) || parts[1].trim();
        return parts.join(',');
      }
      return line.trimStart();
    }).join('\n');
  }

  function normalizeRadarMermaidSource(source = '') {
    const text = String(source || '');
    if (!/^\s*radar-beta\b/i.test(text)) return text;
    const lines = text.split(/\r?\n/);
    const out = [];
    let curveCount = 0;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) { out.push(''); continue; }
      if (/^radar-beta\b/i.test(line)) { out.push('radar-beta'); continue; }
      const axisMatch = line.match(/^axis\s+(.+)$/i);
      if (axisMatch && !/[\[{]/.test(axisMatch[1])) {
        const axisLabels = axisMatch[1].split(',').map(item => item.trim()).filter(Boolean);
        out.push('axis ' + axisLabels.map((label, index) => `${mermaidSafeId(label, `axis${index + 1}`)}["${mermaidQuoteLabel(label)}"]`).join(', '));
        continue;
      }
      const curveMatch = line.match(/^(?:["']([^"']+)["']|([^:]+))\s*:\s*([\d.,\s+-]+)$/);
      if (curveMatch) {
        curveCount += 1;
        const label = String(curveMatch[1] || curveMatch[2] || `curve${curveCount}`).trim();
        const values = String(curveMatch[3] || '').split(',').map(item => item.trim()).filter(Boolean).join(', ');
        out.push(`curve ${mermaidSafeId(label, `curve${curveCount}`)}["${mermaidQuoteLabel(label)}"]{${values}}`);
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  function normalizeBetaMermaidSource(source = '') {
    let text = String(source || '');
    text = normalizeSankeyMermaidSource(text);
    text = normalizeRadarMermaidSource(text);
    text = normalizeArchitectureMermaidSource(text);
    return text;
  }

  const api = Object.freeze({
    mermaidSafeId,
    mermaidQuoteLabel,
    normalizeArchitectureMermaidSource,
    getSankeyLabelReplacements,
    restoreSankeySvgLabels,
    normalizeSankeyMermaidSource,
    normalizeRadarMermaidSource,
    normalizeBetaMermaidSource,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIMarkdownMermaidNormalizer = api;
})(typeof window !== 'undefined' ? window : globalThis);
