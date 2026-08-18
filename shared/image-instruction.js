(function initChatUIImageInstruction(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('imageInstruction', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIImageInstruction() {
  'use strict';

  const IMAGE_INSTRUCTION_VERSION = 'image_instruction.v1';
  const IMAGE_INSTRUCTION_FIELDS = Object.freeze(['schema_version', 'status', 'instruction', 'clarification']);
  const IMAGE_INSTRUCTION_STATUSES = Object.freeze(['ready', 'needs_clarification']);
  const IMAGE_INSTRUCTION_MAX_LENGTH = 4000;
  const IMAGE_INSTRUCTION_MAX_CLARIFICATION_LENGTH = 400;

  // A structured response alone cannot prove semantic completeness. This
  // execution-boundary invariant rejects provider-facing instructions that ask a
  // downstream model to resolve conversational references. It deliberately
  // never tries to expand or guess what those references mean.
  const UNRESOLVED_IMAGE_INSTRUCTION_REFERENCE_PATTERN = /(?:\b(?:according to|as (?:you|above)|the (?:above|previous|first|second) (?:plan|option|prompt|suggestion)|use (?:plan|option)\s*[a-z0-9]+|continue (?:it|that|the above|the previous)|regenerate (?:it|that|the above|the previous))\b|(?:按(?:照)?|依照|根据|参照|参考|沿用|套用|采用|选择|选用|照|基于)(?:你(?:刚才|上一次|上一轮)?(?:的)?|上(?:述|面|一条|一次)?(?:的)?|前(?:面|一条|一次)?(?:的)?|刚才(?:的)?|之(?:前)(?:的)?|这(?:个|条|份)(?:的)?|那(?:个|条|份)(?:的)?|第[一二三四五六七八九十0-9]+(?:个|条|项|种|版|份)?(?:方案|选项|版本|建议|提示词|描述)|(?:方案|选项|版本|建议|提示词|描述)\s*[a-z0-9一二三四五六七八九十]+)|(?:^|[\s，。；:：])(?:上(?:述|面)|以(?:上|前)|前(?:面|一条)|刚才|之前|这(?:个|条|份)|那(?:个|条|份))(?:的)?(?:内容|方案|选项|版本|建议|提示词|描述|要求)(?:$|[\s，。；:：]))/i;

  const IMAGE_INSTRUCTION_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_image_instruction_v1',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...IMAGE_INSTRUCTION_FIELDS],
        properties: {
          schema_version: { type: 'string', const: IMAGE_INSTRUCTION_VERSION },
          status: { type: 'string', enum: [...IMAGE_INSTRUCTION_STATUSES] },
          instruction: { type: 'string', maxLength: IMAGE_INSTRUCTION_MAX_LENGTH },
          clarification: { type: 'string', maxLength: IMAGE_INSTRUCTION_MAX_CLARIFICATION_LENGTH },
        },
      },
    },
  });

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  // A reference is only unresolved when the model actually asks a downstream
  // step to reuse it. "不参考/不要沿用/无需根据" explicitly negate the reference,
  // which makes the instruction self-contained; only a non-negated reference
  // (and a negation on the other side of a sentence boundary) is unresolved.
  const NEGATION_MARKER_PATTERN = /(?:无需|无须|不用|不必|不需|不|勿|别|禁止|don'?t|cannot|can'?t|not|never)/i;
  const SENTENCE_BOUNDARY_PATTERN = /[。！？；!?;]/;

  function hasNegatedReferenceWindow(text = '', index = 0) {
    const start = Math.max(0, index - 12);
    const window = text.slice(start, index);
    if (!NEGATION_MARKER_PATTERN.test(window)) return false;
    return !SENTENCE_BOUNDARY_PATTERN.test(window);
  }

  function hasUnresolvedImageInstructionReference(instruction = '') {
    const text = stringValue(instruction);
    if (!text) return false;
    const baseFlags = UNRESOLVED_IMAGE_INSTRUCTION_REFERENCE_PATTERN.flags;
    const flags = baseFlags.includes('g') ? baseFlags : baseFlags + 'g';
    const pattern = new RegExp(UNRESOLVED_IMAGE_INSTRUCTION_REFERENCE_PATTERN.source, flags);
    for (const match of text.matchAll(pattern)) {
      if (hasNegatedReferenceWindow(text, match.index)) continue;
      return true;
    }
    return false;
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function hasExactImageInstruction(value = {}) {
    if (!hasOnlyFields(value, IMAGE_INSTRUCTION_FIELDS)
        || value.schema_version !== IMAGE_INSTRUCTION_VERSION
        || !IMAGE_INSTRUCTION_STATUSES.includes(stringValue(value.status))) return false;
    const instruction = stringValue(value.instruction);
    const clarification = stringValue(value.clarification);
    if (instruction.length > IMAGE_INSTRUCTION_MAX_LENGTH
        || clarification.length > IMAGE_INSTRUCTION_MAX_CLARIFICATION_LENGTH) return false;
    if (value.status === 'ready') return !!instruction && !clarification;
    return !instruction && !!clarification;
  }

  function assertImageInstruction(value = {}) {
    if (hasExactImageInstruction(value)) return true;
    const error = new TypeError('Invalid image_instruction.v1');
    error.code = 'IMAGE_INSTRUCTION_INVALID';
    throw error;
  }

  return Object.freeze({
    IMAGE_INSTRUCTION_VERSION,
    IMAGE_INSTRUCTION_FIELDS,
    IMAGE_INSTRUCTION_STATUSES,
    IMAGE_INSTRUCTION_MAX_LENGTH,
    IMAGE_INSTRUCTION_MAX_CLARIFICATION_LENGTH,
    UNRESOLVED_IMAGE_INSTRUCTION_REFERENCE_PATTERN,
    IMAGE_INSTRUCTION_RESPONSE_FORMAT,
    hasUnresolvedImageInstructionReference,
    hasExactImageInstruction,
    assertImageInstruction,
  });
});
