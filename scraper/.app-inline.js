
(() => {
  const STORE_COLORS = {
    spool: '#7c5cff', bits4bots: '#00a884', '3dea': '#568eff',
    mindkits: '#e84393', marvle3d: '#e17055', jaycar: '#f0a500'
  };
  const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#151b24"/>' +
    '<text x="200" y="150" font-size="64" text-anchor="middle" dominant-baseline="middle">🧵</text></svg>');

  const state = {
    q: '', materials: new Set(), colours: new Set(), finishes: new Set(), formats: new Set(),
    brands: new Set(), stores: new Set(),
    sale: false, stock: false, sort: 'perkg'
  };
  let DATA = [];
  let META = null;

  const $ = (s) => document.querySelector(s);
  const ESC_MAP = { '&': '&' + 'amp;', '<': '&' + 'lt;', '>': '&' + 'gt;', '"': '&' + 'quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const fmt = (n) => '$' + Number(n).toFixed(2);

  /* ---------- data ---------- */
  async function load() {
    try {
      const res = await fetch('data/products.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      DATA = json.products || [];
      META = { generatedAt: json.generatedAt };
    } catch (err) {
      $('#resultCount').textContent = 'Could not load data';
      $('#dataMeta').textContent = 'data/products.json is missing — run the scraper first (see README).';
      return;
    }
    try {
      const m = await fetch('data/meta.json', { cache: 'no-cache' });
      if (m.ok) META = await m.json();
    } catch (_) { /* meta is optional */ }
    buildFacets();
    renderStoreStatus();
    render();
  }

  /* ---------- filtering ---------- */
  function matches(p, ignoreFacet) {
    if (state.q) {
      const tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.every((t) => p.searchText.includes(t))) return false;
    }
    if (ignoreFacet !== 'materials' && state.materials.size && !state.materials.has(p.material)) return false;
    if (ignoreFacet !== 'colours' && state.colours.size && !state.colours.has(p.colour)) return false;
    if (ignoreFacet !== 'finishes' && state.finishes.size && !state.finishes.has(p.finish)) return false;
    if (ignoreFacet !== 'formats' && state.formats.size && !state.formats.has(p.format)) return false;
    if (ignoreFacet !== 'brands' && state.brands.size && !state.brands.has(p.brand)) return false;
    if (ignoreFacet !== 'stores' && state.stores.size && !state.stores.has(p.store)) return false;
    if (state.sale && !p.wasPrice) return false;
    if (state.stock && p.inStock === false) return false;
    return true;
  }

  function sortProducts(list) {
    const by = {
      perkg: (a, b) => (a.pricePerKg ?? Infinity) - (b.pricePerKg ?? Infinity) || a.price - b.price,
      price: (a, b) => a.price - b.price,
      pricedesc: (a, b) => b.price - a.price,
      discount: (a, b) => disc(b) - disc(a),
      name: (a, b) => a.name.localeCompare(b.name),
    }[state.sort] || (() => 0);
    return list.sort(by);
    function disc(p) { return p.wasPrice ? 1 - p.price / p.wasPrice : 0; }
  }

  /* ---------- facets ---------- */
  const FACETS = [
    { key: 'materials', el: '#facetMaterial ul', get: (p) => p.material },
    { key: 'colours', el: '#facetColour ul', get: (p) => p.colour, colour: true },
    { key: 'finishes', el: '#facetFinish ul', get: (p) => p.finish },
    { key: 'formats', el: '#facetFormat ul', get: (p) => p.format },
    { key: 'brands', el: '#facetBrand ul', get: (p) => p.brand || 'Unknown' },
    { key: 'stores', el: '#facetStore ul', get: (p) => p.storeName, storeKey: (p) => p.store },
  ];

  function buildFacets() {
    for (const f of FACETS) {
      const counts = new Map();
      for (const p of DATA) {
        if (!matches(p, f.key)) continue;
        const v = f.get(p);
        if (v == null || v === '') continue;
        counts.set(v, (counts.get(v) || 0) + 1);
      }
      const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const ul = $(f.el);
      ul.innerHTML = entries.map(([value, count]) => {
        const sel = state[f.key].has(value) || (f.storeKey && [...state.stores].some((sk) => storeNameOf(sk) === value));
        let swatch = '';
        if (f.colour) {
          const hex = DATA.find((p) => p.colour === value)?.colourHex;
          swatch = `<span class="dot" style="background:${hex || 'conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'}"></span>`;
        }
        return `<li data-facet="${f.key}" data-value="${esc(value)}" class="${sel ? 'sel' : ''}">
          <span class="check"></span>${swatch}<span>${esc(value)}</span><span class="count">${count}</span></li>`;
      }).join('');
    }
  }

  function storeNameOf(key) {
    return META?.stores?.[key]?.name || key;
  }

  document.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-facet]');
    if (!li) return;
    const { facet, value } = li.dataset;
    const set = state[facet];
    if (facet === 'stores') {
      // values shown are storeName; find key
      const key = Object.keys(META?.stores || {}).find((k) => storeNameOf(k) === value) ||
        (DATA.find((p) => p.storeName === value)?.store) || value;
      set.has(key) ? set.delete(key) : set.add(key);
    } else {
      set.has(value) ? set.delete(value) : set.add(value);
    }
    buildFacets();
    render();
    syncHash();
  });

  /* ---------- render ---------- */
  function render() {
    const list = sortProducts(DATA.filter((p) => matches(p)));
    $('#resultCount').textContent = `${list.length} result${list.length === 1 ? '' : 's'}`;
    $('#empty').hidden = list.length > 0;

    const html = list.slice(0, 600).map((p) => {
      const discount = p.wasPrice ? Math.round((1 - p.price / p.wasPrice) * 100) : 0;
      const storeColor = STORE_COLORS[p.store] || '#6e7681';
      const dot = p.colourHex || 'conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)';
      const oos = p.inStock === false;
      return `<article class="card ${oos ? 'oos' : ''}">
        <a class="imgwrap" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">
          <img src="${esc(p.image || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${PLACEHOLDER}'">
          <span class="badges">
            ${discount ? `<span class="badge sale">-${discount}%</span>` : ''}
            ${oos ? `<span class="badge oos">Out of stock</span>` : ''}
          </span>
        </a>
        <div class="body">
          <div class="pname"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a></div>
          <div class="tags">
            <span class="tag">${esc(p.material)}</span>
            <span class="tag"><span class="dot" style="background:${dot}"></span>${esc(p.colour)}</span>
            ${p.finish ? `<span class="tag">${esc(p.finish)}</span>` : ''}
            ${p.format ? `<span class="tag">${esc(p.format)}</span>` : ''}
            ${p.weightKg ? `<span class="tag">${p.weightKg}kg</span>` : ''}
            ${p.brand ? `<span class="tag">${esc(p.brand)}</span>` : ''}
          </div>
          <div class="priceline">
            <span class="price">${fmt(p.price)}</span>
            ${p.wasPrice ? `<span class="was">${fmt(p.wasPrice)}</span>` : ''}
            ${p.pricePerKg ? `<span class="perkg">${fmt(p.pricePerKg)}/kg</span>` : ''}
          </div>
          <div class="storeline">
            <span class="storepill" style="background:${storeColor}">${esc(p.storeName)}</span>
            ${p.inStock === true ? '<span class="stock">In stock</span>' : ''}
            ${oos ? '<span class="stock no">Out of stock</span>' : ''}
          </div>
          <a class="viewbtn" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">View at ${esc(p.storeName)} →</a>
        </div>
      </article>`;
    }).join('');
    $('#grid').innerHTML = html;

    if (META?.generatedAt) {
      const when = new Date(META.generatedAt);
      $('#dataMeta').innerHTML = `prices updated <b>${timeAgo(when)}</b> · ${DATA.length} products tracked`;
    }
  }

  function timeAgo(date) {
    const mins = Math.max(1, Math.round((Date.now() - date.getTime()) / 60000));
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs} h ago`;
    return `${Math.round(hrs / 24)} d ago`;
  }

  function renderStoreStatus() {
    if (!META?.stores) { $('#storeStatus').textContent = ''; return; }
    $('#storeStatus').innerHTML = Object.entries(META.stores).map(([key, s]) => {
      const cls = s.status === 'ok' ? 'status-ok' : (s.status === 'manual' || s.status === 'stale') ? 'status-manual' : 'status-error';
      const title = s.error ? ` title="${esc(s.error)}"` : '';
      const label = s.status === 'error' ? `${s.name} (unavailable)` :
        s.status === 'manual' ? `${s.name} (${s.count}, manual)` :
        s.status === 'stale' ? `${s.name} (${s.count}, stale)` : `${s.name} (${s.count})`;
      return `<a class="storestat" href="${esc(s.url || '#')}" target="_blank" rel="noopener noreferrer"${title}>
        <span class="status-dot ${cls}"></span>${esc(label)}</a>`;
    }).join('');
  }

  /* ---------- hash state ---------- */
  function syncHash() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.materials.size) p.set('mat', [...state.materials].join(','));
    if (state.colours.size) p.set('col', [...state.colours].join(','));
    if (state.finishes.size) p.set('fin', [...state.finishes].join(','));
    if (state.formats.size) p.set('fmt', [...state.formats].join(','));
    if (state.brands.size) p.set('brand', [...state.brands].join(','));
    if (state.stores.size) p.set('store', [...state.stores].join(','));
    if (state.sale) p.set('sale', '1');
    if (state.stock) p.set('stock', '1');
    if (state.sort !== 'perkg') p.set('sort', state.sort);
    history.replaceState(null, '', location.pathname + (p.toString() ? '#' + p : ''));
  }

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.q = p.get('q') || '';
    (p.get('mat') || '').split(',').filter(Boolean).forEach((v) => state.materials.add(v));
    (p.get('col') || '').split(',').filter(Boolean).forEach((v) => state.colours.add(v));
    (p.get('fin') || '').split(',').filter(Boolean).forEach((v) => state.finishes.add(v));
    (p.get('fmt') || '').split(',').filter(Boolean).forEach((v) => state.formats.add(v));
    (p.get('brand') || '').split(',').filter(Boolean).forEach((v) => state.brands.add(v));
    (p.get('store') || '').split(',').filter(Boolean).forEach((v) => state.stores.add(v));
    state.sale = p.get('sale') === '1';
    state.stock = p.get('stock') === '1';
    state.sort = p.get('sort') || 'perkg';
  }

  /* ---------- events ---------- */
  let debounce;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = e.target.value.trim();
      buildFacets(); render(); syncHash();
    }, 180);
  });
  $('#saleToggle').addEventListener('click', (e) => {
    state.sale = !state.sale; e.target.classList.toggle('on', state.sale);
    buildFacets(); render(); syncHash();
  });
  $('#stockToggle').addEventListener('click', (e) => {
    state.stock = !state.stock; e.target.classList.toggle('on', state.stock);
    buildFacets(); render(); syncHash();
  });
  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value; render(); syncHash();
  });
  $('#clearFilters').addEventListener('click', () => {
    state.materials.clear(); state.colours.clear(); state.brands.clear(); state.stores.clear();
    state.finishes.clear(); state.formats.clear();
    state.q = ''; state.sale = false; state.stock = false;
    $('#q').value = '';
    $('#saleToggle').classList.remove('on');
    $('#stockToggle').classList.remove('on');
    buildFacets(); render(); syncHash();
  });
  $('#facetToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  /* ---------- init ---------- */
  readHash();
  $('#q').value = state.q;
  $('#sort').value = state.sort;
  $('#saleToggle').classList.toggle('on', state.sale);
  $('#stockToggle').classList.toggle('on', state.stock);
  load();
})();
