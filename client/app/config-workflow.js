(function initChatUIAppConfigWorkflow(root) {
  'use strict';

  const DEFAULT_BASE_URL = 'https://ingress.lfans.cn/v1';
  const defaults = Object.freeze({ baseUrl: DEFAULT_BASE_URL, apiKey: '', headerParams: [], chatModel: '', routeModel: '', imageModel: '', imageSize: 'auto', systemPrompt: '', imageStylePrompt: '', directMode: false, models: [], context: {}, editingIndex: null, editingNode: null, attachments: [] });

  function createConfigWorkflow(deps = {}) {
    const { state, getElement, localStorage, document, window, crypto, setTimeout, renderModelOptions, updateCustomSelect, enhanceConfigSelects, closeAllCustomSelects, getActiveSession, saveSessionsMeta, toast } = deps;
    const CONFIG_KEY = deps.CONFIG_KEY;
    const API_KEY_STORAGE_KEY = `${CONFIG_KEY}:api-key`;
    const sessionStorage = deps.sessionStorage || window?.sessionStorage;

    function readJsonStorage(e,t){try{const s=localStorage.getItem(e);return s?JSON.parse(s):t}catch{try{localStorage.removeItem(e)}catch{}return t}}

    function normalizeModelMeta(e,t={}){const s={};return(Array.isArray(e)?e:[]).forEach(e=>{const n=t?.[e]||{};s[e]={id:e,type:String(n.type||"").trim(),unrecognized:!0===n.unrecognized||!String(n.type||"").trim()}}),s}

    function setApiKeyVisible(e){const t=getElement("apiKey"),s=getElement("toggleApiKeyVisibility");t&&s&&(t.type=e?"text":"password",s.classList.toggle("visible",e),s.classList.toggle("showing",e),s.setAttribute("aria-label",e?"隐藏 API Key":"显示 API Key"),s.setAttribute("aria-pressed",e?"true":"false"))}

    function toggleApiKeyVisibility(){const e=getElement("apiKey");e&&(setApiKeyVisible("password"===e.type),e.focus())}

    async function copyConfigField(e){const t=getElement(e),s=String(t?.value||"").trim();if(!s)return toast?.("暂无可复制内容");try{if(window?.ChatUI?.actions?.copyText)await window.ChatUI.actions.copyText(s,window.navigator?.clipboard,document);else if(window?.navigator?.clipboard?.writeText)await window.navigator.clipboard.writeText(s);else{const e=document.createElement("textarea");e.value=s,e.setAttribute("readonly",""),e.style.position="fixed",e.style.opacity="0",document.body.appendChild(e),e.select(),document.execCommand("copy"),e.remove()}toast?.("已复制")}catch(e){toast?.("复制失败，请手动复制")}}

    function readPersistedApiKey(){try{return String(localStorage?.getItem(API_KEY_STORAGE_KEY)||"").trim()}catch{return""}}

    function readLegacySessionApiKey(){try{return String(sessionStorage?.getItem(API_KEY_STORAGE_KEY)||"").trim()}catch{return""}}

    function writePersistedApiKey(e=""){try{const t=String(e||"").trim();t?localStorage?.setItem(API_KEY_STORAGE_KEY,t):localStorage?.removeItem(API_KEY_STORAGE_KEY)}catch{}}

    async function loadPublicContext(){try{const e=await window?.fetch?.("/api/config/public");if(!e?.ok)return;const t=await e.json(),s=t?.config?.context;if(s&&"object"==typeof s&&!Array.isArray(s))state.publicContext={...s}}catch{}}

    function loadConfig(){const e=readJsonStorage(CONFIG_KEY,readJsonStorage("openapi-chat-image-config",{})),legacyApiKey=String(e.apiKey||""),persistedApiKey=readPersistedApiKey()||readLegacySessionApiKey();legacyApiKey&&delete e.apiKey;const t={...defaults,...e,apiKey:persistedApiKey||legacyApiKey};t.apiKey&&!readPersistedApiKey()&&writePersistedApiKey(t.apiKey);getElement("baseUrl").value=t.baseUrl||defaults.baseUrl,getElement("baseUrl").readOnly=!1,getElement("apiKey").value=t.apiKey||"",getElement("imageSize").value=t.imageSize||defaults.imageSize,updateCustomSelect(getElement("imageSize")),getElement("systemPrompt").value=t.systemPrompt||"",getElement("imageStylePrompt")&&(getElement("imageStylePrompt").value=t.imageStylePrompt||""),state.models=Array.isArray(t.models)?t.models:[],state.modelMeta=normalizeModelMeta(state.models,t.modelMeta||{});const n=new Set(state.models),a=n.has(t.chatModel)?t.chatModel:"",i=n.has(t.routeModel)?t.routeModel:"",o=n.has(t.imageModel)?t.imageModel:"";renderModelOptions(a,o,i),(legacyApiKey||t.chatModel!==a||t.routeModel!==i||t.imageModel!==o)&&saveConfig(!0),void loadPublicContext()}

    function getConfig(){const e=readJsonStorage(CONFIG_KEY,{}),baseEl=getElement("baseUrl"),apiEl=getElement("apiKey"),chatEl=getElement("chatModel"),routeEl=getElement("routeModel"),imageEl=getElement("imageModel"),sizeEl=getElement("imageSize"),systemEl=getElement("systemPrompt"),styleEl=getElement("imageStylePrompt");const storedModels=Array.isArray(e.models)?e.models:[],models=Array.isArray(state.models)&&state.models.length?state.models:storedModels,context=state.publicContext&&"object"==typeof state.publicContext?state.publicContext:e.context&&"object"==typeof e.context?e.context:{};return{baseUrl:(baseEl?.value.trim()||DEFAULT_BASE_URL).replace(/\/+$/, ""),apiKey:String(apiEl?.value||readPersistedApiKey()||"").trim(),headerParams:normalizeHeaderParamConfig(e.headerParams),chatModel:String(chatEl?.value||e.chatModel||"").trim(),routeModel:String(routeEl?.value||e.routeModel||"").trim(),imageModel:String(imageEl?.value||e.imageModel||"").trim(),imageSize:sizeEl?.value||e.imageSize||defaults.imageSize,systemPrompt:String(systemEl?.value||e.systemPrompt||"").trim(),imageStylePrompt:String(styleEl?.value||e.imageStylePrompt||"").trim(),directMode:!!e.directMode,models,context}}

    function normalizeHeaderParamConfig(e=[]){return(Array.isArray(e)?e:[]).map(e=>({name:String(e?.name||"").trim(),mode:["manual","session_short_uuid","message_short_uuid"].includes(e?.mode)?e.mode:"manual",value:String(e?.value||"")})).filter(e=>e.name)}

    function generateShortUuid(){try{const e=new Uint8Array(8);crypto.getRandomValues(e);return[...e].map(e=>e.toString(16).padStart(2,"0")).join("").slice(0,12)}catch{return`${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`.slice(0,12)}}

    function ensureSessionHeaderValues(e=state.activeSessionId){const t=state.sessions.find(t=>t.id===e)||getActiveSession();return t.headerValues&&"object"==typeof t.headerValues||(t.headerValues={}),t}

    function buildRequestHeaders(e="message",t=state.activeSessionId){const s=normalizeHeaderParamConfig(getConfig().headerParams),n=ensureSessionHeaderValues(t);const a={};let i=!1;for(const o of s){let s="";"manual"===o.mode?s=o.value:"session_short_uuid"===o.mode?(n.headerValues[o.name]||(n.headerValues[o.name]=generateShortUuid(),i=!0),s=n.headerValues[o.name]):"message_short_uuid"===o.mode&&(s=generateShortUuid()),o.name&&s&&(a[o.name]=s)}return i&&saveSessionsMeta(),a}

    function cleanupLegacyConfigCache(){localStorage.removeItem("openapi-chat-image-config"),localStorage.removeItem("openapi-chat-image-config-v1")}

    function saveConfig(e=!1){cleanupLegacyConfigCache();const t=getConfig();writePersistedApiKey(t.apiKey),localStorage.setItem(CONFIG_KEY,JSON.stringify({baseUrl:t.baseUrl,headerParams:normalizeHeaderParamConfig(t.headerParams),chatModel:t.chatModel,routeModel:t.routeModel,imageModel:t.imageModel,imageSize:t.imageSize,systemPrompt:t.systemPrompt,imageStylePrompt:t.imageStylePrompt,directMode:!!t.directMode,models:Array.isArray(state.models)?state.models:[],modelMeta:state.modelMeta||{}})),e||closeConfigModal()}

    function openConfigModal(){document.body.classList.add("modal-open"),getElement("configModal").classList.add("show"),getElement("configModal").setAttribute("aria-hidden","false"),window.setTimeout.call(window,()=>getElement("apiKey")?.focus(),0)}

    function closeConfigModal(){document.body.classList.remove("modal-open"),getElement("configModal").classList.remove("show"),getElement("configModal").setAttribute("aria-hidden","true")}

    return Object.freeze({ readJsonStorage, normalizeModelMeta, setApiKeyVisible, toggleApiKeyVisibility, copyConfigField, readPersistedApiKey, writePersistedApiKey, loadPublicContext, loadConfig, getConfig, normalizeHeaderParamConfig, generateShortUuid, ensureSessionHeaderValues, buildRequestHeaders, cleanupLegacyConfigCache, saveConfig, openConfigModal, closeConfigModal });
  }

  const api = Object.freeze({ createConfigWorkflow, defaults, DEFAULT_BASE_URL });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppConfigWorkflow = api;
  if (root?.window) root.window.ChatUIAppConfigWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
