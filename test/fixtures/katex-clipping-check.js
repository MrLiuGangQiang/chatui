(() => {
  const cases = [
    {
      title: 'block integral + greek',
      tex: String.raw`\int_0^1 \alpha x^2 + \beta x + \gamma \, dx = \frac{\alpha}{3}+\frac{\beta}{2}+\gamma`,
    },
    {
      title: 'matrix with sum/prod/integral',
      tex: String.raw`A = \begin{pmatrix}\alpha & \beta & \gamma \\ x_1^2 & y_2^2 & z_3^2 \\ \sum_{i=1}^{n} i & \prod_{j=1}^{m} j & \int_{0}^{\infty} e^{-x^2} dx\end{pmatrix}`,
    },
    {
      title: 'cases',
      tex: String.raw`f(x)=\begin{cases}\alpha x^2+\beta, & x < 0 \\ \gamma x + \Delta, & x \ge 0\end{cases}`,
    },
    {
      title: 'aligned multiline',
      tex: String.raw`\begin{aligned}S_n &= \sum_{i=1}^{n} i = \frac{n(n+1)}{2} \\ P_n &= \prod_{i=1}^{n} i \\ I &= \int_{0}^{1} (x^2+x+1)\,dx\end{aligned}`,
    },
    {
      title: 'wide formula scroll',
      tex: String.raw`\sum_{i=1}^{n} \prod_{j=1}^{m} \frac{\alpha_i^2+\beta_j^2+\gamma_{ij}^2}{\sqrt{1+i^2+j^2}} = \int_{0}^{\infty} e^{-x^2} \, dx + \int_{0}^{1} \frac{1}{1+x^2} \, dx + \sum_{k=1}^{p} \frac{\Delta_k}{1+k^2} + \sum_{r=1}^{q} \frac{\Omega_r^2+\theta_r^2+\lambda_r^2}{1+r^2} + \prod_{s=1}^{t} \frac{1+\mu_s}{1+\nu_s}`, 
    },
  ];

  function render() {
    const root = document.getElementById('mathRoot');
    root.innerHTML = '<p>行内公式 <span id="inlineMath"></span> 不应影响普通布局。</p>';
    katex.render(String.raw`\alpha + \beta + \gamma + \Delta`, document.getElementById('inlineMath'), { throwOnError: false });
    for (const item of cases) {
      const label = document.createElement('div');
      label.className = 'case-label';
      label.textContent = item.title;
      const display = document.createElement('span');
      display.className = 'katex-display probe';
      const inner = document.createElement('span');
      display.appendChild(inner);
      root.append(label, display);
      katex.render(item.tex, inner, { displayMode: false, throwOnError: false });
    }
  }

  function collect(){
    const root = document.getElementById('mathRoot');
    const bubble = root.closest('.bubble');
    const message = root.closest('.message');
    const displays = [...root.querySelectorAll('.katex-display')];
    const rows = displays.map((el, i) => {
      const cs = getComputedStyle(el);
      const kr = el.querySelector('.katex').getBoundingClientRect();
      const er = el.getBoundingClientRect();
      return {
        index:i,
        title:cases[i]?.title,
        overflowX:cs.overflowX,
        overflowY:cs.overflowY,
        paddingTop:parseFloat(cs.paddingTop),
        paddingBottom:parseFloat(cs.paddingBottom),
        scrolls:el.scrollWidth > el.clientWidth + 1,
        topClearance:kr.top-er.top,
        bottomClearance:er.bottom-kr.bottom,
        displayHeight:er.height,
        katexHeight:kr.height,
      };
    });
    const ok = rows.length === cases.length
      && rows.every(r => r.overflowX === 'auto' && r.paddingTop >= 8 && r.paddingBottom >= 8 && r.topClearance >= 0 && r.bottomClearance >= 0)
      && rows[rows.length - 1]?.scrolls;
    const result = {
      ok,
      messageOverflowX:getComputedStyle(message).overflowX,
      bubbleOverflowX:getComputedStyle(bubble).overflowX,
      bubbleOverflowY:getComputedStyle(bubble).overflowY,
      contentOverflowY:getComputedStyle(root).overflowY,
      rows,
    };
    window.__katexClippingResult = result;
    document.getElementById('report').textContent = JSON.stringify(result, null, 2);
    return result;
  }

  window.addEventListener('load', () => {
    render();
    requestAnimationFrame(collect);
  });
})();
