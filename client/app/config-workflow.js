(function initChatUIAppConfigWorkflow(root) {
  'use strict';

  const DEFAULT_BASE_URL = 'https://ingress.lfans.cn/v1';
  const defaults = Object.freeze({ baseUrl: DEFAULT_BASE_URL, apiKey: '', chatModel: '', routeModel: '', imageModel: '', imageSize: 'auto', systemPrompt: '', imageStylePrompt: '', models: [], context: {}, editingIndex: null, editingNode: null, attachments: [] });

  function createConfigWorkflow(deps = {}) {
    const { state, getElement, localStorage, document, window, setTimeout, renderModelOptions, updateCustomSelect, enhanceConfigSelects, closeAllCustomSelects, saveSessionsMeta, toast } = deps;
    const CONFIG_KEY = deps.CONFIG_KEY;
    const API_KEY_STORAGE_KEY = `${CONFIG_KEY}:api-key`;
    const sessionStorage = deps.sessionStorage || window?.sessionStorage;
    const isSessionBusy = deps.isSessionBusy || (() => false);
    let backupControlsBound = false;

    function readJsonStorage(e,t){try{const s=localStorage.getItem(e);return s?JSON.parse(s):t}catch{try{localStorage.removeItem(e)}catch{}return t}}

    function normalizeModelMeta(e,t={}){const s={};return(Array.isArray(e)?e:[]).forEach(e=>{const n=t?.[e]||{};s[e]={id:e,type:String(n.type||"").trim(),unrecognized:!0===n.unrecognized||!String(n.type||"").trim(),inferred:!0===n.inferred}}),s}

    function setApiKeyVisible(e){const t=getElement("apiKey"),s=getElement("toggleApiKeyVisibility");t&&s&&(t.type=e?"text":"password",s.classList.toggle("visible",e),s.classList.toggle("showing",e),s.setAttribute("aria-label",e?"隐藏 API Key":"显示 API Key"),s.setAttribute("aria-pressed",e?"true":"false"))}

    function toggleApiKeyVisibility(){const e=getElement("apiKey");e&&(setApiKeyVisible("password"===e.type),e.focus())}

    async function copyConfigField(e){const t=getElement(e),s=String(t?.value||"").trim();if(!s)return toast?.("暂无可复制内容");try{if(window?.ChatUI?.actions?.copyText)await window.ChatUI.actions.copyText(s,window.navigator?.clipboard,document);else if(window?.navigator?.clipboard?.writeText)await window.navigator.clipboard.writeText(s);else{const e=document.createElement("textarea");e.value=s,e.setAttribute("readonly",""),e.style.position="fixed",e.style.opacity="0",document.body.appendChild(e),e.select(),document.execCommand("copy"),e.remove()}toast?.("已复制")}catch(e){toast?.("复制失败，请手动复制")}}

    function readPersistedApiKey(){try{return String(localStorage?.getItem(API_KEY_STORAGE_KEY)||"").trim()}catch{return""}}

    function readLegacySessionApiKey(){try{return String(sessionStorage?.getItem(API_KEY_STORAGE_KEY)||"").trim()}catch{return""}}

    function writePersistedApiKey(e=""){try{const t=String(e||"").trim();t?localStorage?.setItem(API_KEY_STORAGE_KEY,t):localStorage?.removeItem(API_KEY_STORAGE_KEY)}catch{}}

    async function loadPublicContext(){try{const e=await window?.fetch?.("/api/config/public");if(!e?.ok)return;const t=await e.json(),s=t?.config?.context;if(s&&"object"==typeof s&&!Array.isArray(s))state.publicContext={...s}}catch{}}

    function loadConfig(){
      const stored=readJsonStorage(CONFIG_KEY,readJsonStorage("openapi-chat-image-config",{}));
      const legacyApiKey=String(stored.apiKey||"");
      const persistedApiKey=readPersistedApiKey()||readLegacySessionApiKey();
      if(legacyApiKey)delete stored.apiKey;
      const config={...defaults,...stored,apiKey:persistedApiKey||legacyApiKey};
      if(config.apiKey&&!readPersistedApiKey())writePersistedApiKey(config.apiKey);
      const baseEl=getElement("baseUrl"),apiEl=getElement("apiKey"),sizeEl=getElement("imageSize"),systemEl=getElement("systemPrompt"),styleEl=getElement("imageStylePrompt");
      if(baseEl){baseEl.value=config.baseUrl||defaults.baseUrl;baseEl.readOnly=!1}
      if(apiEl)apiEl.value=config.apiKey||"";
      if(sizeEl){sizeEl.value=config.imageSize||defaults.imageSize;updateCustomSelect(sizeEl)}
      if(systemEl)systemEl.value=config.systemPrompt||"";
      if(styleEl)styleEl.value=config.imageStylePrompt||"";
      state.models=Array.isArray(config.models)?config.models:[];
      state.modelMeta=normalizeModelMeta(state.models,config.modelMeta||{});
      const availableModels=new Set(state.models),chatModel=availableModels.has(config.chatModel)?config.chatModel:"",routeModel=availableModels.has(config.routeModel)?config.routeModel:"",imageModel=availableModels.has(config.imageModel)?config.imageModel:"";
      renderModelOptions(chatModel,imageModel,routeModel);
      if(legacyApiKey||config.chatModel!==chatModel||config.routeModel!==routeModel||config.imageModel!==imageModel)saveConfig(!0);
      void loadPublicContext()
    }

    function getConfig(){
      const stored=readJsonStorage(CONFIG_KEY,{}),baseEl=getElement("baseUrl"),apiEl=getElement("apiKey"),chatEl=getElement("chatModel"),routeEl=getElement("routeModel"),imageEl=getElement("imageModel"),sizeEl=getElement("imageSize"),systemEl=getElement("systemPrompt"),styleEl=getElement("imageStylePrompt");
      const storedModels=Array.isArray(stored.models)?stored.models:[],models=Array.isArray(state.models)&&state.models.length?state.models:storedModels,context=state.publicContext&&"object"==typeof state.publicContext?state.publicContext:stored.context&&"object"==typeof stored.context?stored.context:{};
      return{
        baseUrl:(baseEl?.value.trim()||DEFAULT_BASE_URL).replace(/\/+$/, ""),
        apiKey:String(apiEl?apiEl.value:readPersistedApiKey()||"").trim(),
        chatModel:String(chatEl?chatEl.value:stored.chatModel||"").trim(),
        routeModel:String(routeEl?routeEl.value:stored.routeModel||"").trim(),
        imageModel:String(imageEl?imageEl.value:stored.imageModel||"").trim(),
        imageSize:String(sizeEl?sizeEl.value:stored.imageSize||defaults.imageSize).trim()||defaults.imageSize,
        systemPrompt:String(systemEl?systemEl.value:stored.systemPrompt||"").trim(),
        imageStylePrompt:String(styleEl?styleEl.value:stored.imageStylePrompt||"").trim(),
        models,
        context,
      }
    }

    function cleanupLegacyConfigCache(){localStorage.removeItem("openapi-chat-image-config"),localStorage.removeItem("openapi-chat-image-config-v1")}

    function hasBusySession(){return(state.sessions||[]).some(session=>isSessionBusy(session.id))}

    function restoreSavedRoutingModels(saved={}){for(const id of ["chatModel","routeModel"]){const element=getElement(id);if(!element)continue;element.value=String(saved[id]||"");updateCustomSelect(element)}}

    function saveConfig(e=!1){
      cleanupLegacyConfigCache();
      const previous=readJsonStorage(CONFIG_KEY,{}),config=getConfig(),routingModelChanged=String(previous.chatModel||"").trim()!==config.chatModel||String(previous.routeModel||"").trim()!==config.routeModel;
      if(routingModelChanged&&hasBusySession()){
        restoreSavedRoutingModels(previous);
        toast?.("\u4efb\u52a1\u8fdb\u884c\u4e2d\uff0c\u8bf7\u505c\u6b62\u6216\u7b49\u5f85\u6240\u6709\u4efb\u52a1\u5b8c\u6210\u540e\u518d\u5207\u6362\u804a\u5929\u6216\u610f\u56fe\u8bc6\u522b\u6a21\u578b");
        return!1
      }
      writePersistedApiKey(config.apiKey);
      localStorage.setItem(CONFIG_KEY,JSON.stringify({
        baseUrl:config.baseUrl,
        chatModel:config.chatModel,
        routeModel:config.routeModel,
        imageModel:config.imageModel,
        imageSize:config.imageSize,
        systemPrompt:config.systemPrompt,
        imageStylePrompt:config.imageStylePrompt,
        models:Array.isArray(state.models)?state.models:[],
        modelMeta:state.modelMeta||{},
      }));
      if(!e)closeConfigModal();
      return!0
    }

    function openConfigModal(){document.body.classList.add("modal-open"),getElement("configModal").classList.add("show"),getElement("configModal").setAttribute("aria-hidden","false"),window.setTimeout.call(window,()=>getElement("apiKey")?.focus(),0)}

    function closeConfigModal(){const e=getElement("configModal"),t=document?.activeElement;if(t&&e?.contains?.(t)){const e=getElement("sidebarConfigBtn")||getElement("railConfigBtn")||getElement("prompt");e&&!e.disabled?e.focus?.({preventScroll:!0}):t.blur?.()}document.body.classList.remove("modal-open"),e?.classList.remove("show"),e?.setAttribute("aria-hidden","true")}

    function bindBackupControls(){
      if(backupControlsBound)return;
      const backupApi=root?.ChatUIApp?.appContext?.getWorkflowModule?.("backup");
      const exportButton=getElement("exportBackupBtn"),fileInput=getElement("importBackupFile"),status=getElement("backupTransferStatus");
      if(!backupApi?.createBackupWorkflow||!exportButton||!fileInput||typeof root?.getSessionDisplayWorkflow!=="function")return;
      backupControlsBound=true;
      const commitSession=session=>root.getSessionDisplayWorkflow().commitSession(session);
      const backup=backupApi.createBackupWorkflow({state,localStorage,document,window,CONFIG_KEY,isSessionBusy,clearSessionSnapshots:root.clearSessionSnapshots,commitSession,flushSessionSnapshots:root.flushSessionSnapshots,collectIndexedDbKeys:root.collectIndexedDbKeys,getImageBlob:root.getImageBlob,putImageBlob:root.putImageBlob,clearImageDb:root.clearImageDb,dataUrlToBlob:root.dataUrlToBlob,saveSessionsMeta,toast});
      const showStatus=(message,type="")=>{if(status){status.textContent=message;status.dataset.status=type}else toast?.(message)};
      const reportError=error=>{const message=error?.message||"备份操作失败，请重试";showStatus(message,"error");toast?.(message)};
      exportButton.addEventListener("click",()=>{showStatus("正在生成备份…","pending");return Promise.resolve(backup.downloadBackup()).then(archive=>{const count=Number(archive?.media?.length)||0;showStatus(count?`备份已导出，包含 ${count} 个附件或图片`:"备份已导出，请妥善保管文件","success")}).catch(reportError)});
      fileInput.addEventListener("change",async event=>{try{showStatus("正在读取备份…","pending");const restored=await backup.importBackupFile(event.target?.files?.[0]);if(!restored)showStatus("已取消导入","neutral")}catch(error){reportError(error)}finally{event.target.value=""}});
    }

    setTimeout?.(bindBackupControls,0);

    return Object.freeze({ readJsonStorage, normalizeModelMeta, setApiKeyVisible, toggleApiKeyVisibility, copyConfigField, readPersistedApiKey, writePersistedApiKey, loadPublicContext, loadConfig, getConfig, cleanupLegacyConfigCache, saveConfig, openConfigModal, closeConfigModal });
  }

  const api = Object.freeze({ createConfigWorkflow, defaults, DEFAULT_BASE_URL });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppConfigWorkflow = api;
  if (root?.window) root.window.ChatUIAppConfigWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
