(() => {
  const tip = document.getElementById('tip');
  const show = (el, x, y) => {
    const parts = el.dataset.tip.split('|');
    tip.replaceChildren();
    const t = document.createElement('div'); t.className = 't-title'; t.textContent = parts[0]; tip.append(t);
    parts.slice(1).forEach((p, i) => {
      const d = document.createElement('div');
      const [v, l, cls] = p.split('\t');
      if (l !== undefined) {
        d.className = 't-row';
        const k = document.createElement('i'); k.className = 't-key ' + cls; k.style.background = `var(--${cls})`;
        const b = document.createElement('b'); b.textContent = v;
        d.append(k, b, ' ' + l);
      } else {
        d.className = i === 0 ? 't-main' : (p.startsWith('  ') ? 't-row indent' : 't-row');
        d.textContent = p.trim();
      }
      tip.append(d);
    });
    const r = tip.getBoundingClientRect();
    let lx = x + 14, ly = y + 14;
    if (lx + r.width > innerWidth - 8) lx = x - r.width - 14;
    if (ly + r.height > innerHeight - 8) ly = y - r.height - 14;
    tip.style.left = lx + 'px'; tip.style.top = ly + 'px'; tip.style.opacity = 1;
  };
  const hide = () => { tip.style.opacity = 0; };
  document.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('pointermove', ev => show(el, ev.clientX, ev.clientY));
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focus', () => { const b = el.getBoundingClientRect(); show(el, b.right, b.top); });
    el.addEventListener('blur', hide);
  });
  const btn = document.getElementById('theme');
  const modes = ['auto', 'light', 'dark'];
  let m = 0;
  btn.addEventListener('click', () => {
    m = (m + 1) % 3;
    if (modes[m] === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = modes[m];
    btn.textContent = 'Theme: ' + modes[m];
  });
})();
