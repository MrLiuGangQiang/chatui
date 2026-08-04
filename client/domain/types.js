(function initChatUIDomainTypes(root) {
  'use strict';

  /**
   * @typedef {'system'|'user'|'assistant'|'error'} ChatMessageRole
   *
   * @typedef {Object} ChatMessage
   * @property {ChatMessageRole} role
   * @property {string|Array} content
   * @property {string=} rawText
   * @property {string=} html
   * @property {string|number=} messageIndex
   * @property {string|number=} responseIndex
   * @property {string=} imageContext
   * @property {string=} attachmentContext
   *
   * @typedef {Object} DisplayItem
   * @property {string} id
   * @property {ChatMessageRole} role
   * @property {string=} rawText
   * @property {string=} html
   * @property {string|number=} messageIndex
   * @property {string|number=} responseIndex
   * @property {string=} pending
   * @property {string=} jobId
   *
   * @typedef {Object} ChatSession
   * @property {string} id
   * @property {string=} title
   * @property {Array<ChatMessage>=} messages
   * @property {Array<DisplayItem>=} display
   * @property {Object|null=} lastGeneratedImage
   *
   * @typedef {Object} ChatJob
   * @property {string} id
   * @property {string=} prompt
   * @property {string=} displayItemId
   * @property {string|number=} responseIndex
   * @property {'chat'=} mode
   * @property {Object=} payload
   *
   * @typedef {Object} ImageJob
   * @property {string} id
   * @property {string=} prompt
   * @property {string=} displayItemId
   * @property {Object=} payload
   *
   * @typedef {Object} AttachmentItem
   * @property {string=} id
   * @property {string} name
   * @property {string} type
   * @property {number=} size
   * @property {string=} dataUrl
   * @property {string=} text
   *
   * @typedef {'plain_chat'|'file_qa'|'multimodal_qa'|'image_qa'|'image_compare'|'ocr'|'text_to_image'|'image_reference_gen'|'edit_image'} RouteOperation
   * @typedef {'new'|'followup'|'correction'|'continuation'} RouteRelation
   * @typedef {'source'|'target'|'reference'|'style_reference'|'mask'|'compare_a'|'compare_b'|'attachment'|'context'} RouteResourceRole
   *
   * @typedef {Object} RouteBinding
   * @property {string} candidate_key Application-provided iN/fN/mN candidate key.
   * @property {RouteResourceRole} role
   *
   * @typedef {Object} RouteChange
   * @property {'preserve'|'add'|'replace'|'remove'} op
   * @property {string} target
   * @property {string} value Empty for preserve/remove operations.
   *
   * @typedef {Object} RouteUnresolvedResource
   * @property {'image'|'file'|'text'|'message'} type
   * @property {RouteResourceRole} role
   * @property {'missing'|'ambiguous'|'unavailable'} reason
   * @property {Array<string>} candidate_keys
   *
   * @typedef {Object} RouteClarification
   * @property {string} question
   * @property {Array<RouteUnresolvedResource>} unresolved
   *
   * @typedef {Object} RouteDecision
   * @property {'route_decision.v1'} schema_version
   * @property {'ready'|'needs_clarification'} readiness
   * @property {RouteOperation} operation
   * @property {RouteRelation} relation
   * @property {Array<RouteBinding>} bindings
   * @property {Array<RouteChange>} changes
   * @property {Array<string>} constraints
   * @property {RouteClarification} clarification
   * @property {number} confidence Number from 0 through 1.
   * @property {string} rationale
   */

  const typeNames = Object.freeze([
    'ChatMessageRole',
    'ChatMessage',
    'DisplayItem',
    'ChatSession',
    'ChatJob',
    'ImageJob',
    'AttachmentItem',
    'RouteDecision',
  ]);

  const api = Object.freeze({ typeNames });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatUIDomainTypes = api;
  if (root?.window) root.window.ChatUIDomainTypes = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
