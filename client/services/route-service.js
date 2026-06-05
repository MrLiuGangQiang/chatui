(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = "你是 ChatUI 意图路由器。一次性判断本次输入走 chat、image 还是 edit_image；只输出 JSON。\n\n输出：\n{\"mode\":\"chat|image|edit_image\",\"target\":\"none|new|uploaded|previous\",\"use_previous_image\":false,\"selected_reference_id\":\"imgref_...\",\"selected_indexes\":[],\"selected_image_ids\":[],\"contextual_image_prompt\":\"\",\"confidence\":0.0,\"evidence\":\"\"}\n\n流程：\n1. 普通对话/解释/总结/翻译/代码/文本改写/Markdown 或 md 文档生成/数学公式/表格/图表语法/图片链接或外链示例 => chat + none。\n2. 从零创建/绘制/生成图片文件、海报、头像、logo、人物、动物、场景 => image + new。\n3. 修改/编辑/调整/替换/去掉/加上/换背景/继续改已有图片 => edit_image，并按下列规则选图。\n4. 如果 current_input 是“按照上述要求生成图片/按上面要求出图/根据前面描述生成图”等引用型生图，仍然在本次路由调用内判断为 image + new，并从 context.recent_messages 提取最近相关视觉需求，写入 contextual_image_prompt。\n\n引用型生图：\n- contextual_image_prompt 必须是可直接给生图模型的完整提示；历史是视觉描述时保留主体、风格、构图、尺寸、文字等要求。\n- 历史是文字需求、方案、流程、架构说明、功能说明时，也要把相关内容转成适合图片模型的视觉表达提示，例如流程图、信息图、架构图、界面示意图、技术说明图或海报；不要因为“不是视觉描述”而返回 chat。\n- 只允许使用 context.recent_messages 与 current_input 提取和改写相关内容；忽略发版、测试、配置、闲聊等无关历史。\n- 只有历史中完全没有可引用的相关内容时，才返回 chat + none，并在 evidence 说明缺少可用上下文。\n\n编辑选图：\n- 指本次上传/附件/原图/我发的图 => uploaded，use_previous_image=false。\n- 指上一张/刚才那张/最近结果/继续改 => previous，use_previous_image=true，selected_reference_id=imgref_latest。\n- 指更早图片，如“最开始的图/第一版/前面那张” => 必须从 context.recent_image_references 选最匹配的 selected_reference_id，不能默认最新图。\n- 未明确哪张已有图 => 用 context.latest_image_reference；多图组默认整组。\n\n精准选单图/多图：\n- 用户指定第 N 张、左/右/中间、某对象/标签/文件名时，必须在对应 reference 的 candidates 中匹配具体图片。\n- 填 1-based selected_indexes，并优先填对应 candidates.image_id 到 selected_image_ids；image_id 必须原样保留 img_ 前缀。\n- 选多张就填多个；无法确定具体图时不要猜，selected_indexes=[]、selected_image_ids=[] 表示整组。\n\n约束：\n- selected_reference_id 必须原样保留 imgref_ 前缀；最新图组用 imgref_latest。\n- 只能根据 current_input、recent_messages、last_generated_image、latest_uploaded_image、latest_image_reference、recent_image_references、attachments 元数据判断。\n- attachments 只有文件名/类型/大小/是否图片；不要读取、分析或臆测图片内容，不要使用 base64/附件正文。\n- 附件不含图片且未明确编辑已有图片 => chat + none。\n- 出现“图片/图表/链接”但用户要求输出 Markdown、文档、文本内容或语法示例时，仍然是 chat，不是 image。\n- confidence 表示把握；evidence 用一句短中文说明依据。";

const imageRouteContext = root?.ChatUICoreImageRouteContext
  || root?.ChatUICore?.imageRouteContext
  || root?.window?.ChatUICoreImageRouteContext
  || root?.window?.ChatUICore?.imageRouteContext
  || (typeof require === 'function' ? require('../core/image-route-context') : {});
const { inferLocalImageRoute } = imageRouteContext;

function stripJsonFence(text = '') {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function parseRouteResult(text = '', normalizeRoute) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (typeof normalizeRoute !== 'function') throw new TypeError('normalizeRoute is required');
  try {
    const parsed = JSON.parse(stripJsonFence(value));
    const route = normalizeRoute(parsed);
    const contextualPrompt = String(parsed.contextual_image_prompt || parsed.contextualImagePrompt || '').trim();
    return contextualPrompt ? { ...route, contextualImagePrompt: contextualPrompt } : route;
  } catch {}
  const lower = value.toLowerCase();
  if (lower === 'edit_image') return normalizeRoute({ mode: 'edit_image', target: 'previous', use_previous_image: false, confidence: 0.5, evidence: '' });
  if (lower === 'image') return normalizeRoute({ mode: 'image', target: 'new', use_previous_image: false, confidence: 0.8 });
  if (lower === 'chat') return normalizeRoute({ mode: 'chat', target: 'none', use_previous_image: false, confidence: 0.8 });
  return null;
}

function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, systemPrompt = ROUTE_SYSTEM_PROMPT } = {}) {
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ current_input: input, current_mode: currentMode, auto_mode: autoMode, attachments, context }, null, 2) },
    ],
  };
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT,
  stripJsonFence,
  parseRouteResult,
  inferLocalImageRoute,
  buildRoutePayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
