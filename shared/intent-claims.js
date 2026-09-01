(function initChatUIIntentClaims(root, factory) {
  'use strict';

  const capabilityRegistry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('capabilityRegistry')
    || root?.ChatUICapabilityRegistry
    || (typeof require === 'function' ? require('./capability-registry') : {});
  const api = factory(capabilityRegistry);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('intentClaims', api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createChatUIIntentClaims(capabilityRegistry) {
  'use strict';

  capabilityRegistry = capabilityRegistry || {};

  const INTENT_CLAIMS_VERSION = 'intent_claims.v1';
  const ORDINAL_DIGITS = Object.freeze({
    '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  });

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function ordinalValue(value = '') {
    const text = stringValue(value);
    if (/^\d+$/.test(text)) return Number(text);
    if (text === '十') return 10;
    if (text.includes('十')) {
      const [left, right] = text.split('十');
      const tens = left ? ORDINAL_DIGITS[left] : 1;
      const ones = right ? ORDINAL_DIGITS[right] : 0;
      return Number.isInteger(tens) && Number.isInteger(ones) ? tens * 10 + ones : 0;
    }
    return ORDINAL_DIGITS[text] || 0;
  }

  function ordinalForms(index) {
    const value = Number(index);
    if (!Number.isInteger(value) || value < 1) return [];
    const chinese = Object.entries(ORDINAL_DIGITS).find(([, number]) => number === value)?.[0] || '';
    const forms = [`第${value}张`, `第${value}个`, `第${value}份`, `${value}张`, `${value}个`];
    if (chinese) forms.push(`第${chinese}张`, `第${chinese}个`, `第${chinese}份`);
    return [...new Set(forms)];
  }

  function explicitSelectors(input = '') {
    const text = stringValue(input);
    const selectors = [];
    const pattern = /第\s*([1-9]\d*|[一二两三四五六七八九十]+)\s*(张|幅|个|份|篇|号)?\s*(图片|图像|照片|图|文件|附件|文档)?/giu;
    for (const match of text.matchAll(pattern)) {
      const index = ordinalValue(match[1]);
      if (!index) continue;
      const noun = stringValue(match[3]);
      const type = /文件|附件|文档|篇/.test(noun) ? 'file' : 'image';
      selectors.push(Object.freeze({
        kind: 'selector',
        index,
        type,
        text: stringValue(match[0]),
        start: Number(match.index) || 0,
        end: (Number(match.index) || 0) + stringValue(match[0]).length,
      }));
    }
    return selectors;
  }

  function explicitExclusions(input = '') {
    const text = stringValue(input);
    const exclusions = [];
    const selector = /第\s*([1-9]\d*|[一二两三四五六七八九十]+)\s*(?:张|幅|个)?\s*(?:图片|图像|照片|图)?|上一张|这张|那张|目标图|目标图片/giu;
    for (const match of text.matchAll(selector)) {
      const start = Number(match.index) || 0;
      const end = start + stringValue(match[0]).length;
      const before = text.slice(Math.max(0, start - 18), start);
      const after = text.slice(end, end + 24);
      const directlyNegated = /(?:不要|别|不改|不修改|不动|不处理|无需修改|保持(?:不变|原样)|保留(?:不变|原样)|不得修改)\s*$/i.test(before)
        || /^(?:不要|别|不改|不修改|不动|不处理|无需修改|保持(?:不变|原样)|保留(?:不变|原样)|不得修改)/i.test(after);
      if (!directlyNegated) continue;
      const ordinalMatch = /^第\s*([1-9]\d*|[一二两三四五六七八九十]+)/iu.exec(stringValue(match[0]));
      exclusions.push(Object.freeze({
        kind: 'exclusion',
        text: stringValue(match[0]),
        clause: text.slice(Math.max(0, start - 12), Math.min(text.length, end + 32)),
        index: ordinalMatch ? ordinalValue(ordinalMatch[1]) : 0,
        type: 'image',
      }));
    }
    return exclusions;
  }

  function hasExplicitComparison(input = '') {
    return /(?:比较|对比|差异|异同|逐项|分别比较|compare|contrast|difference|differences)/i.test(stringValue(input));
  }

  function hasImageRankingQuestion(input = '') {
    return /(?:哪个|哪张|哪一张|哪幅|效果最好|更好|更合适|最合适|哪个好|哪一个)/i.test(stringValue(input));
  }

  function hasIndependentOutputClaim(input = '') {
    const text = stringValue(input);
    return /(?:分别|各自|逐张|每张|每个|独立(?:生成|编辑|结果)|各生成|各修改|separately|respectively|each)/i.test(text)
      || /(?:生成|画|绘制|制作|修改|编辑|改成|改为)[^。！？!\r\n]{0,24}(?:两张|三张|四张|两幅|三幅|two|three|four)/i.test(text);
  }

  function isHistoricalTextQuestion(input = '') {
    const text = stringValue(input);
    const historical = /(?:上一个|上一版|上次|之前|刚才|历史|前面|上一轮|previous|last|earlier|history)/i.test(text);
    const visual = /(?:图片|图像|照片|画面|图|image|photo|picture)/i.test(text);
    const textTask = /(?:要求|规范|含义|意思|解释|两句话|说明|多宽|多大|怎么理解|what does|meaning|explain)/i.test(text);
    const file = /(?:文件|附件|文档|pdf|报告|file|document|pdf|report)/i.test(text);
    return historical && textTask && !visual && !file;
  }

  // Explicit online lookups. A chat model cannot answer a "最新/最近 + 信息类
  // 名词" request without web access, so the request itself is a deterministic
  // web_search fact, not a semantic guess. The capability registry's
  // web_search directive is the single source of truth for this phrasing; this
  // claim only publishes that fact as model evidence and never re-implements
  // the phrase lists.
  const isExplicitWebLookup = typeof capabilityRegistry.isExplicitWebLookup === 'function'
    ? capabilityRegistry.isExplicitWebLookup
    : () => false;

  function hasWebSearchRequest(input = '') {
    return isExplicitWebLookup(input);
  }

  function extractClaims(input = '') {
    const text = stringValue(input);
    const claims = [];
    explicitSelectors(text).forEach((selector, index) => claims.push(Object.freeze({
      id: `selector_${index + 1}`,
      type: 'resource_selector',
      text: selector.text,
      critical: true,
      value: selector,
    })));
    explicitExclusions(text).forEach((exclusion, index) => claims.push(Object.freeze({
      id: `exclusion_${index + 1}`,
      type: 'resource_exclusion',
      text: exclusion.clause,
      critical: true,
      value: exclusion,
    })));
    if (hasImageRankingQuestion(text) && !hasExplicitComparison(text)) {
      claims.push(Object.freeze({
        id: 'image_ranking_question',
        type: 'image_ranking_question',
        text,
        critical: true,
        value: Object.freeze({ operation: 'image_qa' }),
      }));
    }
    if (hasWebSearchRequest(text)) {
      claims.push(Object.freeze({
        id: 'web_search_request',
        type: 'web_search_request',
        text,
        critical: true,
        value: Object.freeze({ operation: 'web_search' }),
      }));
    }
    if (hasIndependentOutputClaim(text)) {
      claims.push(Object.freeze({
        id: 'independent_output_count',
        type: 'independent_output_count',
        text,
        critical: true,
        value: Object.freeze({ independent: true }),
      }));
    }
    if (isHistoricalTextQuestion(text)) {
      claims.push(Object.freeze({
        id: 'historical_text_question',
        type: 'historical_text_question',
        text,
        critical: true,
        value: Object.freeze({ no_media_binding: true }),
      }));
    }
    return Object.freeze(claims);
  }

  function containsAny(text, values = []) {
    const normalized = stringValue(text);
    return (Array.isArray(values) ? values : []).some(value => normalized.includes(stringValue(value)));
  }

  return Object.freeze({
    INTENT_CLAIMS_VERSION,
    ordinalValue,
    ordinalForms,
    explicitSelectors,
    explicitExclusions,
    hasExplicitComparison,
    hasImageRankingQuestion,
    hasWebSearchRequest,
    hasIndependentOutputClaim,
    isHistoricalTextQuestion,
    extractClaims,
  });
});
