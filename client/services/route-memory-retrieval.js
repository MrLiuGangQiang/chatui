(function initChatUIRouteMemoryRetrieval(root) {
  'use strict';

  const IMAGE_MEMORY_RETRIEVAL_POLICY = Object.freeze({
    semanticLimit: 12,
    structuredLimit: 12,
    earlyHistoryLimit: 4,
  });
  const CHINESE_ORDINAL_DIGITS = Object.freeze({
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  });
  const CHINESE_ORDINAL_UNITS = Object.freeze({ 十: 10, 百: 100, 千: 1000, 万: 10000 });
  const ORDINAL_NUMBER_SOURCE = '[0-9一二两三四五六七八九十百千万〇零]+';
  const HISTORICAL_MEMORY_SCOPE_PATTERN = /(?:历史|之前|此前|以前|前面|过去|早先|先前|会话|生成|生图|画过|做过|创作|history|previous|earlier|generation|generated)/i;
  const EARLY_MEMORY_PATTERN = /(?:很早之前|很久之前|早先|最前面|前期).{0,12}(?:图|图片|图像|照片|作品|image|photo)|(?:图|图片|图像|照片|作品|image|photo).{0,12}(?:很早之前|很久之前|早先|最前面|前期)/i;
  const EARLIEST_MEMORY_PATTERN = /(?:最早|一开始|最开始).{0,20}(?:图|图片|图像|照片|作品|image|photo)/i;

  function createRouteMemoryRetriever({
    policy = IMAGE_MEMORY_RETRIEVAL_POLICY,
    sharedCandidateTokens = () => [],
  } = {}) {
    const retrievalPolicy = Object.freeze({
      semanticLimit: positiveInteger(policy?.semanticLimit, IMAGE_MEMORY_RETRIEVAL_POLICY.semanticLimit),
      structuredLimit: positiveInteger(policy?.structuredLimit, IMAGE_MEMORY_RETRIEVAL_POLICY.structuredLimit),
      earlyHistoryLimit: positiveInteger(policy?.earlyHistoryLimit, IMAGE_MEMORY_RETRIEVAL_POLICY.earlyHistoryLimit),
    });

    function positiveInteger(value, fallback) {
      const number = Number(value);
      return Number.isSafeInteger(number) && number >= 1 ? number : fallback;
    }

    function stringValue(value) {
      return String(value ?? '').trim();
    }

    function uniqueStrings(values = []) {
      const seen = new Set();
      const result = [];
      for (const value of values) {
        const normalized = stringValue(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
      }
      return result;
    }

    function candidateTokens(input, card) {
      const values = sharedCandidateTokens(input, card);
      return Array.isArray(values) ? values : [];
    }

    function parseOrdinalNumber(value = '') {
      const text = stringValue(value).replace(/\s+/g, '');
      if (!text) return 0;
      if (/^\d+$/.test(text)) {
        const number = Number(text);
        return Number.isSafeInteger(number) && number >= 1 ? number : 0;
      }
      if (![...text].every(char => CHINESE_ORDINAL_DIGITS[char] !== undefined || CHINESE_ORDINAL_UNITS[char])) return 0;
      if (![...text].some(char => CHINESE_ORDINAL_UNITS[char])) {
        const number = Number([...text].map(char => CHINESE_ORDINAL_DIGITS[char]).join(''));
        return Number.isSafeInteger(number) && number >= 1 ? number : 0;
      }
      let total = 0;
      let section = 0;
      let digit = 0;
      for (const char of text) {
        if (CHINESE_ORDINAL_DIGITS[char] !== undefined) {
          digit = CHINESE_ORDINAL_DIGITS[char];
          continue;
        }
        const unit = CHINESE_ORDINAL_UNITS[char];
        if (unit === 10000) {
          section = (section + digit) * unit;
          total += section;
          section = 0;
          digit = 0;
        } else {
          section += (digit || 1) * unit;
          digit = 0;
        }
      }
      const number = total + section + digit;
      return Number.isSafeInteger(number) && number >= 1 ? number : 0;
    }

    function firstOrdinalMatch(text = '', patterns = []) {
      for (const pattern of patterns) {
        const match = pattern.exec(text);
        const value = parseOrdinalNumber(match?.[1]);
        if (value) return value;
      }
      return 0;
    }

    function memoryIdentityValues(value = {}) {
      return uniqueStrings([
        value?.resource_id, value?.resourceId,
        value?.id, value?.image_id, value?.imageId,
        value?.reference_id, value?.referenceId,
        ...(Array.isArray(value?.identity_aliases) ? value.identity_aliases : []),
        ...(Array.isArray(value?.identityAliases) ? value.identityAliases : []),
      ]);
    }

    function clarificationMemoryIdentitySet(context = {}) {
      const clarification = context?.clarification_context;
      if (!clarification || typeof clarification !== 'object') return new Set();
      const resources = [
        ...(Array.isArray(clarification.established_resources) ? clarification.established_resources : []),
        ...(Array.isArray(clarification.selected_resources) ? clarification.selected_resources : []),
      ];
      return new Set(resources.flatMap(memoryIdentityValues));
    }

    function structuredImageMemorySelection(input = '', cards = [], hasCurrentImages = false) {
      const text = stringValue(input);
      if (!text || !cards.length) return null;
      const ordinal = group => new RegExp(group.replace('{n}', `(${ORDINAL_NUMBER_SOURCE})`), 'i');
      const reverseGeneration = firstOrdinalMatch(text, [
        ordinal('倒数\\s*第?\\s*{n}\\s*(?:次|轮)(?:\\s*(?:生成|生图|绘制|作图|创作))?'),
        /(?:the\s+)?(\d+)(?:st|nd|rd|th)?\s+(?:generation|generated image)\s+from\s+(?:the\s+)?(?:last|end)/i,
      ]);
      if (reverseGeneration) return cards.filter(card => Number(card?.generation_recency_index) === reverseGeneration);

      const absoluteGeneration = firstOrdinalMatch(text, [
        ordinal('第\\s*{n}\\s*(?:次|轮)\\s*(?:生成|生图|绘制|作图|创作)?'),
        /(?:the\s+)?(\d+)(?:st|nd|rd|th)?\s+(?:generation|generated image)/i,
      ]);
      if (absoluteGeneration) return cards.filter(card => Number(card?.generation_index) === absoluteGeneration);

      const messageIndex = firstOrdinalMatch(text, [
        ordinal('第\\s*{n}\\s*(?:条|轮)(?:消息|对话|回复)[^。！？!?\\n]{0,12}(?:图|图片|图像|照片)'),
      ]);
      if (messageIndex) return cards.filter(card => Number(card?.message_index) === messageIndex);

      if (EARLIEST_MEMORY_PATTERN.test(text)) {
        return cards.filter(card => Number(card?.generation_index) === 1);
      }
      if (EARLY_MEMORY_PATTERN.test(text)) {
        return [...cards]
          .sort((left, right) => Number(left?.chronological_index) - Number(right?.chronological_index))
          .slice(0, retrievalPolicy.earlyHistoryLimit);
      }

      const historicalScope = HISTORICAL_MEMORY_SCOPE_PATTERN.test(text);
      if (!historicalScope || hasCurrentImages) return null;
      const reverseImage = firstOrdinalMatch(text, [
        ordinal('倒数\\s*第?\\s*{n}\\s*张(?:\\s*(?:图|图片|图像|照片))?'),
      ]);
      if (reverseImage) return cards.filter(card => Number(card?.memory_index) === reverseImage);
      const absoluteImage = firstOrdinalMatch(text, [
        ordinal('第\\s*{n}\\s*张(?:\\s*(?:图|图片|图像|照片))?'),
      ]);
      if (absoluteImage) return cards.filter(card => Number(card?.chronological_index) === absoluteImage);
      return null;
    }

    function selectImageMemoryCards(input = '', cards = [], context = {}, existingCandidates = []) {
      const imageCards = (Array.isArray(cards) ? cards : []).filter(card => card?.type === 'image');
      const protectedIdentities = clarificationMemoryIdentitySet(context);
      const protectedCards = imageCards.filter(card => (
        memoryIdentityValues(card).some(identity => protectedIdentities.has(identity))
      ));
      const hasCurrentImages = (Array.isArray(existingCandidates) ? existingCandidates : [])
        .some(candidate => candidate?.type === 'image' && candidate?.source === 'current');
      const structured = structuredImageMemorySelection(input, imageCards, hasCurrentImages);
      const semantic = structured === null
        ? imageCards.filter(card => stringValue(input) && candidateTokens(input, card).length > 0)
          .sort((left, right) => {
            const scoreDelta = candidateTokens(input, right).length - candidateTokens(input, left).length;
            return scoreDelta || Number(left?.memory_index) - Number(right?.memory_index);
          })
        : [];
      const strategy = structured !== null ? 'structured' : 'semantic';
      const eligible = structured !== null ? structured : semantic;
      const limit = structured !== null ? retrievalPolicy.structuredLimit : retrievalPolicy.semanticLimit;
      const selected = [];
      const seen = new Set();
      const append = (card, retrieval) => {
        const identity = memoryIdentityValues(card)[0] || `${card?.reference_id || ''}|${card?.memory_index || ''}`;
        if (!identity || seen.has(identity)) return;
        seen.add(identity);
        selected.push({ ...card, memory_retrieval: retrieval });
      };
      protectedCards.forEach(card => append(card, 'clarification'));
      eligible.slice(0, limit).forEach(card => append(card, strategy));
      return {
        cards: selected,
        metadata: Object.freeze({
          total_count: imageCards.length,
          eligible_count: eligible.length,
          published_count: selected.length,
          truncated: eligible.length > limit,
          strategies: Object.freeze([...new Set(selected.map(card => card.memory_retrieval))]),
        }),
      };
    }

    return Object.freeze({
      policy: retrievalPolicy,
      parseOrdinalNumber,
      structuredImageMemorySelection,
      selectImageMemoryCards,
    });
  }

  const api = Object.freeze({ IMAGE_MEMORY_RETRIEVAL_POLICY, createRouteMemoryRetriever });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeMemoryRetrieval', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);