// frontend/script.js (mis à jour)
// Principales améliorations : Chart.js pour charts avec tooltips, downscale d'images avant stockage, respects prefers-reduced-motion,
// petits ajustements d'accessibilité et robustesse.

(() => {
  /* -------------------------
     Basic data model & storage
     ------------------------- */
  const STORAGE_KEY = 'bf_data_v1';
  const THEME_KEY = 'bf_theme_v1';
  const DEFAULTS = {
    profile: { firstName: 'Aina', lastName: '', currency: 'MGA' },
    settings: { theme: 'violet', language: 'fr', notifications: true },
    transactions: [],
    budgets: [],
    goals: []
  };

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
      return JSON.parse(raw);
    } catch (e) {
      console.error('Failed to load data', e);
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  function saveData() {
    // Save compactly
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  let state = loadData();

  /* -------------------------
     Utilities
     ------------------------- */
  function formatCurrency(v) {
    const cur = state.profile.currency || 'MGA';
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v).replace(/\u00A0/g,' ');
  }

  function uid(prefix='id') {
    return prefix + '_' + Math.random().toString(36).slice(2,9);
  }

  function nowISO() { return new Date().toISOString(); }

  /* -------------------------
     THEMING & PERSONALISATION
     ------------------------- */
  const root = document.documentElement;

  function applyTheme(themeSpec) {
    if (!themeSpec) themeSpec = loadTheme() || {};
    let t = themeSpec.theme || 'violet';
    if (t === 'auto') root.setAttribute('data-theme', 'auto');
    else root.setAttribute('data-theme', t === 'dark' ? 'dark' : t === 'violet' ? 'violet' : 'light');

    if (themeSpec.accent) root.style.setProperty('--accent', themeSpec.accent);

    if (themeSpec.bgDataURL) {
      const val = `url("${themeSpec.bgDataURL}")`;
      root.style.setProperty('--bg-image', val);
      root.style.setProperty('--bg-image-opacity', (themeSpec.opacity ?? 0.12).toString());
      const blur = themeSpec.blur ?? 4;
      const bright = themeSpec.brightness ?? 1;
      root.style.setProperty('--bg-image-filter', `blur(${blur}px) brightness(${bright})`);
    } else {
      root.style.setProperty('--bg-image', 'none');
      root.style.setProperty('--bg-image-opacity', '0');
      root.style.setProperty('--bg-image-filter', 'none');
    }
    saveTheme(themeSpec);
  }

  function saveTheme(ts) { localStorage.setItem(THEME_KEY, JSON.stringify(ts)); }
  function loadTheme() { try { return JSON.parse(localStorage.getItem(THEME_KEY) || 'null'); } catch { return null; } }

  /* -------------------------
     Charts (Chart.js) helpers
     ------------------------- */
  let pieChartInstance = null;
  let lineChartInstance = null;

  function ensureCanvas(containerId) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role','img');
    canvas.setAttribute('aria-label', containerId === 'pieChart' ? 'Dépenses par catégorie' : 'Évolution mensuelle');
    container.appendChild(canvas);
    return canvas;
  }

  function renderPieChart() {
    const data = aggregateByCategory();
    const labels = Object.keys(data);
    const values = Object.values(data);
    const total = values.reduce((s,x)=>s+x,0);
    const canvas = ensureCanvas('pieChart');

    if (pieChartInstance) { pieChartInstance.destroy(); pieChartInstance = null; }

    if (total === 0) {
      canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
      const ctx = canvas.getContext('2d');
      ctx.font = '14px Inter, system-ui, -apple-system';
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#6b7280';
      ctx.fillText('Aucune dépense', 10, 30);
      return;
    }

    const colors = labels.map((_,i)=> pickColor(i));
    pieChartInstance = new Chart(canvas, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, hoverOffset: 6 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = ctx.raw || 0;
                const pct = total ? Math.round((val / total) * 100) : 0;
                return `${ctx.label}: ${formatCurrency(val)} (${pct}%)`;
              }
            }
          },
          legend: { display: false }
        },
        animation: prefersReducedMotion() ? false : { duration: 300 }
      }
    });
  }

  function renderLineChart() {
    const months = aggregateMonths(6);
    const labels = months.map(m=>m.keyLabel);
    const incomeValues = months.map(m=>m.income);
    const expenseValues = months.map(m=>m.expense);
    const canvas = ensureCanvas('lineChart');

    if (lineChartInstance) { lineChartInstance.destroy(); lineChartInstance = null; }

    lineChartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Revenus', data: incomeValues, borderColor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c4dff', backgroundColor: 'transparent', tension: 0.35, pointRadius: 3 },
          { label: 'Dépenses', data: expenseValues, borderColor: '#ff7a7a', backgroundColor: 'transparent', tension: 0.35, pointRadius: 3 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, ticks: { callback: value => formatCurrency(value) } } },
        plugins: { tooltip: { mode: 'index', intersect: false }, legend: { display: true, position: 'bottom' } },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        animation: prefersReducedMotion() ? false : { duration: 350 }
      }
    });
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* -------------------------
     Image downscaling before storing (to avoid huge LocalStorage)
     ------------------------- */
  function downscaleImageFile(file, maxWidth = 1600, maxHeight = 1200, quality = 0.8) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) return reject(new Error('Not an image'));
      const img = new Image();
      const reader = new FileReader();
      reader.onload = (e) => {
        img.onload = () => {
          let { width, height } = img;
          let ratio = Math.min(maxWidth / width, maxHeight / height, 1);
          const w = Math.round(width * ratio);
          const h = Math.round(height * ratio);
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          // Convert to webp if supported to save space
          const mime = navigator.userAgent.includes('Chrome') ? 'image/webp' : file.type;
          const dataURL = canvas.toDataURL(mime, quality);
          resolve(dataURL);
        };
        img.onerror = (err) => reject(err);
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* -------------------------
     RENDERING: pages & components
     ------------------------- */
  function aggregateByCategory() {
    const out = {};
    state.transactions.filter(t=>t.type==='expense').forEach(t => {
      out[t.category] = (out[t.category]||0) + (+t.amount);
    });
    return out;
  }

  function aggregateMonths(limit = 6) {
    const map = {};
    state.transactions.forEach(t => {
      const d = new Date(t.date);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!map[key]) map[key] = { income:0, expense:0, date: new Date(d.getFullYear(), d.getMonth(), 1) };
      map[key][t.type === 'income' ? 'income' : 'expense'] += (+t.amount);
    });
    const keys = Object.keys(map).sort();
    const arr = keys.slice(-limit).map(k => {
      const m = map[k];
      return { key: k, keyLabel: m.date.toLocaleString(undefined, { month:'short', year:'numeric' }), income: m.income, expense: m.expense };
    });
    // ensure length of 'limit'
    const last = arr.length ? arr[arr.length-1].date : new Date();
    while (arr.length < limit) {
      const d = new Date();
      d.setMonth((last.getMonth() - (limit - arr.length - 1)));
      const label = d.toLocaleString(undefined, { month:'short', year:'numeric' });
      arr.unshift({ key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, keyLabel: label, income: 0, expense: 0 });
    }
    return arr;
  }

  function pickColor(i) {
    const palette = ['#7c4dff','#6dd3c2','#ffd166','#ff7aa2','#86a6ff','#a78bfa','#6ee7b7','#ffb86b'];
    return palette[i % palette.length];
  }

  /* -------------------------
     RENDER & wiring (abrégé) — appels aux nouvelles fonctions Chart.js
     ------------------------- */
  function calcTotals() {
    const income = state.transactions.filter(t => t.type === 'income').reduce((s,t)=>s + (+t.amount),0);
    const expense = state.transactions.filter(t => t.type === 'expense').reduce((s,t)=>s + (+t.amount),0);
    const savings = state.goals.reduce((s,g)=>s + (+g.current || 0),0);
    const balance = income - expense;
    return { income, expense, savings, balance };
  }

  // Render functions simplified but intègrent new charts
  function renderDashboard() {
    const totals = calcTotals();
    const elBalance = document.getElementById('balance');
    if (elBalance) elBalance.textContent = formatCurrency(totals.balance);
    const elInc = document.getElementById('summary-income'); if (elInc) elInc.textContent = formatCurrency(totals.income);
    const elExp = document.getElementById('summary-expense'); if (elExp) elExp.textContent = formatCurrency(totals.expense);
    const elSav = document.getElementById('summary-savings'); if (elSav) elSav.textContent = formatCurrency(totals.savings);
    // Recent
    const recent = document.getElementById('recentList'); if (recent) {
      recent.innerHTML = '';
      const last = [...state.transactions].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,6);
      if (last.length === 0) {
        const hint = document.createElement('div'); hint.className='hint'; hint.textContent = 'Aucune transaction — ajoute ta première transaction.'; recent.appendChild(hint);
      } else {
        last.forEach(tx => {
          const li = document.createElement('li'); li.className='tx-item';
          li.innerHTML = `<div><strong>${tx.category}</strong><div class="muted">${tx.description || ''}</div></div>
                          <div style="text-align:right"><div>${formatCurrency(tx.amount)}</div><div class="muted">${new Date(tx.date).toLocaleDateString()}</div></div>`;
          li.style.display='flex'; li.style.justifyContent='space-between'; li.style.padding='8px 0';
          recent.appendChild(li);
        });
      }
    }

    // Charts
    renderPieChart();
    renderLineChart();
    renderGoalsPreview();
  }

  /* -------------------------
     Transactions, budgets, goals — réemploi du code précédent
     (omission pour concision : utiliser les fonctions déjà fournies dans la version initiale)
     ------------------------- */

  /* -------------------------
     AI integration (unchanged except small UX)
     ------------------------- */
  // (réutilise la logique de fetch vers /api/ai mise en place précédemment)

  /* -------------------------
     Image input wiring (downscale)
     ------------------------- */
  const imageInput = document.getElementById('imageInput');
  const chooseImageBtn = document.getElementById('chooseImageBtn');
  const removeImageBtn = document.getElementById('removeImageBtn');
  const bgOpacity = document.getElementById('bgOpacity');
  const bgBlur = document.getElementById('bgBlur');
  const bgBrightness = document.getElementById('bgBrightness');
  const accentColor = document.getElementById('accentColor');
  const previewBox = document.getElementById('previewBox');
  let storedTheme = loadTheme() || { theme: state.settings.theme || 'violet', opacity:0.12, blur:4, brightness:1, accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c4dff' };

  // initialize UI controls (same as before)
  themeSelect && (themeSelect.value = storedTheme.theme || 'violet');
  bgOpacity && (bgOpacity.value = storedTheme.opacity ?? 0.12);
  bgBlur && (bgBlur.value = storedTheme.blur ?? 4);
  bgBrightness && (bgBrightness.value = storedTheme.brightness ?? 1);
  accentColor && (accentColor.value = storedTheme.accent || '#7c4dff');
  applyTheme(storedTheme);

  chooseImageBtn && chooseImageBtn.addEventListener('click', ()=> imageInput.click());
  imageInput && imageInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      // Downscale to reasonable size to avoid LocalStorage bloat
      const dataURL = await downscaleImageFile(f, 1600, 1200, 0.78);
      // check approximate size (base64 length)
      const approxKB = Math.round((dataURL.length * (3/4)) / 1024);
      if (approxKB > 8000) {
        if (!confirm(`L'image est grande (~${Math.round(approxKB/1024)}MB). Continuer et stocker localement ?`)) return;
      }
      storedTheme.bgDataURL = dataURL;
      applyTheme(storedTheme);
      updatePreview();
      flashToast('Image appliquée localement (optimisée)');
    } catch (err) {
      console.error(err);
      alert('Impossible de traiter l’image. Essaie une image plus petite.');
    }
  });

  removeImageBtn && removeImageBtn.addEventListener('click', () => {
    delete storedTheme.bgDataURL;
    applyTheme(storedTheme);
    updatePreview();
  });

  function updatePreview() {
    if (!previewBox) return;
    previewBox.style.background = 'var(--card)';
    if (storedTheme.bgDataURL) {
      previewBox.style.backgroundImage = `url("${storedTheme.bgDataURL}")`;
      previewBox.style.backgroundSize = 'cover';
      previewBox.style.backgroundPosition = 'center';
      previewBox.style.opacity = storedTheme.opacity ?? 0.12;
    } else {
      previewBox.style.backgroundImage = 'none';
    }
  }

  /* -------------------------
     Small helpers + initial render
     ------------------------- */
  function flashToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.position='fixed'; t.style.right='18px'; t.style.bottom='18px'; t.style.background='var(--card)'; t.style.padding='10px 14px';
    t.style.borderRadius='10px'; t.style.boxShadow='var(--shadow)'; t.style.zIndex=9999;
    document.body.appendChild(t);
    setTimeout(()=> t.style.opacity = '0', 2200);
    setTimeout(()=> t.remove(), 3000);
  }

  // Render initial UI (delegue aux fonctions existantes)
  setTimeout(()=>{ try { renderDashboard(); } catch(e){ console.warn(e); } }, 120);

  window.bf = { state, saveData };

})();