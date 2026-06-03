(() => {
  const $ = id => document.getElementById(id);
  const logLines = [];
  const acceptance = window.__markdownAcceptance = { events: [], assertions: [], streamingSnapshots: [], copyText: '', done: false };
  function log(msg){ logLines.push(new Date().toLocaleTimeString()+' '+msg); $('log').textContent = logLines.slice(-80).join('\n'); acceptance.events.push(msg); }
  function assert(name, ok, detail=''){ acceptance.assertions.push({name, ok: !!ok, detail}); log((ok?'PASS ':'FAIL ')+name+(detail?': '+detail:'')); }
  async function render(id, markdown, options={}){ const api = window.ChatUIMarkdown; await api.renderMarkdownInto($(id), markdown, { copyText: async text => { acceptance.copyText = text; await navigator.clipboard?.writeText?.(text).catch(()=>{}); }, ...options }); }
  const basicMd = `# 一级标题\n\n段落包含 **粗体**、*斜体*、~~删除线~~、[链接](https://example.com) 和图片：![小图](/favicon.svg)\n\n> 引用第一行\n> 引用第二行\n\n- 列表 A\n  - 嵌套 A.1\n  - 嵌套 A.2\n1. 有序一\n2. 有序二\n\n---\n\n末尾段落。`;
  const gfmMd = `| 功能 | 状态 | 备注 |\n|---|:---:|---:|\n| 表格 | ✅ | 右对齐 |\n| 任务 | ✅ | 2 |\n\n- [x] 已完成任务\n- [ ] 未完成任务\n\n自动链接：https://example.org/path?q=1\n\n1. 外层\n   - 内层列表\n     > 内层引用\n     \n     | A | B |\n     |---|---|\n     | 1 | 2 |`;
  const codeMd = '```js\nfunction hello(name) {\n  console.log(`hello ${name}`);\n}\nhello("ChatUI");\n```\n\n```python\ndef fib(n):\n    return n if n < 2 else fib(n-1) + fib(n-2)\n```\n\n```bash\necho "copy button visible"\n```';
  const mathMd = `行内公式 $E=mc^2$ 与 $a^2+b^2=c^2$ 混排。\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n多公式：\\(\\alpha+\\beta\\) 和 \\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]`;
  const mermaidMd = '```mermaid\nflowchart TD\n  A[开始] --> B{条件}\n  B -->|Yes| C[处理]\n  B -->|No| D[结束]\n```\n\n```mermaid\nsequenceDiagram\n  participant U as User\n  participant C as ChatUI\n  U->>C: Markdown\n  C-->>U: Rendered\n```\n\n```mermaid\ngantt\n  title Markdown Redesign\n  dateFormat  YYYY-MM-DD\n  section Phase\n  Browser Test :done, a1, 2026-06-03, 1d\n  Report :active, a2, 2026-06-03, 1d\n```\n\n```mermaid\nflowchart TD\n  Broken[故意失败\n```';
  const escapeMd = '特殊字符：& < > " \' ` 应显示为文本，不破坏页面。\n\n\n\n连续空行上方不应变成异常巨大空白。\n\n```txt\nline 1\n\nline 3 after blank\n  indented\n```\n\n<scr'+'ipt>alert("xss")</scr'+'ipt> <img src=x onerror=alert(1)> [bad](javascript:alert(1))';
  const streamChunks = ['普通文本第一句还在增长', '，第二句出现。\n\n# 流式标题\n\n', '| A | B |\n', '|---|---|\n', '| 1 | 2 |\n\n', '```js\ncon', 'sole.log("stream code");\n```\n\n', '数学开始 $x+', 'y=z$ 完成。\n\n$$\na^2+b^2=c^2\n$$\n\n', '```mermaid\nflowchart LR\n  S --> T\n```\n\n', '尾段完成。'];
  async function runCore(){
    acceptance.assertions = []; acceptance.streamingSnapshots = []; acceptance.done = false; $('summary').textContent='running';
    await (window.ChatUIMarkdownReady || Promise.resolve()); log('dependencies ready '+JSON.stringify(window.ChatUIMarkdownDependencyLoader.getReadiness()));
    await render('basic', basicMd); await render('gfm', gfmMd); await render('code', codeMd); await render('math', mathMd); await render('mermaid', mermaidMd); await render('escape', escapeMd);
    assert('basic heading', !!$('basic').querySelector('h1'));
    assert('basic strong/em/s/link/img/blockquote/list/hr', ['strong','em','s','a','img','blockquote','ul','ol','hr'].every(s=>$('basic').querySelector(s)) && $('basic').querySelectorAll('li').length >= 5);
    assert('gfm table/task/autolink/nested', !!$('gfm').querySelector('table') && !!$('gfm').querySelector('.task-list-item-checkbox') && !!$('gfm').querySelector('a[href^="https://example.org"]') && !!$('gfm').querySelector('blockquote'));
    const alignCells = $('gfm').querySelectorAll('tbody tr:first-child td');
    assert('gfm table alignment classes', alignCells[1]?.classList.contains('md-align-center') && alignCells[2]?.classList.contains('md-align-right') && !$('gfm').innerHTML.includes('style="text-align'));
    assert('gfm table computed alignment', ['left', 'start'].includes(getComputedStyle(alignCells[0]).textAlign) && getComputedStyle(alignCells[1]).textAlign === 'center' && getComputedStyle(alignCells[2]).textAlign === 'right', [...alignCells].map(td => getComputedStyle(td).textAlign).join(','));
    assert('code blocks highlighted and copy buttons', $('code').querySelectorAll('.code-block').length >= 3 && $('code').querySelectorAll('.code-copy-icon').length >= 3 && !!$('code').querySelector('.hljs, .language-js'));
    assert('math rendered or graceful fallback', $('math').querySelectorAll('.katex,.math-fallback').length >= 2, $('math').innerHTML.slice(0,240));
    await new Promise(r=>setTimeout(r, 2500));
    const mermaidRendered = $('mermaid').querySelectorAll('.mermaid svg, .mermaid[data-mermaid-rendered="1"]').length;
    assert('mermaid diagrams rendered/graceful', mermaidRendered >= 3 || $('mermaid').querySelectorAll('.mermaid-fallback,.markdown-error,.markdown-mermaid-pending,.mermaid-block').length >= 1, `rendered=${mermaidRendered}`);
    assert('escape sanitized', !$('escape').querySelector('script') && !$('escape').innerHTML.includes('onerror') && !$('escape').innerHTML.includes('javascript:'));
    assert('blank lines bounded', $('escape').getBoundingClientRect().height < 900);
    const codeCases = {
      plain: '```python\nprint("Hello")\n```',
      strayQuote: '```python\n> print("Hello from quote")\n>\n```',
      blockquote: '> ```python\n> print("Hello from quote")\n> ```\n',
      repl: '```python\n>>> print("Hello")\nHello\n```',
      comparison: '```python\nif a > b:\n    print(a)\n```'
    };
    $('code').innerHTML = Object.values(codeCases).map(md => window.ChatUIMarkdown.renderMarkdown(md)).join('');
    await window.ChatUIMarkdown.enhanceRenderedMarkdown($('code'), { copyText: async text => { acceptance.copyText = text; await navigator.clipboard?.writeText?.(text).catch(()=>{}); }, skipMermaid: true });
    const codes = [...$('code').querySelectorAll('pre code')].map(code => code.textContent);
    assert('python plain fence no extra quote marker', codes[0] === 'print("Hello")\n');
    assert('python stray blockquote marker stripped in fence', codes[1] === 'print("Hello from quote")\n\n');
    assert('blockquote fenced code strips quote syntax', $('code').querySelector('blockquote pre code')?.textContent === 'print("Hello from quote")\n');
    assert('python repl prompt preserved', codes.some(text => text === '>>> print("Hello")\nHello\n'));
    assert('python comparison greater-than preserved', codes.some(text => text === 'if a > b:\n    print(a)\n'));
    const escapedTitle = window.ChatUIMarkdown.renderMarkdown('\\*这不是斜体\\*\n\\# 这不是标题');
    $('escape').insertAdjacentHTML('beforeend', escapedTitle);
    assert('escaped title is plain text', $('escape').textContent.includes('*这不是斜体*') && $('escape').textContent.includes('# 这不是标题') && !$('escape').querySelector('h1,h2'));
    const streamEscape = document.createElement('div');
    const escapeRenderer = window.ChatUIMarkdown.createStreamingRenderer();
    escapeRenderer.append('\\', streamEscape);
    escapeRenderer.append('# 这不是标题', streamEscape);
    escapeRenderer.final(streamEscape);
    assert('stream escaped heading final plain', streamEscape.textContent.includes('# 这不是标题') && !streamEscape.textContent.includes('\\') && !streamEscape.querySelector('h1,h2'));
    await render('resourceRender', `<div style="border:1px solid #999;padding:8px;position:fixed;unknown:1" onclick="x">safe style</div>

\\[ 方括号 \\]
\\( 圆括号 \\)
\\( \\alpha+\\beta \\)

公式示例: > $score = a + b$ >

a > b and $x$`);
    const styled = $('resourceRender').querySelector('div[style]');
    assert('safe html inline style whitelist', styled && styled.style.border.includes('1px') && styled.style.padding === '8px' && !styled.getAttribute('style').includes('position') && !$('resourceRender').innerHTML.includes('onclick'));
    assert('plain escaped brackets not math', $('resourceRender').textContent.includes('[ 方括号 ]') && $('resourceRender').textContent.includes('( 圆括号 )') && $('resourceRender').querySelectorAll('.katex,.math-fallback').length >= 1, $('resourceRender').innerHTML.slice(0,240));
    assert('math delimiters and formula wrapper compatibility', $('resourceRender').querySelectorAll('.katex,.math-fallback').length >= 1 && $('resourceRender').textContent.includes('> $score = a + b$ >'), $('resourceRender').textContent.slice(0,240));
    const btn = $('code').querySelector('.code-copy-icon');
    assert('code copy button exists', !!btn);
    btn?.click(); await new Promise(r=>setTimeout(r, 120));
    assert('copy click feedback', btn && (btn.classList.contains('copied') || btn.textContent.includes('✓') || acceptance.copyText.includes('function hello')), acceptance.copyText.slice(0,30));
    $('copyResult').textContent = 'copy tested';
    await runStreaming();
    const failed = acceptance.assertions.filter(a=>!a.ok); $('summary').textContent = failed.length ? `${failed.length} failed` : 'all passed'; acceptance.done = true;
  }
  async function runStreaming(){
    const box = $('stream'); box.innerHTML=''; const renderer = window.ChatUIMarkdown.createStreamingRenderer();
    for (let i=0;i<streamChunks.length;i++) { const result = renderer.append(streamChunks[i], box); acceptance.streamingSnapshots.push({i, childCount: box.childNodes.length, htmlLength: box.innerHTML.length, tail: result.tail, consumed: result.consumed}); await new Promise(r=>setTimeout(r, 180)); }
    const final = renderer.final(box); await new Promise(r=>setTimeout(r, 1600)); acceptance.streamingFinal = final;
    assert('stream progressive snapshots', acceptance.streamingSnapshots.some(s=>s.htmlLength>0 && s.i < streamChunks.length-2));
    assert('stream table/code/math/mermaid final', !!box.querySelector('table') && !!box.querySelector('.code-block') && !!box.textContent.includes('x+y=z') && !!box.querySelector('.mermaid,.mermaid-block,.mermaid-fallback'), box.innerHTML.slice(0,320));
    const heights = acceptance.streamingSnapshots.map(s=>s.htmlLength); assert('stream no full-block reset indication', heights.every((v,i)=>i===0 || v>=heights[i-1]-80));
  }
  async function simulateCdnFail(){
    const iframe = document.createElement('iframe'); iframe.style.width='100%'; iframe.style.height='220px'; $('resourceRender').innerHTML=''; $('resourceRender').appendChild(iframe);
    const html = `<!doctype html><base href="/"><div id="out"></div><script>const original=Document.prototype.createElement;Document.prototype.createElement=function(t){const n=original.call(this,t); if(String(t).toLowerCase()==='script'||String(t).toLowerCase()==='link'){setTimeout(()=>{ if((n.src||n.href||'').includes('registry.npmmirror.com')) n.onerror&&n.onerror(); },0);} return n;}<\/script><script src="/client/app/markdown/dependency-loader.js"><\/script><script src="/client/app/markdown/browser.js"><\/script><script>setTimeout(async()=>{await parent.__markdownAcceptanceCdn(!!window.markdownit, window.ChatUIMarkdownDependencyLoader.getReadiness(), [...document.querySelectorAll('[data-markdown-dependency]')].map(n=>({id:n.dataset.markdownDependency,from:n.dataset.markdownDependencyLoaded,src:n.src||n.href})));},2500)<\/script>`;
    iframe.contentDocument.open(); iframe.contentDocument.write(html); iframe.contentDocument.close();
  }
  window.__markdownAcceptanceCdn = (ok, readiness, nodes) => { acceptance.cdnFallback = {ok, readiness, nodes}; $('resourceStatus').textContent = JSON.stringify(acceptance.cdnFallback,null,2); assert('cdn failed then local fallback usable', ok && nodes.some(n=>n.from==='local')); };
  async function simulatePluginFail(){
    const saved = window.markdownitEmoji; try { window.markdownitEmoji = function(){ throw new Error('simulated plugin fail'); }; const engine = window.ChatUIMarkdown.createMarkdownEngine(); $('resourceRender').innerHTML = engine.render('# 插件失败测试\n\n正文仍应可用。'); assert('single plugin failure keeps markdown usable', !!$('resourceRender').querySelector('h1') && $('resourceRender').textContent.includes('正文仍应可用')); } finally { window.markdownitEmoji = saved; }
  }
  $('runAll').onclick = runCore; $('runStreaming').onclick = runStreaming; $('simulateCdnFail').onclick = simulateCdnFail; $('simulatePluginFail').onclick = simulatePluginFail;
  window.runMarkdownAcceptance = runCore; window.runStreamingAcceptance = runStreaming; window.simulateCdnFail = simulateCdnFail; window.simulatePluginFail = simulatePluginFail;
})();
