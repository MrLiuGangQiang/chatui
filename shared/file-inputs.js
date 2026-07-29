(function initChatUIFileInputs(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root?.ChatUICore?.registerModule) {
    try { root.ChatUICore.registerModule('fileInputs', api); }
    catch (err) {
      if (!/already registered/i.test(String(err?.message || err))) throw err;
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIFileInputs() {
  'use strict';

  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
  const PDF_DETAILS = Object.freeze(['auto', 'low', 'high']);

  const CATEGORY_EXTENSIONS = Object.freeze({
    pdf: Object.freeze(['.pdf']),
    spreadsheet: Object.freeze([
      '.xla', '.xlb', '.xlc', '.xlm', '.xls', '.xlsx', '.xlt', '.xlw',
      '.csv', '.tsv', '.iif', '.numbers',
    ]),
    document: Object.freeze(['.doc', '.docx', '.dot', '.odt', '.rtf', '.pages']),
    presentation: Object.freeze(['.pot', '.ppa', '.pps', '.ppt', '.pptx', '.pwz', '.wiz', '.key']),
    text: Object.freeze([
      '.asm', '.bat', '.c', '.cc', '.conf', '.cpp', '.css', '.cxx', '.def', '.dic',
      '.eml', '.h', '.hh', '.htm', '.html', '.ics', '.ifb', '.in', '.js', '.json',
      '.ksh', '.list', '.log', '.markdown', '.md', '.mht', '.mhtml', '.mime', '.mjs',
      '.nws', '.pl', '.py', '.rst', '.s', '.sql', '.srt', '.text', '.txt', '.vcf',
      '.vtt', '.xml', '.ts', '.tsx', '.jsx', '.java', '.go', '.rs', '.php', '.rb',
      '.sh', '.bash', '.zsh', '.tex', '.cs', '.scala', '.kt', '.kts', '.swift', '.lua',
      '.r', '.jl', '.ex', '.exs', '.erl', '.hrl', '.hs', '.clj', '.groovy', '.dart',
      '.awk', '.hbs', '.mustache', '.ejs', '.jinja', '.jinja2', '.liquid', '.erb',
      '.twig', '.pug', '.jade', '.cmake', '.gradle', '.ini', '.properties', '.proto',
      '.scss', '.sass', '.less', '.hcl', '.tf', '.toml', '.graphql', '.gql', '.ndjson',
      '.json5', '.yaml', '.yml', '.astro', '.diff', '.patch', '.dockerfile',
    ]),
  });

  const MIME_TYPES = Object.freeze([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel', 'text/csv', 'application/csv', 'text/tsv',
    'text/x-iif', 'application/x-iif', 'application/vnd.google-apps.spreadsheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword', 'application/rtf', 'text/rtf',
    'application/vnd.oasis.opendocument.text', 'application/vnd.apple.pages',
    'application/vnd.google-apps.document', 'application/vnd.apple.iwork',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint', 'application/vnd.apple.keynote',
    'application/vnd.google-apps.presentation',
    'application/javascript', 'application/typescript', 'application/json',
    'application/x-sql', 'application/x-scala', 'application/x-rust',
    'application/x-powershell', 'application/x-patch', 'application/x-php',
    'application/x-httpd-php', 'application/x-httpd-php-source', 'application/x-bash',
    'application/x-awk', 'application/x-protobuf', 'application/x-terraform',
    'application/x-toml', 'application/toml', 'application/graphql',
    'application/x-graphql', 'application/x-ndjson', 'application/json5',
    'application/x-json5', 'application/x-yaml', 'application/yaml',
    'application/xml', 'text/xml', 'message/rfc822', 'text/plain', 'text/markdown',
    'text/html', 'text/css', 'text/javascript', 'text/typescript', 'text/jsx', 'text/tsx',
    'text/x-shellscript', 'text/x-rst', 'text/x-makefile', 'text/x-lisp', 'text/x-asm',
    'text/vbscript', 'text/x-diff', 'text/x-patch', 'text/x-java', 'text/x-script.python',
    'text/x-python', 'text/x-c', 'text/x-c++', 'text/x-golang', 'text/x-go', 'text/x-php',
    'text/x-ruby', 'text/x-sh', 'text/x-bash', 'text/x-zsh', 'text/x-tex', 'text/x-csharp',
    'text/x-typescript', 'text/x-rust', 'text/x-scala', 'text/x-kotlin', 'text/x-swift',
    'text/x-lua', 'text/x-r', 'text/x-julia', 'text/x-perl', 'text/x-objectivec',
    'text/x-objectivec++', 'text/x-erlang', 'text/x-elixir', 'text/x-haskell',
    'text/x-clojure', 'text/x-groovy', 'text/x-dart', 'text/x-awk', 'text/x-handlebars',
    'text/x-mustache', 'text/x-ejs', 'text/x-jinja2', 'text/x-liquid', 'text/x-erb',
    'text/x-twig', 'text/x-pug', 'text/x-jade', 'text/x-tmpl', 'text/x-cmake',
    'text/x-dockerfile', 'text/x-gradle', 'text/x-ini', 'text/x-properties',
    'text/x-protobuf', 'text/x-sql', 'text/x-sass', 'text/x-scss', 'text/x-less',
    'text/x-hcl', 'text/x-terraform', 'text/x-toml', 'text/x-graphql', 'text/x-yaml',
    'text/x-astro', 'text/srt', 'application/x-subrip', 'text/x-subrip', 'text/vtt',
    'text/x-vcard', 'text/calendar',
  ]);

  const ALL_EXTENSIONS = Object.freeze([...new Set(Object.values(CATEGORY_EXTENSIONS).flat())]);
  const EXTENSION_SET = new Set(ALL_EXTENSIONS);
  const MIME_SET = new Set(MIME_TYPES.map(value => value.toLowerCase()));

  const MIME_BY_EXTENSION = Object.freeze({
    '.pdf': 'application/pdf', '.csv': 'text/csv', '.tsv': 'text/tsv', '.iif': 'text/x-iif',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.numbers': 'application/vnd.apple.iwork',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.dot': 'application/msword', '.rtf': 'application/rtf', '.odt': 'application/vnd.oasis.opendocument.text',
    '.pages': 'application/vnd.apple.pages',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pot': 'application/vnd.ms-powerpoint', '.ppa': 'application/vnd.ms-powerpoint',
    '.pps': 'application/vnd.ms-powerpoint', '.pwz': 'application/vnd.ms-powerpoint',
    '.wiz': 'application/vnd.ms-powerpoint', '.key': 'application/vnd.apple.keynote',
    '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.ts': 'text/x-typescript', '.tsx': 'text/tsx', '.jsx': 'text/jsx', '.xml': 'text/xml',
    '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.markdown': 'text/markdown',
    '.yaml': 'text/x-yaml', '.yml': 'text/x-yaml', '.toml': 'text/x-toml', '.txt': 'text/plain',
    '.py': 'text/x-python', '.java': 'text/x-java', '.go': 'text/x-go', '.rs': 'text/x-rust',
    '.c': 'text/x-c', '.h': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++',
    '.cxx': 'text/x-c++', '.hh': 'text/x-c++', '.asm': 'text/x-asm', '.s': 'text/x-asm',
    '.sql': 'text/x-sql', '.php': 'text/x-php', '.rb': 'text/x-ruby', '.pl': 'text/x-perl',
    '.sh': 'text/x-sh', '.bash': 'text/x-bash', '.zsh': 'text/x-zsh', '.ksh': 'text/x-shellscript',
    '.tex': 'text/x-tex', '.cs': 'text/x-csharp', '.scala': 'text/x-scala',
    '.kt': 'text/x-kotlin', '.kts': 'text/x-kotlin', '.swift': 'text/x-swift',
    '.lua': 'text/x-lua', '.r': 'text/x-r', '.jl': 'text/x-julia',
    '.ex': 'text/x-elixir', '.exs': 'text/x-elixir', '.erl': 'text/x-erlang',
    '.hrl': 'text/x-erlang', '.hs': 'text/x-haskell', '.clj': 'text/x-clojure',
    '.groovy': 'text/x-groovy', '.dart': 'text/x-dart', '.awk': 'text/x-awk',
    '.rst': 'text/x-rst', '.css': 'text/css', '.scss': 'text/x-scss',
    '.sass': 'text/x-sass', '.less': 'text/x-less', '.ini': 'text/x-ini',
    '.properties': 'text/x-properties', '.proto': 'text/x-protobuf', '.cmake': 'text/x-cmake',
    '.gradle': 'text/x-gradle', '.hcl': 'text/x-hcl', '.tf': 'text/x-terraform',
    '.graphql': 'text/x-graphql', '.gql': 'text/x-graphql', '.ndjson': 'application/x-ndjson',
    '.json5': 'application/json5', '.astro': 'text/x-astro', '.diff': 'text/x-diff',
    '.patch': 'text/x-patch', '.hbs': 'text/x-handlebars', '.mustache': 'text/x-mustache',
    '.ejs': 'text/x-ejs', '.jinja': 'text/x-jinja2', '.jinja2': 'text/x-jinja2',
    '.liquid': 'text/x-liquid', '.erb': 'text/x-erb', '.twig': 'text/x-twig',
    '.pug': 'text/x-pug', '.jade': 'text/x-jade', '.srt': 'text/srt',
    '.vtt': 'text/vtt', '.vcf': 'text/x-vcard', '.ics': 'text/calendar', '.ifb': 'text/calendar',
    '.eml': 'message/rfc822', '.mht': 'message/rfc822', '.mhtml': 'message/rfc822',
    '.mime': 'message/rfc822', '.nws': 'message/rfc822',
    '.dockerfile': 'text/x-dockerfile',
  });

  const MIME_BY_CATEGORY = Object.freeze({
    pdf: 'application/pdf',
    spreadsheet: 'application/vnd.ms-excel',
    document: 'application/msword',
    presentation: 'application/vnd.ms-powerpoint',
    text: 'text/plain',
  });

  function extensionFromName(name = '') {
    const value = String(name || '').trim().toLowerCase();
    if (!value) return '';
    if (value === 'dockerfile') return '.dockerfile';
    const match = value.match(/(\.[a-z0-9+_-]+)$/i);
    return match ? match[1] : '';
  }

  function normalizeMime(type = '') {
    return String(type || '').split(';')[0].trim().toLowerCase();
  }

  function categoryForFile(file = {}) {
    const extension = extensionFromName(file.name || file.filename);
    const mime = normalizeMime(file.type || file.mimeType || file.mime_type);
    if (extension === '.pdf' || mime === 'application/pdf') return 'pdf';
    for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
      if (extensions.includes(extension)) return category;
    }
    if (/spreadsheet|excel|csv|tsv|iif/.test(mime)) return 'spreadsheet';
    if (/presentation|powerpoint|keynote/.test(mime)) return 'presentation';
    if (/wordprocessing|msword|rtf|opendocument\.text|apple\.pages|google-apps\.document/.test(mime)) return 'document';
    return MIME_SET.has(mime) ? 'text' : '';
  }

  function isAcceptedFile(file = {}) {
    const extension = extensionFromName(file.name || file.filename);
    const mime = normalizeMime(file.type || file.mimeType || file.mime_type);
    return EXTENSION_SET.has(extension) || MIME_SET.has(mime) || String(file.name || '').trim().toLowerCase() === 'dockerfile';
  }

  function isPdfFile(file = {}) {
    return categoryForFile(file) === 'pdf';
  }

  function inferMimeType(name = '', fallback = '') {
    const normalized = normalizeMime(fallback);
    if (normalized && normalized !== 'application/octet-stream') return normalized;
    const mapped = MIME_BY_EXTENSION[extensionFromName(name)];
    if (mapped) return mapped;
    const category = categoryForFile({ name, type: normalized });
    return MIME_BY_CATEGORY[category] || normalized || 'application/octet-stream';
  }

  function normalizePdfDetail(value = 'auto') {
    const detail = String(value || '').trim().toLowerCase();
    return PDF_DETAILS.includes(detail) ? detail : 'auto';
  }

  function validationError(message, code) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = code === 'FILE_INPUT_TOO_LARGE' || code === 'FILE_INPUT_REQUEST_TOO_LARGE'
      ? 413
      : code === 'FILE_INPUT_TYPE_UNSUPPORTED' ? 415 : 400;
    return error;
  }

  function validateFile(file = {}) {
    const size = Number(file.size || file.bytes || 0);
    if (!isAcceptedFile(file)) throw validationError(`Unsupported file input type: ${file.name || file.filename || 'attachment'}`, 'FILE_INPUT_TYPE_UNSUPPORTED');
    if (!Number.isFinite(size) || size <= 0) throw validationError('File input must not be empty', 'FILE_INPUT_SIZE_INVALID');
    if (size >= MAX_FILE_BYTES) throw validationError(`File must be smaller than 50 MB: ${file.name || file.filename || 'attachment'}`, 'FILE_INPUT_TOO_LARGE');
    return { name: file.name || file.filename || 'attachment', type: inferMimeType(file.name || file.filename, file.type || file.mimeType), size, category: categoryForFile(file) };
  }

  function validateRequestFiles(files = []) {
    const validated = (Array.isArray(files) ? files : []).map(validateFile);
    const totalBytes = validated.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes >= MAX_REQUEST_BYTES) throw validationError('Combined file inputs must be smaller than 50 MB', 'FILE_INPUT_REQUEST_TOO_LARGE');
    return { files: validated, totalBytes };
  }

  function acceptAttribute({ includeImages = true } = {}) {
    return [...(includeImages ? ['image/*'] : []), ...ALL_EXTENSIONS, ...MIME_TYPES].join(',');
  }

  return Object.freeze({
    MAX_FILE_BYTES,
    MAX_REQUEST_BYTES,
    PDF_DETAILS,
    CATEGORY_EXTENSIONS,
    MIME_TYPES,
    ALL_EXTENSIONS,
    extensionFromName,
    normalizeMime,
    categoryForFile,
    isAcceptedFile,
    isPdfFile,
    inferMimeType,
    normalizePdfDetail,
    validateFile,
    validateRequestFiles,
    acceptAttribute,
  });
});
