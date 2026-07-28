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
   * @typedef {Object} RouteDecision
   * @property {'chat'|'vision'|'image_generate'|'image_edit'|'unclear'|'unsafe'} route
   * @property {string=} operation_type
   * @property {string=} rewritten_prompt
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
