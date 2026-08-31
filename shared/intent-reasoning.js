(function initChatUIIntentReasoning(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('intentReasoning', api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createChatUIIntentReasoning() {
  'use strict';

  const INTENT_REASONING_VERSION = 'intent_reasoning.v1';
  const REASONING_STAGES = Object.freeze([
    'context', 'risk', 'understanding', 'grounding', 'routing',
    'checking', 'repair', 'clarification', 'completed', 'failed',
  ]);
  const REASONING_STATUSES = Object.freeze(['running', 'ready', 'clarify', 'failed', 'hidden']);
  const STEP_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed']);
  const MAX_STEPS = 24;
  const MAX_SUMMARY_LENGTH = 320;
  const MAX_EVIDENCE = 8;
  const SECRET_PATTERN = /(?:sk|key|token|secret|password)-?[A-Za-z0-9_-]{16,}/gi;
  const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
  const DATA_URL_PATTERN = /data:[^\s"']{0,80};base64,[A-Za-z0-9+/=\r\n]+/gi;

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function boundedText(value = '', limit = MAX_SUMMARY_LENGTH) {
    return stringValue(value)
      .replace(SECRET_PATTERN, '[已隐藏凭据]')
      .replace(BEARER_PATTERN, 'Bearer [已隐藏凭据]')
      .replace(DATA_URL_PATTERN, '[已隐藏二进制内容]')
      .replace(/[\*`#]/g, '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit);
  }

  function uniqueStrings(values = [], limit = MAX_EVIDENCE) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : [values]) {
      const normalized = boundedText(value, 96);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
      if (result.length >= limit) break;
    }
    return result;
  }

  function normalizeStage(value = '') {
    const stage = stringValue(value);
    return REASONING_STAGES.includes(stage) ? stage : 'routing';
  }

  function normalizeStepStatus(value = '') {
    const status = stringValue(value);
    return STEP_STATUSES.includes(status) ? status : 'completed';
  }

  function normalizeTraceStatus(value = '') {
    const status = stringValue(value);
    return REASONING_STATUSES.includes(status) ? status : 'running';
  }

  function normalizeStep(step = {}, index = 0) {
    const source = step && typeof step === 'object' && !Array.isArray(step) ? step : {};
    return Object.freeze({
      id: boundedText(source.id || `s${index + 1}`, 32),
      stage: normalizeStage(source.stage),
      status: normalizeStepStatus(source.status),
      summary: boundedText(source.summary || source.text || '', MAX_SUMMARY_LENGTH),
      evidence: uniqueStrings(source.evidence, MAX_EVIDENCE),
      decision: boundedText(source.decision || '', 96),
      reason_codes: uniqueStrings(source.reason_codes, 8),
    });
  }

  function normalizeTrace(trace = {}) {
    const source = trace && typeof trace === 'object' && !Array.isArray(trace) ? trace : {};
    const steps = (Array.isArray(source.steps) ? source.steps : [])
      .slice(-MAX_STEPS)
      .map((step, index) => normalizeStep(step, index));
    return Object.freeze({
      schema_version: INTENT_REASONING_VERSION,
      status: normalizeTraceStatus(source.status),
      request_id: boundedText(source.request_id || source.trace_id || '', 96),
      steps: Object.freeze(steps),
      final_summary: boundedText(source.final_summary || '', MAX_SUMMARY_LENGTH),
      hidden: source.hidden === true || source.status === 'hidden',
    });
  }

  function createTrace(options = {}) {
    return normalizeTrace({
      schema_version: INTENT_REASONING_VERSION,
      status: 'running',
      request_id: options.requestId || options.traceId || '',
      steps: [],
      final_summary: '',
      hidden: false,
    });
  }

  function appendStep(trace = {}, step = {}) {
    const current = normalizeTrace(trace);
    const normalized = normalizeStep(step, current.steps.length);
    const existingIndex = current.steps.findIndex(item => item.id === normalized.id);
    const steps = [...current.steps];
    if (existingIndex >= 0) steps[existingIndex] = normalized;
    else steps.push(normalized);
    return normalizeTrace({ ...current, steps: steps.slice(-MAX_STEPS) });
  }

  function completeTrace(trace = {}, options = {}) {
    const current = normalizeTrace(trace);
    const status = ['ready', 'clarify', 'failed', 'hidden'].includes(stringValue(options.status))
      ? stringValue(options.status)
      : 'ready';
    return normalizeTrace({
      ...current,
      status,
      final_summary: options.finalSummary || current.final_summary,
      hidden: options.hidden === true || status === 'hidden',
    });
  }

  const HUMAN_INTENT_TERMS = Object.freeze({
    routing: '正在确认你的请求', intent_critic: '语义检查', route_repair: '任务内容修正', route_intent: '请求理解结果', 'route_intent.v3': '请求理解结果', intent_recognition: '任务判断', intent_understanding: '请求理解', primary: '', fallback: '', review: '检查任务内容', accept: '检查通过', invalid_output: '需要重新确认',
    plain_chat: '普通对话', web_search: '联网搜索', ocr: '图片文字识别', image_compare: '图片比较', image_qa: '图片分析', file_qa: '文件分析', multimodal_qa: '图片和文件分析', text_to_image: '生成图片', image_reference_gen: '参考图生成', edit_image: '修改图片', image_generation: '生成图片', image_edit: '修改图片',
  });

  function humanizeIntentTerm(value = '') {
    let text = String(value || '').trim();
    for (const key of Object.keys(HUMAN_INTENT_TERMS).sort((a, b) => b.length - a.length)) text = text.split(key).join(HUMAN_INTENT_TERMS[key]);
    return text.replace(/\\s+·\\s+/g, ' · ').replace(/^\\s*·\\s*|\\s*·\\s*$/g, '').trim();
  }

  function stageSummary(stage = '', details = {}) {
    const normalized = normalizeStage(stage);
    const operation = humanizeIntentTerm(boundedText(details.operation || details.operationType || '', 64));
    const reason = humanizeIntentTerm(boundedText(details.reason || details.reasonCode || '', 96));
    const labels = {
      context: '已读取当前对话和任务上下文',
      risk: '已判断本轮理解复杂度',
      understanding: '正在拆解用户动作、约束和上下文关系',
      grounding: '正在确认指代和资源绑定',
      routing: '正在确认你的请求',
      checking: '正在检查要求覆盖和语义一致性',
      repair: '正在针对发现的问题重新理解',
      clarification: '已识别出会影响执行的歧义',
      completed: '意图识别完成',
      failed: '意图识别未完成',
    };
    let summary = labels[normalized] || '正在处理意图识别';
    if (operation) summary += `（${operation}）`;
    if (reason) summary += ` · ${reason}`;
    return summary;
  }

  function traceText(trace = {}, options = {}) {
    const normalized = normalizeTrace(trace);
    const lines = [];
    const steps = normalized.steps.filter(step => step.summary || step.decision);
    for (const step of steps) {
      const mark = step.status === 'failed' ? '✕' : step.status === 'completed' ? '✓' : '·';
      const detail = step.decision ? `：${step.decision}` : '';
      lines.push(`${mark} ${step.summary || step.stage}${detail}`);
    }
    if (normalized.final_summary && options.includeFinal !== false) lines.push(`结果：${normalized.final_summary}`);
    return lines.join('\n');
  }

  function extractReasoningSummary(response = {}) {
    const summaries = [];
    const seen = new Set();
    function collectText(value, depth = 0) {
      if (depth > 8 || value === null || value === undefined) return;
      if (typeof value === 'string') {
        const normalized = boundedText(value);
        if (normalized) summaries.push(normalized);
        return;
      }
      if (typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach(item => collectText(item, depth + 1));
        return;
      }
      for (const key of ['text', 'content', 'output_text', 'summary_text', 'summary', 'reasoning_summary']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) collectText(value[key], depth + 1);
      }
    }
    function visit(value, depth = 0) {
      if (depth > 8 || value === null || value === undefined || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach(item => visit(item, depth + 1));
        return;
      }
      const type = stringValue(value.type || value.role).toLowerCase();
      if (/reasoning|analysis/.test(type)) {
        // Only provider-declared summary fields are user-visible. Never fall
        // through to raw reasoning/content fields, which may contain private
        // chain-of-thought rather than a safe summary.
        for (const key of ['summary_text', 'reasoning_summary', 'reasoning_summary_text', 'summary', 'summary_text_delta']) {
          if (Object.prototype.hasOwnProperty.call(value, key)) collectText(value[key], depth + 1);
        }
      }
      for (const key of ['output', 'response', 'content', 'summary', 'summary_text']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) visit(value[key], depth + 1);
      }
    }
    visit(response);
    return uniqueStrings(summaries, 6).join(' ');
  }

  function assessIntentRisk({ input = '', attachments = [], context = {} } = {}) {
    const text = stringValue(input);
    const signals = [];
    let score = 0;
    const add = (name, weight) => {
      if (!signals.includes(name)) {
        signals.push(name);
        score += weight;
      }
    };
    const contextObject = context && typeof context === 'object' ? context : {};
    if (Array.isArray(attachments) && attachments.length) add('current_resources', 1);
    if (contextObject.quoted_message
        || Array.isArray(contextObject.image_candidates) && contextObject.image_candidates.some(item => item?.source === 'quoted')
        || Array.isArray(contextObject.file_candidates) && contextObject.file_candidates.some(item => item?.source === 'quoted')) add('quoted_context', 2);
    if (contextObject.previous_execution || contextObject.previous_resource_execution || contextObject.conversation_focus) add('cross_turn_state', 1);
    if (contextObject.clarification_context || contextObject.pending_task) add('pending_clarification', 2);
    const delivered = contextObject.delivery_evidence?.actual_image_result?.available === true
      || contextObject.delivery_evidence?.image_delivery_confirmed === true;
    const priorGeneration = (Array.isArray(contextObject.recent_messages) ? contextObject.recent_messages : [])
      .some(message => message?.role === 'user' && /(?:生成|画|绘制|制作|创建|generate|draw|create)/i.test(String(message?.content || message?.rawText || '')));
    const currentVisualConstraint = /(?:户型|平面图|堂屋|入户门|双开门|背景|构图|布局|颜色|色调|材质|风格|尺寸|比例|卧室|餐厅|卫生间|visual|layout|door|background|composition|style|size)/i.test(text);
    const explicitCurrentTask = /(?:\u6211\u8981|\u8bf7\u5e2e|\u8bf7\u8f93\u51fa|\u8bf7\u63d0\u4f9b|\u8f93\u51fa|\u603b\u7ed3|\u5206\u6790|\u63d0\u53d6|describe|analy[sz]e|summari[sz]e|output|create|generate|draw)/i.test(text);
    const explicitContinuation = /(?:\u7ee7\u7eed|\u63a5\u7740|\u518d\u6b21|\u518d\u751f\u6210|\u518d\u753b|again|continue|then)/i.test(text);
    if (!delivered && priorGeneration && currentVisualConstraint && (!explicitCurrentTask || explicitContinuation)) add('undelivered_generation_followup', 5);
    if (Array.isArray(attachments) && attachments.length > 1) add('multiple_resources', 1);
    if (text.length > 180) add('long_input', 1);
    if (/(?:这个|那个|它|这张|那张|上一张|上一条|刚才|之前|第\s*[一二两三四五六七八九十\d]+|the\s+(?:previous|last|second)|it\b)/i.test(text)) add('deixis', 2);
    if (/(?:不要|别|不使用|不用|无需|而不是|不是|但不要|保持.*不变|do not|don't|without|instead of)/i.test(text)) add('negation_or_correction', 2);
    if (/(?:如果|否则|除非|只有.*才|如果.*就|否则|when|unless|if\b)/i.test(text)) add('conditional', 2);
    if (/(?:先|再|然后|之后|接着|同时|分别|既要|又要|并且|以及|最后|first|then|after|before|and then)/i.test(text)) add('multiple_actions', 2);
    if (/(?:第\s*[一二两三四五六七八九十\d]+|两张|三张|四张|多张|多个|分别|各自|每张|two|three|each|respectively)/i.test(text)) add('cardinality_or_order', 1);
    if (/[？?].{0,80}[。.!！]/.test(text) || /(?:比较|对比|差异|哪个更|是否|compare|which)/i.test(text)) add('comparison_or_question', 1);
    const level = score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';
    return Object.freeze({ level, score, signals: Object.freeze(signals) });
  }

  return Object.freeze({
    INTENT_REASONING_VERSION,
    REASONING_STAGES,
    REASONING_STATUSES,
    STEP_STATUSES,
    boundedText,
    normalizeTrace,
    createTrace,
    appendStep,
    completeTrace,
    stageSummary,
    humanizeIntentTerm,
    traceText,
    extractReasoningSummary,
    assessIntentRisk,
  });
});



