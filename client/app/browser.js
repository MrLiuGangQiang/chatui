(function () {
  function createSession(title = '新对话') {
    return {
      id: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      customTitle: '',
      messages: [],
      display: [],
      lastGeneratedImage: null,
      systemPrompt: '',
      hasSystemPromptOverride: false,
      imageStylePrompt: '',
      hasImageStylePromptOverride: false,
      chatModel: '',
      headerValues: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      busy: false,
    };
  }

  function ensureActiveSession(appState) {
    if (!Array.isArray(appState.sessions)) appState.sessions = [];
    if (!appState.sessions.length) {
      const session = createSession();
      appState.sessions = [session];
      appState.activeSessionId = session.id;
    }
    let session = appState.sessions.find(item => item.id === appState.activeSessionId);
    if (!session) {
      session = appState.sessions[0];
      appState.activeSessionId = session.id;
    }
    session.messages ||= [];
    session.display ||= [];
    session.headerValues ||= {};
    session.systemPrompt ||= '';
    session.imageStylePrompt ||= '';
    session.chatModel ||= '';
    if (session.hasSystemPromptOverride !== true) session.hasSystemPromptOverride = false;
    if (session.hasImageStylePromptOverride !== true) session.hasImageStylePromptOverride = false;
    return session;
  }

  function isSessionBusy(appState, sessionId) {
    return !!appState.busySessions?.has?.(sessionId) || !!appState.sessions?.find(item => item.id === sessionId)?.busy;
  }



  function getEffectiveImageStylePrompt({ session = null, config = {} } = {}) {
    return String(session?.hasImageStylePromptOverride ? session.imageStylePrompt || '' : config.imageStylePrompt || '').trim();
  }

  function getSessionChatModel({ session = null, config = {}, models = [] } = {}) {
    const selected = String(session?.chatModel || '').trim();
    return selected && models.includes(selected) ? selected : config.chatModel;
  }

  function sessionChatModelValue(session = null, models = []) {
    const selected = String(session?.chatModel || '').trim();
    return selected && models.includes(selected) ? selected : '';
  }

  function sessionModelOptions({ models = [], globalChatModel = '', isAllowed = () => true } = {}) {
    const chatModels = [...new Set(models)].filter(model => isAllowed(model, 'chat'));
    return [{ value: '', label: `跟随全局${globalChatModel ? ` · ${globalChatModel}` : ''}` }]
      .concat(chatModels.map(model => ({ value: model, label: model })));
  }

  function normalizeSessionChatModel(model = '', models = []) {
    return models.includes(model) ? model : '';
  }



  const HEADER_PARAM_MODES = new Set(['manual', 'session_short_uuid', 'message_short_uuid']);

  function normalizeHeaderParamConfig(params = []) {
    return (Array.isArray(params) ? params : [])
      .map(param => ({
        name: String(param?.name || '').trim(),
        mode: HEADER_PARAM_MODES.has(param?.mode) ? param.mode : 'manual',
        value: String(param?.value || ''),
      }))
      .filter(param => param.name);
  }

  function generateShortUuid(randomBytes = null, now = Date.now, random = Math.random) {
    if (randomBytes) {
      const bytes = randomBytes(8);
      if (bytes && typeof bytes[Symbol.iterator] === 'function') {
        return [...bytes].map(byte => Number(byte).toString(16).padStart(2, '0')).join('').slice(0, 12);
      }
    }
    return `${now().toString(36)}${random().toString(36).slice(2, 8)}`.slice(0, 12);
  }

  function buildRequestHeadersFromParams({ params = [], sessionValues = {}, messageUuid = () => '', sessionUuid = () => '' } = {}) {
    const headers = {};
    let changed = false;
    for (const param of normalizeHeaderParamConfig(params)) {
      let value = '';
      if (param.mode === 'manual') value = param.value;
      else if (param.mode === 'session_short_uuid') {
        if (!sessionValues[param.name]) {
          sessionValues[param.name] = sessionUuid();
          changed = true;
        }
        value = sessionValues[param.name];
      } else if (param.mode === 'message_short_uuid') value = messageUuid();
      if (param.name && value) headers[param.name] = value;
    }
    return { headers, changed, sessionValues };
  }



  function formatElapsed(ms) {
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }

  function firstTokenTimeText(ms) {
    return Number.isFinite(ms) ? `TTFT ${formatElapsed(ms)}` : '';
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }[ch]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/\n/g, '&#10;');
  }

  function renderStreamingText(value) {
    return `<p>${escapeHtml(value).replace(/\n/g, '<br>')}</p>`;
  }

  function pendingFeedbackHtml(value) {
    return `<div class="pending-feedback"><span class="pending-orb" aria-hidden="true"></span><span class="pending-text">${escapeHtml(value)}</span><span class="pending-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
  }

  function isChatStatusText(value = '') {
    return /正在处理|正在思考|正在恢复聊天任务|恢复任务不存在|已停止恢复|已收到|请稍等|已等待/.test(String(value || ''));
  }



  const GFM_EMOJI_SHORTCODES = Object.freeze({
    smile: '😄',
    rocket: '🚀',
    heart: '❤️',
    thumbs_up: '👍',
    '+1': '👍',
    thumbs_down: '👎',
    '-1': '👎',
    white_check_mark: '✅',
    checkered_flag: '🏁',
    warning: '⚠️',
    fire: '🔥',
    tada: '🎉',
    star: '⭐',
    sparkles: '✨',
    bug: '🐛',
    memo: '📝',
    bulb: '💡',
    eyes: '👀',
    x: '❌',
    heavy_check_mark: '✔️',
    information_source: 'ℹ️',
  });

  function replaceGfmEmojiShortcodes(value = '', shortcodes = GFM_EMOJI_SHORTCODES) {
    const text = String(value || '');
    let output = '';
    let index = 0;
    let atLineStart = true;
    let inFence = false;
    let fenceChar = '';
    let fenceLength = 0;

    while (index < text.length) {
      if (atLineStart) {
        const lineEnd = text.indexOf('\n', index);
        const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
        const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
        if (fence) {
          const marker = fence[1];
          const rest = fence[2] || '';
          const char = marker[0];
          const closing = /^\s*$/.test(rest);
          if (inFence) {
            if (char === fenceChar && marker.length >= fenceLength && closing) {
              inFence = false;
              fenceChar = '';
              fenceLength = 0;
            }
          } else {
            inFence = true;
            fenceChar = char;
            fenceLength = marker.length;
          }
        }
      }

      if (!inFence && text[index] === '`') {
        const ticks = text.slice(index).match(/^`+/)?.[0] || '`';
        const end = text.indexOf(ticks, index + ticks.length);
        if (end !== -1) {
          const code = text.slice(index, end + ticks.length);
          output += code;
          atLineStart = code.endsWith('\n');
          index = end + ticks.length;
          continue;
        }
      }

      if (!inFence && text[index] === ':') {
        const match = text.slice(index).match(/^:([a-zA-Z0-9_+\-]+):/);
        if (match) {
          const emoji = shortcodes[match[1]];
          if (emoji) {
            output += emoji;
            index += match[0].length;
            atLineStart = false;
            continue;
          }
        }
      }

      output += text[index];
      atLineStart = text[index] === '\n';
      index += 1;
    }
    return output;
  }

  function extractMathSegments(value = '') {
    const text = String(value || '');
    const math = [];
    let output = '';
    let index = 0;
    let atLineStart = true;
    let inFence = false;
    let fenceChar = '';
    let fenceLength = 0;

    const addMath = (raw, displayMode) => {
      const placeholder = `@@MATH${math.length}@@`;
      math.push({ raw, displayMode });
      output += placeholder;
    };
    const appendChar = () => {
      output += text[index];
      atLineStart = text[index] === '\n';
      index += 1;
    };

    while (index < text.length) {
      if (atLineStart) {
        const lineEnd = text.indexOf('\n', index);
        const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
        const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
        if (fence) {
          const marker = fence[1];
          const rest = fence[2] || '';
          const char = marker[0];
          const closing = /^\s*$/.test(rest);
          if (inFence) {
            if (char === fenceChar && marker.length >= fenceLength && closing) {
              inFence = false;
              fenceChar = '';
              fenceLength = 0;
            }
          } else {
            inFence = true;
            fenceChar = char;
            fenceLength = marker.length;
          }
        }
      }

      if (inFence) {
        appendChar();
        continue;
      }

      if (text.startsWith('$$', index)) {
        const end = text.indexOf('$$', index + 2);
        if (end !== -1) {
          addMath(text.slice(index + 2, end), true);
          index = end + 2;
          continue;
        }
      }
      if (text.startsWith('\\[', index)) {
        const end = text.indexOf('\\]', index + 2);
        if (end !== -1) {
          addMath(text.slice(index + 2, end), true);
          index = end + 2;
          continue;
        }
      }
      if (text.startsWith('\\(', index)) {
        const end = text.indexOf('\\)', index + 2);
        if (end !== -1) {
          addMath(text.slice(index + 2, end), false);
          index = end + 2;
          continue;
        }
      }
      if (text[index] === '$' && text[index + 1] !== '$') {
        let end = index + 1;
        while (end < text.length && (text[end] !== '$' || text[end - 1] === '\\')) end += 1;
        if (end < text.length && end > index + 1) {
          const raw = text.slice(index + 1, end);
          if (!/^\s*$/.test(raw)) {
            addMath(raw, false);
            index = end + 1;
            continue;
          }
        }
      }
      appendChar();
    }
    return { text: output, math };
  }

  function restoreMathSegments(value, math = [], { katex = null, escapeHtml = String } = {}) {
    return String(value || '').replace(/@@MATH(\d+)@@/g, (match, index) => {
      const item = math[Number(index)];
      if (!item) return '';
      try {
        if (!katex) throw new Error('KaTeX not loaded');
        return katex.renderToString(item.raw, {
          displayMode: item.displayMode,
          throwOnError: false,
          strict: false,
          trust: false,
          output: 'html',
        });
      } catch {
        return item.displayMode
          ? `<div class="math-fallback">${escapeHtml(item.raw)}</div>`
          : `<span class="math-fallback">${escapeHtml(item.raw)}</span>`;
      }
    });
  }

  function normalizeExtendedMarkdown(value = '', { renderMarkdown = text => String(text || ''), escapeAttr = String } = {}) {
    const lines = String(value || '').split('\n');
    const footnotes = [];
    const references = new Map();
    const content = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLength = 0;
    let activeFootnote = null;

    const flushFootnote = () => {
      if (!activeFootnote) return;
      const text = (activeFootnote.lines || []).join('\n').trim();
      footnotes.push({ id: activeFootnote.id, text });
      activeFootnote = null;
    };

    for (const line of lines) {
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const marker = fence[1];
        const rest = fence[2] || '';
        const char = marker[0];
        const closing = /^\s*$/.test(rest);
        if (inFence) {
          if (char === fenceChar && marker.length >= fenceLength && closing) {
            inFence = false;
            fenceChar = '';
            fenceLength = 0;
          }
        } else {
          inFence = true;
          fenceChar = char;
          fenceLength = marker.length;
        }
        if (activeFootnote) activeFootnote.lines.push(line.replace(/^ {4}/, ''));
        else content.push(line);
        continue;
      }

      if (!inFence) {
        const footnote = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
        if (footnote) {
          flushFootnote();
          activeFootnote = { id: footnote[1], lines: [footnote[2]] };
          continue;
        }
        if (activeFootnote) {
          if (/^(?: {2,}|\t)/.test(line)) {
            activeFootnote.lines.push(line.replace(/^(?: {2,}|\t)/, ''));
            continue;
          }
          if (/^\s*$/.test(line)) {
            activeFootnote.lines.push('');
            continue;
          }
          flushFootnote();
        }
        const reference = line.match(/^\[([^\]]+)\]:\s*(\S+)(?:\s+["']([^"']+)["'])?\s*$/);
        if (reference && !reference[1].startsWith('^')) {
          references.set(reference[1].toLowerCase(), { url: reference[2], title: reference[3] || '' });
          content.push(line);
          continue;
        }
      }

      if (activeFootnote) activeFootnote.lines.push(line);
      else content.push(line);
    }
    flushFootnote();

    let normalized = replaceGfmEmojiShortcodes(content.join('\n'));
    normalized = normalized.replace(/!\[([^\]]*)\]\[([^\]]+)\]/g, (match, alt, id) => {
      const reference = references.get(String(id).toLowerCase());
      if (!reference) return match;
      const title = reference.title ? ` "${reference.title.replace(/"/g, '&quot;')}"` : '';
      return `![${alt}](${reference.url}${title})`;
    });
    normalized = normalized.replace(/(?<!!)\[([^\]]+)\]\[([^\]]+)\]/g, (match, text, id) => {
      const reference = references.get(String(id).toLowerCase());
      if (!reference) return match;
      const title = reference.title ? ` "${reference.title.replace(/"/g, '&quot;')}"` : '';
      return `[${text}](${reference.url}${title})`;
    });
    normalized = normalized.replace(/==([^=\n][\s\S]*?[^=\n])==/g, '<mark>$1</mark>');
    normalized = normalized.replace(/~([^~\n]+)~/g, '<sub>$1</sub>');
    normalized = normalized.replace(/\^([^\^\n]+)\^/g, '<sup>$1</sup>');
    normalized = normalized.replace(/\[\^([^\]]+)\]/g, '<sup class="footnote-ref"><a href="#fn-$1" id="fnref-$1">[$1]</a></sup>');

    if (footnotes.length) {
      normalized += '\n\n<section class="footnotes">\n<ol>\n'
        + footnotes.map(item => {
          const html = renderMarkdown(String(item.text || '')).replace(/^<p>|<\/p>$/g, '');
          return `<li id="fn-${escapeAttr(item.id)}">${html} <a href="#fnref-${escapeAttr(item.id)}" class="footnote-backref">↩</a></li>`;
        }).join('\n')
        + '\n</ol>\n</section>';
    }
    return normalized;
  }

  function slugifyHeading(value = '') {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[`~!@#$%^&*()+=[\]{};:'",.<>/?\\|]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  function repairMarkdownPunctuation(value = '') {
    return String(value || '');
  }

  function repairCollapsedMarkdownBlocks(value = '') {
    return String(value || '');
  }

  function splitTableRow(value) {
    return String(value || '')
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());
  }

  function prepareMarkdownSource(value = '') {
    return normalizeExtendedMarkdown(repairCollapsedMarkdownBlocks(repairMarkdownPunctuation(value)));
  }

  function renderLists(value) {
    const lines = String(value || '').split('\n');
    const output = [];
    let inUnordered = false;
    let inOrdered = false;

    function closeLists() {
      if (inUnordered) {
        output.push('</ul>');
        inUnordered = false;
      }
      if (inOrdered) {
        output.push('</ol>');
        inOrdered = false;
      }
    }

    for (const line of lines) {
      const unordered = line.match(/^\s*[-*]\s+(.+)/);
      const ordered = line.match(/^\s*\d+\.\s+(.+)/);
      if (unordered) {
        if (inOrdered) closeLists();
        if (!inUnordered) {
          output.push('<ul>');
          inUnordered = true;
        }
        output.push(`<li>${unordered[1]}</li>`);
      } else if (ordered) {
        if (inUnordered) closeLists();
        if (!inOrdered) {
          output.push('<ol>');
          inOrdered = true;
        }
        output.push(`<li>${ordered[1]}</li>`);
      } else {
        closeLists();
        output.push(line);
      }
    }
    closeLists();
    return output.join('\n');
  }

  function renderLegacyCodeBlockHtml(block, { escapeHtml = String, escapeAttr = String, copyIconSvg = '' } = {}) {
    const raw = String(block?.raw || '');
    const lang = /^(?:text|txt|plain|plaintext)$/i.test(block?.lang || '') ? '' : String(block?.lang || '');
    const langHtml = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
    const copyButton = `<button class="inline-copy code-copy-icon" type="button" title="复制代码" aria-label="复制代码" data-copy-text="${escapeAttr(raw)}">${copyIconSvg}</button>`;
    return `<div class="code-block">${langHtml}${copyButton}<pre><code>${escapeHtml(raw)}</code></pre></div>`;
  }

  function extractLegacyCodeBlocks(value) {
    const blocks = [];
    const text = String(value || '').replace(/```([\w-]*)?\n?([\s\S]*?)```/g, (match, lang, rawCode) => {
      const raw = String(rawCode || '').replace(/\n$/, '');
      if (!raw.trim()) return '';
      const placeholder = `@@CODE${blocks.length}@@`;
      blocks.push({ lang: lang || '', raw });
      return placeholder;
    });
    return { text, blocks };
  }

  function restoreLegacyCodeBlocks(value, blocks = [], options = {}) {
    let output = String(value || '');
    blocks.forEach((block, index) => {
      output = output.replace(`@@CODE${index}@@`, renderLegacyCodeBlockHtml(block, options));
    });
    return output;
  }

  function renderLegacyInlineMarkdown(value) {
    return String(value || '')
      .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
      .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
      .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h1>$1</h1>')
      .replace(/^---$/gm, '<hr>')
      .replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>')
      .replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>')
      .replace(/__([\s\S]*?)__/g, '<strong>$1</strong>')
      .replace(/~~([\s\S]*?)~~/g, '<del>$1</del>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" />')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }

  function wrapLegacyParagraphs(value) {
    return String(value || '').split(/\n{2,}/)
      .map(block => /^\s*<(h\d|ul|ol|blockquote|pre|div|table|hr|img)/.test(block) ? block : `<p>${block.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function renderMarkdownLegacy(value, { escapeHtml = String, escapeAttr = String, copyIconSvg = '' } = {}) {
    const extracted = extractLegacyCodeBlocks(value);
    let html = escapeHtml(extracted.text);
    html = renderTables(html);
    html = renderLegacyInlineMarkdown(html);
    html = renderLists(html);
    html = wrapLegacyParagraphs(html);
    return restoreLegacyCodeBlocks(html, extracted.blocks, { escapeHtml, escapeAttr, copyIconSvg });
  }

  function renderTables(value) {
    const lines = String(value || '').split('\n');
    const out = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (
        index + 1 < lines.length
        && /^\s*\|.*\|\s*$/.test(lines[index])
        && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])
      ) {
        const headers = splitTableRow(lines[index]);
        index += 2;
        const rows = [];
        while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        index -= 1;
        const thead = `<thead><tr>${headers.map(cell => `<th>${cell}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td>${row[cellIndex] || ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
        out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      } else {
        out.push(lines[index]);
      }
    }
    return out.join('\n');
  }



  function makeRun(sessionId) {
    return {
      sessionId,
      token: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      abortController: new AbortController(),
      jobIds: new Set(),
      stopped: false,
    };
  }

  function getActiveRun(appState, sessionId) {
    return appState.activeRuns?.get(sessionId) || null;
  }

  function ensureActiveRun(appState, sessionId) {
    let run = getActiveRun(appState, sessionId);
    if (!run) {
      run = makeRun(sessionId);
      appState.activeRuns.set(sessionId, run);
    }
    return run;
  }

  function addActiveRunJob(appState, sessionId, type, jobId) {
    if (!jobId) return false;
    const run = getActiveRun(appState, sessionId);
    if (!run) return false;
    run.jobIds.add(`${type}:${jobId}`);
    return true;
  }

  function isRunStopped(appState, sessionId) {
    return !!getActiveRun(appState, sessionId)?.stopped;
  }

  function bindFollowingRun(appState, sessionId, jobId, type = 'chat') {
    if (!jobId) return null;
    const run = ensureActiveRun(appState, sessionId);
    run.jobIds.add(`${type}:${jobId}`);
    return run;
  }



  function sessionStorageKey(baseKey, sessionId) {
    return `${baseKey}:${sessionId || 'default'}`;
  }

  function deriveSessionTitle(session = {}) {
    const custom = String(session.customTitle || '').replace(/\s+/g, ' ').trim();
    if (custom) return custom.slice(0, 40);
    const firstUser = session.messages?.find(item => item.role === 'user' && item.content)?.content || '';
    const title = String(firstUser || session.title || '新对话').replace(/\s+/g, ' ').trim();
    return title ? title.slice(0, 22) : '新对话';
  }

  function getSessionReturnCount({ session, activeSessionId, activeMessages = [], isBusy = false, domCount = 0 } = {}) {
    if (!session) return 0;
    const messages = session.id !== activeSessionId || isBusy ? session.messages || [] : activeMessages;
    const assistantCount = Array.isArray(messages) ? messages.filter(item => item?.role === 'assistant').length : 0;
    if (assistantCount) return assistantCount;
    return session.id !== activeSessionId || isBusy
      ? (session.display || []).filter(item => item?.role === 'assistant' || item?.role === 'error').length
      : Number(domCount) || 0;
  }



  function stripLargeDataUrlsFromText(text = '') {
    return String(text || '').replace(/data:[^"'<>`\s]+;base64,[A-Za-z0-9+/=]{2048,}/g, '[attachment-data-omitted]');
  }

  function sanitizeAttachmentContextForStorage(value) {
    if (!value) return '';
    try {
      const context = typeof value === 'string' ? JSON.parse(value) : value;
      if (!context || typeof context !== 'object') return '';
      const sanitized = {
        ...context,
        attachments: Array.isArray(context.attachments) ? context.attachments.map(item => {
          const copy = { ...item };
          if (copy.src && String(copy.src).startsWith('data:')) copy.src = '';
          return copy;
        }).filter(item => item.name || item.src || item.text) : [],
      };
      return JSON.stringify(sanitized);
    } catch { return ''; }
  }

  function sanitizeStoredDisplayItem(item = {}) {
    return {
      ...item,
      html: stripLargeDataUrlsFromText(item.html || ''),
      rawText: stripLargeDataUrlsFromText(item.rawText || ''),
      imageContext: sanitizeAttachmentContextForStorage(item.imageContext) || item.imageContext || '',
      attachmentContext: sanitizeAttachmentContextForStorage(item.attachmentContext),
    };
  }

  function sanitizeStoredMessage(message = {}) {
    const next = { ...message };
    next.content = stripLargeDataUrlsFromText(next.content || '');
    next.rawText = stripLargeDataUrlsFromText(next.rawText || '');
    if (next.html) next.html = stripLargeDataUrlsFromText(next.html);
    next.imageContext = sanitizeAttachmentContextForStorage(next.imageContext) || next.imageContext || '';
    next.attachmentContext = sanitizeAttachmentContextForStorage(next.attachmentContext);
    return next;
  }

  function safeSetJsonStorage(key, value, maxItems = 80, storage = localStorage) {
    let items = Array.isArray(value) ? value : value ? [value] : [];
    for (let limit = Math.min(Number(maxItems) || 80, items.length || 1); limit >= 0; limit = Math.floor(limit / 2)) {
      const candidate = Array.isArray(value) ? items.slice(-limit) : value;
      try { storage.setItem(key, JSON.stringify(candidate)); return candidate; }
      catch (err) { if (!/quota|exceed/i.test(`${err?.name || ''} ${err?.message || ''} ${err || ''}`)) throw err; }
      if (limit <= 1) break;
    }
    try { storage.removeItem(key); } catch {}
    return Array.isArray(value) ? [] : null;
  }

  function stripLargePayloadData(value) {
    if (typeof value === 'string') return stripLargeDataUrlsFromText(value);
    if (Array.isArray(value)) return value.map(stripLargePayloadData);
    if (value && typeof value === 'object') {
      const copy = { ...value };
      if (Array.isArray(copy.messages)) copy.messages = copy.messages.slice(-20);
      Object.keys(copy).forEach(key => { copy[key] = stripLargePayloadData(copy[key]); });
      return copy;
    }
    return value;
  }

  function compactJobForStorage(job, keepPayload = true) {
    if (!job || typeof job !== 'object') return job;
    const copy = { ...job };
    if (copy.payload) copy.payload = keepPayload ? stripLargePayloadData(copy.payload) : null;
    return copy;
  }

  function safeSetJobStorage(key, job, storage = localStorage) {
    if (!job?.id) return;
    const fallbacks = [
      compactJobForStorage(job, true),
      compactJobForStorage(job, false),
      {
        id: job.id,
        prompt: job.prompt || '',
        startedAt: job.startedAt || Date.now(),
        displayItemId: job.displayItemId || '',
        responseIndex: job.responseIndex ?? null,
        mode: job.mode || '',
        imageContext: job.imageContext || null,
        liveItemRawText: job.liveItemRawText || '',
      },
    ];
    for (const candidate of fallbacks) {
      try { storage.setItem(key, JSON.stringify(candidate)); return; }
      catch (err) { if (!/quota|exceed/i.test(`${err?.name || ''} ${err?.message || ''} ${err || ''}`)) throw err; }
    }
    try { storage.removeItem(key); } catch {}
  }

  function compactDisplayItems(items = []) {
    const result = [];
    for (const item of items || []) {
      if (!item) continue;
      const prev = result[result.length - 1];
      const key = [item.role || '', item.rawText || '', item.html || '', item.pending || '', item.jobId || '', item.responseIndex || '', item.messageIndex || ''].join('');
      const prevKey = prev ? [prev.role || '', prev.rawText || '', prev.html || '', prev.pending || '', prev.jobId || '', prev.responseIndex || '', prev.messageIndex || ''].join('') : '';
      if (prev && key === prevKey) {
        if (item.metaText && !prev.metaText) prev.metaText = item.metaText;
        if (item.reasoningText && !prev.reasoningText) prev.reasoningText = item.reasoningText;
        if (item.keepReasoning && !prev.keepReasoning) prev.keepReasoning = item.keepReasoning;
      } else {
        result.push(item);
      }
    }
    return result;
  }

  function makeDisplayItemId() {
    return `display_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function displayItemHasRichMedia(item) {
    return !!(item?.html && (/data-persisted-src=/.test(item.html) || /data-persisted-href=/.test(item.html) || /user-attachment-preview-grid/.test(item.html) || /class=["'][^"']*generated-thumb/.test(item.html) || /class=["'][^"']*user-attachment-image/.test(item.html) || /image-download-row/.test(item.html)));
  }

  window.ChatUIApp = Object.freeze({
    ...(window.ChatUIApp || {}),
    state: Object.freeze({ createSession, ensureActiveSession, isSessionBusy }),
    sessionConfig: Object.freeze({ getEffectiveImageStylePrompt, getSessionChatModel, sessionChatModelValue, sessionModelOptions, normalizeSessionChatModel }),
    headerParams: Object.freeze({ normalizeHeaderParamConfig, generateShortUuid, buildRequestHeadersFromParams }),
    formatting: Object.freeze({ formatElapsed, firstTokenTimeText, escapeHtml, escapeAttr, renderStreamingText, pendingFeedbackHtml, isChatStatusText }),
    markdownUtils: Object.freeze({ GFM_EMOJI_SHORTCODES, replaceGfmEmojiShortcodes, normalizeExtendedMarkdown, prepareMarkdownSource, renderLists, renderLegacyCodeBlockHtml, extractLegacyCodeBlocks, restoreLegacyCodeBlocks, renderLegacyInlineMarkdown, wrapLegacyParagraphs, renderMarkdownLegacy, extractMathSegments, restoreMathSegments, slugifyHeading, repairMarkdownPunctuation, repairCollapsedMarkdownBlocks, splitTableRow, renderTables }),
    runs: Object.freeze({ makeRun, getActiveRun, ensureActiveRun, addActiveRunJob, isRunStopped, bindFollowingRun }),
    sessions: Object.freeze({ sessionStorageKey, deriveSessionTitle, getSessionReturnCount }),
    persistence: Object.freeze({ stripLargeDataUrlsFromText, sanitizeAttachmentContextForStorage, sanitizeStoredDisplayItem, sanitizeStoredMessage, safeSetJsonStorage, stripLargePayloadData, compactJobForStorage, safeSetJobStorage }),
    displayItems: Object.freeze({ compactDisplayItems, makeDisplayItemId, displayItemHasRichMedia }),
  });
})();
