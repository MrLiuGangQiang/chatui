(function initChatUIAppScrollFocusWorkflow(root) {
  // Intentionally not strict: scroll/focus bodies are migrated from app.js and resolved through a deps scope.

  function createScrollFocusWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');
    let scrollTimer = null;
    let pointerScrolling = false;
    let pointerScrollTimer = null;
    let sessionTailFocusCleanup = null;

    function cancelScrollTimer() {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }

    function messagesBottomGap() {
      with (deps) {
        const e=$("messages");return e?Math.max(0,e.scrollHeight-e.scrollTop-e.clientHeight):0
      }
    }

    function isNearMessagesBottom(e=180) {
      with (deps) {
        return messagesBottomGap()<=e
      }
    }

    function setMessagesProgrammaticScroll() {
      with (deps) {
        state.programmaticScrollUntil=Date.now()+180
      }
    }

    function getSessionTailAnchor() {
      with (deps) {
        const e=$("messages");if(!e)return null;const t=[...e.querySelectorAll(".message")].filter(e=>e.offsetParent!==null&&e.getBoundingClientRect().height>0);return t[t.length-1]||null
      }
    }

    function ensureTailScrollSpace(e=72) {
      with (deps) {
        const t=$("messages"),s=document.querySelector(".composer")?.getBoundingClientRect();if(!t||!s)return;const n=t.getBoundingClientRect(),i=getComposerSafeBottom(),o=Math.max(0,n.bottom-(s.top-e)),r=Math.max(i,o),l=Math.max(96,Math.min(260,Math.ceil(r)));t.style.setProperty("--session-tail-scroll-space",`${l}px`)
      }
    }

    function focusSessionTail(e={}) {
      with (deps) {
        const t=$("messages");if(!t)return!1;const s=Number.isFinite(e.margin)?e.margin:72;ensureTailScrollSpace(s),setMessagesProgrammaticScroll(),state.userScrollLocked=!1,state.streamFocusLocked=!1,state.autoScrollLocked=!0;const n=getSessionTailAnchor();if(n){pinNodeBottomToTarget(n,{margin:s}),state.lastMessageScrollTop=t.scrollTop,updateResumeStreamButton();const a=n.getBoundingClientRect(),i=document.querySelector(".composer")?.getBoundingClientRect(),o=t.getBoundingClientRect(),r=Math.min(o.bottom,(i?.top||innerHeight)-s);return Math.abs(a.bottom-r)<=(Number.isFinite(e.threshold)?e.threshold:8)}t.scrollTop=Math.max(0,t.scrollHeight-t.clientHeight),state.lastMessageScrollTop=t.scrollTop,updateResumeStreamButton();return messagesBottomGap()<=(Number.isFinite(e.threshold)?e.threshold:8)
      }
    }

    function scheduleSessionTailFocus(e={}) {
      with (deps) {
        const t=Array.isArray(e.settleMs)?e.settleMs:[0,50,150,320],s=++state.scrollVersion;focusSessionTail(e),requestAnimationFrame(()=>{state.scrollVersion===s&&focusSessionTail(e)}),t.forEach(t=>setTimeout(()=>{state.scrollVersion===s&&focusSessionTail(e)},t));return s
      }
    }

    function cancelSessionTailFocusAfterLayout() {
      with (deps) {
        try{sessionTailFocusCleanup?.()}catch{}sessionTailFocusCleanup=null
      }
    }

    function scheduleSessionTailFocusAfterLayout(e={}) {
      with (deps) {
        const t=$("messages");if(!t)return scheduleSessionTailFocus(e);cancelSessionTailFocusAfterLayout();const s=++state.scrollVersion,n=Number.isFinite(e.quietMs)?e.quietMs:160,a=Number.isFinite(e.maxMs)?e.maxMs:2400,i=Number.isFinite(e.stableFrames)?Math.max(1,e.stableFrames):3,q=Date.now(),x=Number.isFinite(e.minWaitMs)?Math.max(0,e.minWaitMs):0;let o=null,r=null,l=null,d=null,c=null,m=!1,h=new WeakSet;if(!1!==e.immediate){focusSessionTail(e),requestAnimationFrame(()=>{state.scrollVersion===s&&!m&&focusSessionTail(e)}),setTimeout(()=>{state.scrollVersion===s&&!m&&focusSessionTail(e)},80)};const u=()=>{const e=document.scrollingElement||document.documentElement;return [t.scrollHeight,t.clientHeight,t.children.length,e?.scrollHeight||0,document.body?.scrollHeight||0,innerHeight||0].join(":")},p=()=>{clearTimeout(o),o=null,clearTimeout(c),c=null,r?.disconnect?.(),l?.disconnect?.(),d&&cancelAnimationFrame(d),d=null,m=!0,sessionTailFocusCleanup=null},g=()=>{if(state.scrollVersion!==s||m)return;if(e.keepPinned){r?.disconnect?.(),l?.disconnect?.();r=new ResizeObserver(()=>{if(!state.autoScrollLocked||state.userScrollLocked)return;const e=$("messages");if(e?.isConnected)e.scrollTop=e.scrollHeight-e.clientHeight});S();l=new MutationObserver(()=>{S()});l.observe(t,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["class","style","src","data-persisted-src","width","height"]});setTimeout(()=>{r?.disconnect?.(),l?.disconnect?.()},Math.max(a,1e4))}else p();if(e.releaseBooting){try{document.body.classList.remove("app-booting")}catch{}}try{e.onDone?.()}catch{}};let f=()=>{if(state.scrollVersion!==s||m)return;setMessagesProgrammaticScroll();focusSessionTail(e);requestAnimationFrame(()=>{state.scrollVersion===s&&!m&&focusSessionTail(e)});setTimeout(()=>{state.scrollVersion===s&&!m&&focusSessionTail(e)},120);setTimeout(g,260)};const w=()=>{if(state.scrollVersion!==s||m)return;let e="",t=0;const n=()=>{if(state.scrollVersion!==s||m)return;const snapshot=u();snapshot===e?t+=1:(e=snapshot,t=1);if(t>=i){const e=q+x-Date.now();if(e>0)return o=setTimeout(w,e);return f()}d=requestAnimationFrame(n)};d=requestAnimationFrame(n)},y=()=>{clearTimeout(o),o=setTimeout(w,n)},S=()=>{if(!r)return;[t,...t.querySelectorAll(".message,.bubble-wrap,.bubble,.content,.reasoning-panel,.markdown-body,img,video,iframe,table,pre,.code-block,.mermaid,.mermaid-block")].forEach(e=>{try{h.has(e)||(h.add(e),r.observe(e))}catch{}})};if("ResizeObserver"in window){r=new ResizeObserver(()=>{if(state.scrollVersion!==s)return;e.pinDuringLayout&&focusSessionTail(e),y()}),S()}if("MutationObserver"in window){l=new MutationObserver(()=>{if(state.scrollVersion!==s)return;S(),e.pinDuringLayout&&focusSessionTail(e),y()}),l.observe(t,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["class","style","src","data-persisted-src","width","height"]})}const b=!!e.finalOnly;if(b){f=()=>{if(state.scrollVersion!==s||m)return;setMessagesProgrammaticScroll();focusSessionTail(e);const a=Number.isFinite(e.postFocusQuietMs)?e.postFocusQuietMs:360;clearTimeout(o),o=setTimeout(()=>{if(state.scrollVersion!==s||m)return;const hasPendingImages=[...t.querySelectorAll("img")].some(e=>!e.complete);if(hasPendingImages)return y();focusSessionTail(e),g()},a)}}const v=[...t.querySelectorAll("img")].filter(e=>!e.complete);v.forEach(e=>{try{e.addEventListener("load",y,{once:!0}),e.addEventListener("error",y,{once:!0})}catch{}});document.fonts?.ready?.then?.(()=>{state.scrollVersion===s&&y()}).catch?.(()=>{});requestAnimationFrame(()=>requestAnimationFrame(y));c=setTimeout(()=>{state.scrollVersion===s&&!m&&f()},b?a:Math.min(a,520));sessionTailFocusCleanup=()=>{clearTimeout(o),clearTimeout(c),r?.disconnect?.(),l?.disconnect?.(),d&&cancelAnimationFrame(d),sessionTailFocusCleanup=null,m=!0};return s
      }
    }

    function updateAutoScrollLock() {
      with (deps) {
        state.streamFocusLocked?state.autoScrollLocked=!0:state.autoScrollLocked=!1
      }
    }

    function shouldFollowScroll() {
      with (deps) {
        return!!state.streamFocusLocked&&!state.userScrollLocked
      }
    }

    function restoreStreamingFollowIfNearBottom(e=180) {
      with (deps) {
        if(!isNearMessagesBottom(e))return!1;state.userScrollLocked=!1,state.autoScrollLocked=!0;const t=getActiveOutputForSession(state.activeSessionId);return t?.isConnected&&"1"===t.dataset.streaming&&(state.streamFocusLocked=!0,state.activeOutputNode=t),updateResumeStreamButton(),!0
      }
    }

    function preserveMessageViewport(e) {
      with (deps) {
        const t=$("messages"),s=e?.isConnected?e.getBoundingClientRect().top:null,n=t?t.scrollTop:null;return()=>{if(!e?.isConnected)return;if(t&&null!==n){const a=e.getBoundingClientRect().top;if(null!==s&&Number.isFinite(a))t.scrollTop+=a-s;else t.scrollTop=n}else if(null!==s){const t=e.getBoundingClientRect().top;Number.isFinite(t)&&window.scrollBy({top:t-s,behavior:"auto"})}updateResumeStreamButton()}
      }
    }

    function preserveMessageBottomAnchor(e,m=72) {
      with (deps) {
        return()=>{shouldFollowScroll()&&pinNodeBottomToTarget(e,{margin:m}),updateResumeStreamButton()}
      }
    }

    function markManualMessageScroll(e) {
      with (deps) {
        const t=$("messages");if(!t)return;if((e?.currentTarget===window||e?.target===window)&&e?.target&&!t.contains(e.target)&&e.target!==document&&e.target!==document.body&&e.target!==document.documentElement)return;const s=e?.type==="wheel"&&Math.abs(Number(e.deltaY||0))>1,n=e?.type==="touchstart"||e?.type==="touchmove",a=e?.type==="pointerdown"||e?.type==="mousedown",i=e?.type==="scroll"&&pointerScrolling,o=e?.type==="scroll"&&Math.abs(t.scrollTop-state.lastMessageScrollTop)>1,r=Date.now()<state.programmaticScrollUntil;if(a){pointerScrolling=!0,clearTimeout(pointerScrollTimer),pointerScrollTimer=setTimeout(()=>{pointerScrolling=!1},1200)}if(s||n||a||!r&&(i||o)){state.streamFocusLocked=!1,state.userScrollLocked=!0,state.autoScrollLocked=!1,state.outputPinSuppressUntil=Date.now()+1500,state.scrollVersion+=1,cancelScrollTimer()}setTimeout(updateResumeStreamButton,0),setTimeout(updateResumeStreamButton,140),state.lastMessageScrollTop=t.scrollTop
      }
    }

    function getComposerSafeBottom() {
      with (deps) {
        const e=getComputedStyle(document.documentElement).getPropertyValue("--composer-safe-bottom"),t=parseFloat(e);return window.ChatUI?.scroll?.composerSafeBottom?window.ChatUI.scroll.composerSafeBottom(e,168):Number.isFinite(t)?t:168
      }
    }

    function scrollToBottom(e=!0,t={}) {
      with (deps) {
        const s=$("messages");if(!s)return;if(!e&&!shouldFollowScroll())return;const n=window.matchMedia("(max-width: 640px)").matches,i=Array.isArray(t.settleMs)?t.settleMs:[n?80:160],o=()=>focusSessionTail({threshold:12});state.autoScrollLocked=!0,state.userScrollLocked=!1;const r=++state.scrollVersion;state.programmaticScrollUntil=Date.now()+180;o(),requestAnimationFrame(()=>{state.scrollVersion===r&&o()}),cancelScrollTimer(),i.forEach((e,t)=>{const s=setTimeout(()=>{state.scrollVersion===r&&o()},e);t===i.length-1&&(scrollTimer=s)})
      }
    }

    function settleScrollToBottom(t={}) {
      with (deps) {
        scrollToBottom(!0,{settleMs:t.settleMs||[50,150]})
      }
    }

    function activeOutputBottomTarget(e=24) {
      with (deps) {
        const t=document.querySelector(".composer")?.getBoundingClientRect();return window.ChatUI?.scroll?.activeOutputBottomTarget?window.ChatUI.scroll.activeOutputBottomTarget({composerTop:t?.top,viewportHeight:innerHeight,margin:e}):Math.max(80,(t?.top||innerHeight)-e)
      }
    }

    function lockToStreamingOutput(e,t={}) {
      with (deps) {
        if(!e?.isConnected)return;state.streamFocusLocked=!0,state.userScrollLocked=!1,state.autoScrollLocked=!0,state.activeOutputNode=e,pinNodeBottomToTarget(e,t)
      }
    }

    function settleActiveOutput(e,t={}) {
      with (deps) {
        if(!e?.isConnected||state.userScrollLocked)return;pinNodeBottomToTarget(e,t),requestAnimationFrame(()=>{!state.userScrollLocked&&pinNodeBottomToTarget(e,t)}),setTimeout(()=>{!state.userScrollLocked&&pinNodeBottomToTarget(e,t)},50),setTimeout(()=>{!state.userScrollLocked&&pinNodeBottomToTarget(e,t)},150)
      }
    }

    function armStreamingOutputFocus(e,t,s={}) {
      with (deps) {
        if(!e||!t)return;const n=Number.isFinite(s.margin)?s.margin:72;s.clearStaleFocus&&(state.streamFocusLocked=!1,state.autoScrollLocked=!1,state.userScrollLocked=!1,state.outputPinSuppressUntil=0,cancelScrollTimer());setActiveOutputForSession(e,t);if(e===state.activeSessionId&&t.isConnected)lockToStreamingOutput(t,{margin:n});else updateResumeStreamButton()
      }
    }

    function pinNodeBottomToTarget(e,t={}) {
      with (deps) {
        if(!e?.isConnected)return;const s=$("messages");if(!s)return;setMessagesProgrammaticScroll();const n=Number.isFinite(t.margin)?t.margin:72,a=activeOutputBottomTarget(n),i=s.getBoundingClientRect(),o=e.getBoundingClientRect(),r=Math.min(i.bottom,a),l=s.scrollHeight>s.clientHeight+1&&getComputedStyle(s).overflowY!=="visible";if(l){if(o.bottom>r+1){s.scrollTop=Math.max(0,Math.min(s.scrollHeight-s.clientHeight,s.scrollTop+(o.bottom-r)))}else if(o.bottom<i.top){s.scrollTop=Math.max(0,s.scrollTop-(i.top-o.bottom+n))}state.lastMessageScrollTop=s.scrollTop}else{const t=o.bottom-r;if(Math.abs(t)>1){const n=window.scrollY||document.documentElement?.scrollTop||document.body?.scrollTop||0;window.scrollTo({top:Math.max(0,n+t),behavior:"auto"})}state.lastMessageScrollTop=s.scrollTop}
      }
    }

    function scrollToActiveOutput(e,t={}) {
      with (deps) {
        const s=$("messages");if(!s||!e?.isConnected)return;t.active&&(state.activeOutputNode=e);if(!1===t.force){updateResumeStreamButton();return}if(!state.userScrollLocked){lockToStreamingOutput(e,t)}updateResumeStreamButton()
      }
    }

    function isNodeAwayFromOutputFocus(e) {
      with (deps) {
        if(!e?.isConnected)return!1;const t=e.getBoundingClientRect(),s=$("messages")?.getBoundingClientRect(),n=document.querySelector(".composer")?.getBoundingClientRect();return window.ChatUI?.scroll?.isNodeAwayFromOutputFocus?window.ChatUI.scroll.isNodeAwayFromOutputFocus({nodeRect:t,messagesRect:s,composerTop:n?.top,viewportHeight:innerHeight,margin:72}):(()=>{const e=(n?.top||innerHeight)-72,a=s?.top||0,i=s?.bottom?Math.min(s.bottom,e):e;return t.bottom>i+72||t.bottom<a+80||t.top>i||t.bottom<a})()
      }
    }

    function setActiveOutputForSession(e,t) {
      with (deps) {
        e&&t&&(t.dataset.sessionId=e),e&&(t?state.activeOutputSessions.set(e,t):state.activeOutputSessions.delete(e)),e===state.activeSessionId&&(state.activeOutputNode=t||null),updateResumeStreamButton()
      }
    }

    function getActiveOutputForSession(e=state.activeSessionId) {
      with (deps) {
        let t=e===state.activeSessionId?state.activeOutputNode:state.activeOutputSessions.get(e)||null;if(t?.isConnected)return t;if(e===state.activeSessionId){const s=[...document.querySelectorAll('.message[data-streaming="1"]')].reverse().find(t=>!t.dataset.sessionId||t.dataset.sessionId===e);s&&(t=s,setActiveOutputForSession(e,s))}return t||null
      }
    }

    function updateResumeStreamButton() {
      with (deps) {
        const e=$("resumeStreamBtn"),t=getActiveOutputForSession(state.activeSessionId);if(!e)return;const n=document.querySelector(".composer")?.getBoundingClientRect();n&&e.style.setProperty("--resume-stream-left",`${n.left+n.width/2}px`);const r=getActiveRun(state.activeSessionId),a=t?.isConnected&&t.closest("#messages")&&t.dataset.sessionId===state.activeSessionId,i=!!(a&&"1"===t.dataset.streaming&&(!t.dataset.streamKind||"chat"===t.dataset.streamKind)&&(!t.dataset.streamRunToken||!r?.token||t.dataset.streamRunToken===r.token)&&state.busySessions.has(state.activeSessionId)),o=Date.now()<state.resumeButtonSuppressUntil,l=i&&isNodeAwayFromOutputFocus(t),s=!!(i&&!o&&(!state.streamFocusLocked||l));e.classList.toggle("show",s),e.setAttribute("aria-hidden",s?"false":"true")
      }
    }

    function resumeActiveOutputFocus() {
      with (deps) {
        const e=getActiveOutputForSession(state.activeSessionId);if(!e?.isConnected)return;state.resumeButtonSuppressUntil=Date.now()+500,state.outputPinSuppressUntil=0,$("resumeStreamBtn")?.classList.remove("show"),$("resumeStreamBtn")?.setAttribute("aria-hidden","true"),lockToStreamingOutput(e,{margin:72});setTimeout(()=>{lockToStreamingOutput(e,{margin:72});updateResumeStreamButton()},80)
      }
    }

    function revealNodeAboveComposer(e,t=18) {
      with (deps) {
        if(!e?.isConnected)return;requestAnimationFrame(()=>{const s=document.querySelector(".composer")?.getBoundingClientRect(),n=e.getBoundingClientRect(),a=(s?.top||innerHeight)-t;if(n.bottom>a)window.scrollBy({top:n.bottom-a,behavior:"auto"})})
      }
    }

    return Object.freeze({ cancelScrollTimer, messagesBottomGap, isNearMessagesBottom, setMessagesProgrammaticScroll, getSessionTailAnchor, ensureTailScrollSpace, focusSessionTail, scheduleSessionTailFocus, cancelSessionTailFocusAfterLayout, scheduleSessionTailFocusAfterLayout, updateAutoScrollLock, shouldFollowScroll, restoreStreamingFollowIfNearBottom, preserveMessageViewport, preserveMessageBottomAnchor, markManualMessageScroll, getComposerSafeBottom, scrollToBottom, settleScrollToBottom, activeOutputBottomTarget, lockToStreamingOutput, settleActiveOutput, armStreamingOutputFocus, pinNodeBottomToTarget, scrollToActiveOutput, isNodeAwayFromOutputFocus, setActiveOutputForSession, getActiveOutputForSession, updateResumeStreamButton, resumeActiveOutputFocus, revealNodeAboveComposer });
  }

  const api = Object.freeze({ createScrollFocusWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppScrollFocusWorkflow = api;
  if (root?.window) root.window.ChatUIAppScrollFocusWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
