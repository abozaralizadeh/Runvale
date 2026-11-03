// Small enhancements only. The page works without them.
(() => {
  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Theme toggle: follows the system until you pick one.
  const toggle = document.querySelector('.theme-toggle');
  toggle?.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch {}
  });

  // Scroll reveals.
  const reveals = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    reveals.forEach((el) => io.observe(el));
  }

  // The dimension line over the demo draws itself and reads the window's real width.
  const stage = document.querySelector('.stage');
  const win = document.querySelector('.window');
  const label = document.querySelector('[data-width]');
  if (stage && win && label) {
    const measure = () => { label.textContent = Math.round(win.getBoundingClientRect().width); };
    measure();
    new ResizeObserver(measure).observe(win);
    requestAnimationFrame(() => stage.classList.add('drawn'));
  }

  // Demo video: load after the page, play only while visible, and light up the legend as it goes.
  const video = document.querySelector('video.demo');
  const items = [...document.querySelectorAll('.legend li')];
  if (video) {
    const start = () => {
      if (video.src) return;
      video.src = video.dataset.src;
      if (reduced) { video.controls = true; return; }
      video.autoplay = true;
      video.play().catch(() => { video.controls = true; });
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { start(); if (!reduced) video.play().catch(() => {}); }
          else if (video.src) video.pause();
        }
      }, { threshold: 0.25 }).observe(video);
    } else {
      window.addEventListener('load', start);
    }
    video.addEventListener('timeupdate', () => {
      const t = video.currentTime;
      let active = -1;
      items.forEach((li, i) => { if (t >= Number(li.dataset.from)) active = i; });
      items.forEach((li, i) => li.classList.toggle('on', i === active));
    });
  }

  // Copy buttons, with a short "Copied" tick.
  document.querySelectorAll('.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.parentElement.querySelector('code').innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied ✓';
      } catch {
        btn.textContent = 'Select it';
      }
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1800);
    });
  });
})();
