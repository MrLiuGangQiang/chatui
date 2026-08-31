(function initChatUIExecutionStatus(root) {
  'use strict';

  const ROUTE_STAGE_TEXT = Object.freeze({
    reading_context: '正在读取当前对话上下文',
    understanding: '正在理解你的请求',
    compiling_shape: '正在确定任务数量和类型',
    collecting_resources: '正在整理本轮图片和文件',
    recognizing_intent: '正在判断任务意图和所需资源',
    validating_route: '正在校验意图和资源选择',
    repairing_route: '正在修正任务识别结果',
    retrying_route_model: '正在重新确认任务意图',
    planning_multi_tasks: '正在拆分多个任务',
    planning_image_tasks: '正在拆分多个图片任务',
    materializing_image_instruction: '正在整理完整的图片执行指令',
    preparing_clarification: '正在准备需要补充的信息',
  });

  const OPERATION_STATUS = Object.freeze({
    plain_chat: Object.freeze({
      prepare: '正在准备回答',
      execute: '正在等待模型生成回答',
    }),
    web_search: Object.freeze({
      prepare: '正在准备联网搜索',
      execute: '正在搜索网页并整理答案',
    }),
    ocr: Object.freeze({
      prepare: '正在准备文字提取所需图片',
      execute: '正在提取图片文字',
    }),
    image_compare: Object.freeze({
      prepare: '正在准备需要比较的图片',
      execute: '正在比较所选图片',
    }),
    image_qa: Object.freeze({
      prepare: '正在准备图片分析',
      execute: '正在分析图片',
    }),
    file_qa: Object.freeze({
      prepare: '正在准备文件内容',
      execute: '正在分析文件',
    }),
    multimodal_qa: Object.freeze({
      prepare: '正在准备图片和文件',
      execute: '正在结合图片和文件分析',
    }),
    text_to_image: Object.freeze({
      prepare: '正在准备图片生成参数',
      execute: '正在生成图片',
    }),
    image_reference_gen: Object.freeze({
      prepare: '正在准备参考图生成任务',
      execute: '正在基于参考图生成图片',
    }),
    edit_image: Object.freeze({
      prepare: '正在准备图片修改任务',
      execute: '正在修改图片',
    }),
  });

  const DEFAULT_OPERATION_STATUS = Object.freeze({
    prepare: '正在准备执行任务',
    execute: '正在等待任务结果',
  });

  const HUMAN_TEXT_MAP = Object.freeze({
    intent_critic: '语义检查', route_repair: '任务内容修正', route_intent: '请求理解结果',
    'route_intent.v3': '请求理解结果', intent_recognition: '任务判断', intent_understanding: '请求理解',
    current_input: '当前消息', review: '检查任务内容', accept: '检查通过', invalid_output: '需要重新确认',
    pending: '等待处理', running: '处理中', failed: '处理失败', completed: '已完成', primary: '', fallback: '',
    plain_chat: '普通对话', web_search: '联网搜索', ocr: '图片文字识别', image_compare: '图片比较', image_qa: '图片分析', file_qa: '文件分析', multimodal_qa: '图片和文件分析', text_to_image: '生成图片', image_reference_gen: '参考图生成', edit_image: '修改图片', image_generation: '生成图片', image_edit: '修改图片',
    transient_error: '网络暂时不稳定', configuration_error: '服务配置需要检查', invalid_model_output: '模型返回的结果无法使用', cancelled: '已停止处理',
    MODEL_CALL_BUDGET_EXCEEDED: '请求处理步骤过多', route_fallback: '重新确认请求', multi_task_planning: '多任务安排', image_planning: '图片任务安排',

  });


  function normalizeOperation(value = '') {
    if (value && typeof value === 'object') {
      return String(
        value.operation
        || value.operationType
        || value.dispatchContract?.operation
        || '',
      ).trim();
    }
    return String(value || '').trim();
  }

  function operationStatusText(operation, phase = 'prepare') {
    const key = normalizeOperation(operation);
    const normalizedPhase = phase === 'execute' ? 'execute' : 'prepare';
    return (OPERATION_STATUS[key] || DEFAULT_OPERATION_STATUS)[normalizedPhase];
  }

  function humanizeStatusText(value = '') {
    let text = String(value || '').trim();
    for (const key of Object.keys(HUMAN_TEXT_MAP).sort((a, b) => b.length - a.length)) {
      text = text.split(key).join(HUMAN_TEXT_MAP[key]);
    }
    return text;
  }

  function routeStageText(stage = '', details = {}) {
    const key = String(stage || '').trim();
    if (key === 'route_ready') return operationStatusText(details.operation || details.route, 'prepare');
    return ROUTE_STAGE_TEXT[key] || '';
  }

  function emitRouteStage(options = null, stage = '', details = {}) {
    const text = routeStageText(stage, details);
    if (!text || typeof options?.onStage !== 'function') return text;
    const event = Object.freeze({
      ...details,
      kind: 'route_stage',
      stage: String(stage || ''),
      text,
    });
    try {
      options.onStage(text, event);
    } catch (error) {
      console.warn('[route] status callback failed', error);
    }
    return text;
  }

  const knownStatusTexts = new Set([
    ...Object.values(ROUTE_STAGE_TEXT),
    ...Object.values(OPERATION_STATUS).flatMap(status => Object.values(status)),
    ...Object.values(DEFAULT_OPERATION_STATUS),
  ]);

  function normalizedStatusText(value = '') {
    return String(value || '')
      .trim()
      .replace(/[.。]{3}/g, '…')
      .replace(/\s+/g, ' ');
  }

  function isExecutionStatusText(value = '') {
    const text = normalizedStatusText(value);
    if (!text) return false;
    if (knownStatusTexts.has(text)) return true;
    if (/^(?:正在生成图片|正在修改图片|正在基于参考图生成图片|正在处理)(?:…)?\s*已等待\s*\d+\s*秒$/.test(text)) return true;
    return false;
  }

  const api = Object.freeze({
    ROUTE_STAGE_TEXT,
    OPERATION_STATUS,
    normalizeOperation,
    operationStatusText,
    HUMAN_TEXT_MAP,
    humanizeStatusText,
    routeStageText,
    emitRouteStage,
    isExecutionStatusText,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('executionStatus', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

