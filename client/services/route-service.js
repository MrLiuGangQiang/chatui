(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = "你是 ChatUI 图片意图与执行计划路由器。只判断本次输入走 chat、image 或 edit_image，并输出图片选择与执行参数；只输出 JSON。路由器不得改写、补全、翻译、扩写用户提示词。\n\n输出：{\"mode\":\"chat|image|edit_image\",\"target\":\"none|new|uploaded|previous\",\"use_previous_image\":false,\"selected_reference_id\":\"imgref_...\",\"selected_indexes\":[],\"selected_image_ids\":[],\"need_clarification\":false,\"clarification_question\":\"\",\"intent\":\"text_to_image|image_edit_single|image_edit_batch|image_compose|image_reference_gen|unknown\",\"tasks\":[{\"task_type\":\"generate|edit\",\"input_images\":[{\"image_id\":\"图片ID\",\"role\":\"target|reference|subject|background|style_reference\"}],\"size\":\"auto\",\"quality\":\"auto\",\"background\":\"auto\",\"format\":\"auto\"}],\"confidence\":0.0,\"evidence\":\"\"}\n\n意图：text_to_image=未指定修改已有图，只生成新图。image_edit_single=明确修改一张图。image_edit_batch=多张图分别做同样修改；每张单独 edit 任务，不要合成。image_compose=多图融合/换主体背景/图一风格改图二；一次 edit 任务传多图并标明 subject/background/style_reference/target。image_reference_gen=参考图片生成新图，不直接改原图；generate 任务，图片角色 reference 或 style_reference。\n\n选图来源优先级：显式引用/引用消息 > 当前上传图片 > 明确编号(第一张/第二张/最后一张) > 最近 assistant 返回图片 > 最近用户上传图片 > 会话相关图片。引用多图消息时：说第一/第二/最后选对应；说这些图/全部/都选全部；只说这张且只有一张选它；只说这张但有多张必须追问；语义明显参考多图或合成多图可选多张。编辑单图目标不明确时不要把多图都传入。\n\n追问：编辑但无可用图片；这张图对应多图且无法确定；第二张但数量不足；目标图和参考图角色不清；缺关键参数会明显错误。需要追问时输出 need_clarification=true、intent=unknown、tasks=[]、mode=chat、target=none。\n\n参数：识别 size/比例(1:1=1024x1024，16:9/横图=1536x1024，9:16/竖图=1024x1536，头像可 auto 或 1024x1024)、quality(高清=high，否则=auto)、background(透明/白底/黑底)、format(png/jpeg/webp)。无法识别用 auto。不要识别或输出生成数量 n。\n\n约束：普通对话/识图提问/总结/翻译/代码/Markdown/图表语法/图片链接示例 => chat+none。生成图片 => image+new。编辑/修改已有图 => edit_image。例如\"修改下图/编辑这张/把这张改成黑白/给上图加水印\"都是 edit_image，不是 image。只能根据 current_input、recent_messages、last_generated_image、latest_uploaded_image、latest_image_reference、recent_image_references、recent_uploaded_image_references、attachments 元数据判断；不要读取或臆测附件内容。selected_reference_id 与 image_id 必须原样保留 imgref_/img_ 前缀。evidence 用一句短中文。mode 必须与 intent 一致：intent 为 text_to_image 时 mode=image；intent 为 image_edit_single/image_edit_batch/image_compose/image_reference_gen 时 mode=edit_image。";

const imageRouteContext = root?.ChatUICoreImageRouteContext
  || root?.ChatUICore?.imageRouteContext
  || root?.window?.ChatUICoreImageRouteContext
  || root?.window?.ChatUICore?.imageRouteContext
  || (typeof require === 'function' ? require('../core/image-route-context') : {});

const UPLOADED_IMAGE_ROUTE_PROMPT = "\n\n上传图修改硬规则（优先级最高）：\n- 用户说\"修改下图/编辑这张/改下图/改这张/把这张图/把刚才的图/把我发的图/把上传的图/把上面那张图\"等任何指向已有图片的短语 + 修改动作 => 必须返回 edit_image。\n- 如果上下文有上传图片引用（latest_uploaded_image 或 recent_uploaded_image_references 不为空）且用户说的是修改类操作，target 必须是 uploaded，不能是 new 或 previous。\n- recent_uploaded_image_references 是用户上传图片的可编辑引用，含用户发图时的提示词和紧随助手识别/描述结果。\n- 用户先发图识别，随后说修改它/修改这张/按刚才识别的图改 => edit_image + uploaded，selected_reference_id 填对应 uploaded 引用如 imgref_uploaded_1。\n- 只有目标明确是助手生成结果图才用 target=previous。\n- 不要把\"修改下图\"误判为 image + new（生成新图）；只要有可编辑的上传图，\"修改/编辑/改\"类动词 + 下图/这张/那个/上传的等指代 = edit_image。";

function stripJsonFence(text = '') {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function parseRouteResult(text = '', normalizeRoute) {
  const value = String(text || '').trim();
  if (!value) return null;
  const normalize = normalizeRoute || imageRouteContext.normalizeRoute;
  if (typeof normalize !== 'function') throw new TypeError('normalizeRoute is required');
  try {
    return normalize(JSON.parse(stripJsonFence(value)));
  } catch { return null; }
}

function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, systemPrompt = ROUTE_SYSTEM_PROMPT } = {}) {
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt + UPLOADED_IMAGE_ROUTE_PROMPT },
      { role: 'user', content: JSON.stringify({ current_input: input, current_mode: currentMode, auto_mode: autoMode, attachments, context }, null, 2) },
    ],
  };
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT,
  UPLOADED_IMAGE_ROUTE_PROMPT,
  stripJsonFence,
  parseRouteResult,
  buildRoutePayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
