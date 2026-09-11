'use strict';
(function initChatUIImageSizePolicy(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('imageSizePolicy', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIImageSizePolicy() {
  'use strict';

  // GPT Image 2.5 accepts arbitrary resolutions with hard bounds: width and
  // height are multiples of 16, the aspect ratio stays between 1:3 and 3:1,
  // neither edge exceeds 3840, and the total pixel count stays between
  // 655,360 and 8,294,400. Editors and the capability registry share these
  // rules so an out-of-range canvas is never dispatched upstream.
  const PRESET_SIZES = Object.freeze(['auto', '1024x1024', '1536x1024', '1024x1536']);
  const EDGE_MULTIPLE = 16;
  const MAX_EDGE = 3840;
  const MIN_PIXELS = 655360;
  const MAX_PIXELS = 8294400;
  const MIN_ASPECT = 1 / 3;
  const MAX_ASPECT = 3;

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function parseImageSize(value = '') {
    const match = /^(\d{2,4})\s*[x\u00d7]\s*(\d{2,4})$/.exec(stringValue(value).toLowerCase());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
    return Object.freeze({ width, height });
  }

  function invalid(code, message) {
    return Object.freeze({ valid: false, code, message });
  }

  function validateImageSize(value = '') {
    const text = stringValue(value).toLowerCase();
    if (!text) return invalid('empty', '\u8bf7\u9009\u62e9\u6216\u8f93\u5165\u56fe\u7247\u5c3a\u5bf8\uff0c\u4f8b\u5982 1536x864');
    if (PRESET_SIZES.includes(text)) {
      const parsed = parseImageSize(text);
      return Object.freeze({
        valid: true,
        size: text,
        preset: true,
        width: parsed ? parsed.width : 0,
        height: parsed ? parsed.height : 0,
      });
    }
    const parsed = parseImageSize(text);
    if (!parsed) return invalid('format', '\u5c3a\u5bf8\u683c\u5f0f\u5e94\u4e3a \u5bbdx\u9ad8\uff0c\u4f8b\u5982 1536x864');
    const width = parsed.width;
    const height = parsed.height;
    if (width % EDGE_MULTIPLE !== 0 || height % EDGE_MULTIPLE !== 0) {
      return invalid('multiple', '\u5bbd\u548c\u9ad8\u90fd\u5fc5\u987b\u662f 16 \u7684\u500d\u6570');
    }
    if (width > MAX_EDGE || height > MAX_EDGE) {
      return invalid('edge', '\u5bbd\u548c\u9ad8\u90fd\u4e0d\u80fd\u8d85\u8fc7 3840 \u50cf\u7d20');
    }
    const aspect = width / height;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
      return invalid('aspect', '\u5bbd\u9ad8\u6bd4\u9700\u8981\u5728 1:3 \u5230 3:1 \u4e4b\u95f4');
    }
    const pixels = width * height;
    if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) {
      return invalid('pixels', '\u603b\u50cf\u7d20\u9700\u8981\u4ecb\u4e8e 655,360 \u548c 8,294,400 \u4e4b\u95f4');
    }
    return Object.freeze({ valid: true, size: `${width}x${height}`, preset: false, width, height });
  }

  function isPresetImageSize(value = '') {
    return PRESET_SIZES.includes(stringValue(value).toLowerCase());
  }

  return Object.freeze({
    PRESET_SIZES,
    EDGE_MULTIPLE,
    MAX_EDGE,
    MIN_PIXELS,
    MAX_PIXELS,
    MIN_ASPECT,
    MAX_ASPECT,
    parseImageSize,
    validateImageSize,
    isPresetImageSize,
  });
});
