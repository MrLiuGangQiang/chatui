(function initChatUICoreResourceIdentity(root) {
  'use strict';

  const RESOURCE_ID_VERSION = 'resource_identity.v1';
  const RESOURCE_TYPES = new Set(['image', 'file', 'message', 'text']);
  const TRANSIENT_LOCATOR_RE = /^(?:data:|blob:)/i;

  function normalizeType(type = '') {
    const value = String(type || '').trim().toLowerCase();
    return RESOURCE_TYPES.has(value) ? value : '';
  }

  function scalarIdentityValue(value = '') {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'bigint') return String(value);
    return '';
  }

  function normalizedString(value = '') {
    return scalarIdentityValue(value);
  }

  function valueOf(item = {}, keys = []) {
    for (const key of keys) {
      const value = normalizedString(item?.[key]);
      if (value) return value;
    }
    return '';
  }

  function uniqueStrings(values = []) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      const normalized = normalizedString(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }

  function explicitResourceId(item = {}) {
    return valueOf(item, ['resource_id', 'resourceId', 'routeResourceId', 'route_resource_id']);
  }

  function nativeIdentityKeys(type = '') {
    const normalizedType = normalizeType(type);
    if (normalizedType === 'image') {
      return ['image_id', 'imageId', 'attachmentId', 'attachment_id', 'id'];
    }
    if (normalizedType === 'file') {
      return ['file_id', 'fileId', 'attachmentId', 'attachment_id', 'id'];
    }
    if (normalizedType === 'message') {
      return ['message_id', 'messageId', 'display_item_id', 'displayItemId', 'id'];
    }
    return ['id'];
  }

  function primaryIdentity(item = {}, type = '') {
    return explicitResourceId(item) || valueOf(item, nativeIdentityKeys(type));
  }

  function nativeIdentity(item = {}, type = '') {
    return valueOf(item, nativeIdentityKeys(type));
  }

  const SHA256_CONSTANTS = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function utf8Bytes(value = '') {
    const text = String(value || '');
    const Encoder = root?.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
    if (Encoder) return new Encoder().encode(text);
    const bytes = [];
    for (const symbol of text) {
      const code = symbol.codePointAt(0);
      if (code <= 0x7f) bytes.push(code);
      else if (code <= 0x7ff) bytes.push(0xc0 | code >>> 6, 0x80 | code & 0x3f);
      else if (code <= 0xffff) bytes.push(0xe0 | code >>> 12, 0x80 | code >>> 6 & 0x3f, 0x80 | code & 0x3f);
      else bytes.push(0xf0 | code >>> 18, 0x80 | code >>> 12 & 0x3f, 0x80 | code >>> 6 & 0x3f, 0x80 | code & 0x3f);
    }
    return Uint8Array.from(bytes);
  }

  function rotateRight(value, amount) {
    return value >>> amount | value << 32 - amount;
  }

  // Resource identities are persisted and compared across browser sessions. A
  // short non-cryptographic digest is not an identity boundary because a real
  // collision would merge unrelated resources. Use a deterministic SHA-256
  // implementation in both browser and Node environments instead.
  function stableHash(value = '') {
    const input = utf8Bytes(value);
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(input);
    bytes[input.length] = 0x80;
    const bitLength = input.length * 8;
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    const view = new DataView(bytes.buffer);
    view.setUint32(paddedLength - 8, high, false);
    view.setUint32(paddedLength - 4, low, false);

    const hash = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
      for (let index = 16; index < 64; index += 1) {
        const x = words[index - 15];
        const y = words[index - 2];
        const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ x >>> 3;
        const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ y >>> 10;
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = e & f ^ ~e & g;
        const temp1 = (h + sum1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = a & b ^ a & c ^ b & c;
        const temp2 = (sum0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0;
      hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0;
      hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0;
      hash[7] = (hash[7] + h) >>> 0;
    }
    return [...hash].map(value => value.toString(16).padStart(8, '0')).join('');
  }

  function durableLocator(item = {}) {
    const locator = valueOf(item, [
      'storageKey', 'storage_key', 'persistedSrc', 'persisted_src', 'src', 'url', 'href',
    ]);
    return locator && !TRANSIENT_LOCATOR_RE.test(locator) ? locator : '';
  }

  function encodeIdentityPart(value = '') {
    return encodeURIComponent(String(value || '').trim());
  }

  function isCanonicalResourceId(value = '', type = '') {
    const normalized = normalizedString(value);
    const normalizedType = normalizeType(type);
    if (!normalized || !normalizedType) return false;
    return normalized.startsWith(`res:${normalizedType}:`)
      && normalized.length > `res:${normalizedType}:`.length;
  }

  function canonicalFromNative(type = '', value = '') {
    const normalizedType = normalizeType(type);
    const identity = normalizedString(value);
    if (!normalizedType || !identity) return '';
    if (identity.startsWith('res:')) return isCanonicalResourceId(identity, normalizedType) ? identity : '';
    const encoded = encodeIdentityPart(identity);
    return encoded ? `res:${normalizedType}:${encoded}` : '';
  }

  function normalizeExplicitResourceId(type = '', value = '') {
    return canonicalFromNative(type, value);
  }

  function canonicalResourceId(type = '', item = {}) {
    const normalizedType = normalizeType(type);
    if (!normalizedType) return '';
    const explicit = explicitResourceId(item);
    if (explicit) return normalizeExplicitResourceId(normalizedType, explicit);
    const native = nativeIdentity(item, normalizedType);
    if (native) return canonicalFromNative(normalizedType, native);
    const locator = durableLocator(item);
    return locator ? `res:${normalizedType}:locator:${stableHash(`${normalizedType}:${locator}`)}` : '';
  }

  function rawIdentityAliases(item = {}, type = '') {
    const normalizedType = normalizeType(type);
    const explicit = explicitResourceId(item);
    const validExplicit = explicit && normalizeExplicitResourceId(normalizedType, explicit) ? explicit : '';
    const values = nativeIdentityKeys(normalizedType).map(key => item?.[key]);
    return uniqueStrings([
      validExplicit,
      ...values,
      item?.routeId,
      item?.route_id,
      ...(Array.isArray(item?.identity_aliases) ? item.identity_aliases : []),
      ...(Array.isArray(item?.identityAliases) ? item.identityAliases : []),
      ...(Array.isArray(item?.routeIdAliases) ? item.routeIdAliases : []),
      ...(Array.isArray(item?.route_id_aliases) ? item.route_id_aliases : []),
    ]).filter(value => !value.startsWith('res:') || isCanonicalResourceId(value, normalizedType));
  }

  function identityAliases(item = {}, type = '') {
    const normalizedType = normalizeType(type);
    const raw = rawIdentityAliases(item, normalizedType);
    return uniqueStrings([
      ...raw,
      ...raw.map(value => canonicalFromNative(normalizedType, value)),
    ]);
  }

  function identityOrigin(item = {}, type = '') {
    const normalizedType = normalizeType(type);
    const explicit = explicitResourceId(item);
    if (explicit && normalizeExplicitResourceId(normalizedType, explicit)) return 'explicit';
    if (nativeIdentity(item, normalizedType)) return 'native';
    if (durableLocator(item)) return 'locator';
    return '';
  }

  function identityStrength(item = {}, type = '') {
    const origin = identityOrigin(item, type);
    return origin === 'explicit' ? 3 : origin === 'locator' ? 2 : origin === 'native' ? 1 : 0;
  }

  function resourceIdentity(item = {}, type = '') {
    const normalizedType = normalizeType(type);
    const resourceId = canonicalResourceId(normalizedType, item);
    return {
      type: normalizedType,
      resourceId,
      resource_id: resourceId,
      nativeId: nativeIdentity(item, normalizedType),
      origin: identityOrigin(item, normalizedType),
      strength: identityStrength(item, normalizedType),
      aliases: identityAliases(item, normalizedType).filter(value => value !== resourceId),
    };
  }

  function generatedNativeId(type = '', idFactory = null) {
    const normalizedType = normalizeType(type);
    if (!normalizedType) return '';
    const provided = typeof idFactory === 'function' ? normalizedString(idFactory(normalizedType)) : '';
    if (provided) return provided;
    const uuid = root?.crypto?.randomUUID?.();
    if (uuid) return `rid_${uuid.replace(/[-]/g, '').slice(0, 16)}`;
    return `rid_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function applyNativeIdentity(target = {}, type = '', value = '') {
    const normalizedType = normalizeType(type);
    const id = normalizedString(value);
    if (!normalizedType || !id) return target;
    if (!normalizedString(target.id)) target.id = id;
    if (normalizedType === 'image') {
      if (!normalizedString(target.imageId)) target.imageId = id;
      if (!normalizedString(target.image_id)) target.image_id = target.imageId || id;
    } else if (normalizedType === 'file') {
      if (!normalizedString(target.fileId)) target.fileId = id;
      if (!normalizedString(target.file_id)) target.file_id = target.fileId || id;
    } else if (normalizedType === 'message') {
      if (!normalizedString(target.messageId)) target.messageId = id;
      if (!normalizedString(target.message_id)) target.message_id = target.messageId || id;
    }
    return target;
  }

  function withResourceIdentity(item = {}, type = '', options = {}) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const normalizedType = normalizeType(type);
    if (!normalizedType) return { ...item };
    const next = { ...item };
    const explicit = explicitResourceId(next);
    if (explicit && !normalizeExplicitResourceId(normalizedType, explicit)) return next;
    let identity = resourceIdentity(next, normalizedType);
    if (!identity.resourceId && options.generate === true) {
      const generated = generatedNativeId(normalizedType, options.idFactory);
      applyNativeIdentity(next, normalizedType, generated);
      identity = resourceIdentity(next, normalizedType);
    }
    if (!identity.resourceId) return next;
    next.resourceId = identity.resourceId;
    next.resource_id = identity.resourceId;
    if (!identity.nativeId && options.generate === true) {
      applyNativeIdentity(next, normalizedType, generatedNativeId(normalizedType, options.idFactory));
      identity = resourceIdentity(next, normalizedType);
    }
    const aliases = uniqueStrings([
      ...(Array.isArray(next.identity_aliases) ? next.identity_aliases : []),
      ...identity.aliases,
    ]).filter(value => value !== identity.resourceId);
    if (aliases.length) next.identity_aliases = aliases;
    return next;
  }

  function ensureResourceIdentity(item = {}, type = '', options = {}) {
    const next = withResourceIdentity(item, type, { ...options, generate: true });
    if (options.mutate === false || !item || typeof item !== 'object' || Array.isArray(item)) return next;
    try { Object.assign(item, next); } catch {}
    return item;
  }

  function identityTokens(item = {}, type = '') {
    const identity = resourceIdentity(item, type);
    return uniqueStrings([identity.resourceId, identity.nativeId, ...identity.aliases]);
  }

  function sameResourceIdentity(left = {}, right = {}, type = '') {
    const normalizedType = normalizeType(type);
    const leftExplicit = explicitResourceId(left);
    const rightExplicit = explicitResourceId(right);
    const leftCanonical = leftExplicit ? normalizeExplicitResourceId(normalizedType, leftExplicit) : '';
    const rightCanonical = rightExplicit ? normalizeExplicitResourceId(normalizedType, rightExplicit) : '';
    if (leftCanonical && rightCanonical && leftCanonical !== rightCanonical) return false;
    const leftTokens = new Set(identityTokens(left, normalizedType));
    if (!leftTokens.size) return false;
    return identityTokens(right, normalizedType).some(token => leftTokens.has(token));
  }

  const api = Object.freeze({
    RESOURCE_ID_VERSION,
    RESOURCE_TYPES,
    normalizeType,
    scalarIdentityValue,
    primaryIdentity,
    nativeIdentity,
    durableLocator,
    stableHash,
    isCanonicalResourceId,
    canonicalFromNative,
    normalizeExplicitResourceId,
    canonicalResourceId,
    identityAliases,
    identityTokens,
    identityOrigin,
    identityStrength,
    resourceIdentity,
    withResourceIdentity,
    ensureResourceIdentity,
    sameResourceIdentity,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('resourceIdentity', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
