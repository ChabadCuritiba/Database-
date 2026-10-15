// Progressive enhancements. Every page works without JavaScript.
(function () {
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Confirmation prompts for destructive forms / buttons.
  $$('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });
  $$('[data-confirm-click]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (!window.confirm(btn.dataset.confirmClick)) e.preventDefault();
    });
  });

  $$('[data-back]').forEach((a) => a.addEventListener('click', (e) => {
    if (history.length > 1) { e.preventDefault(); history.back(); }
  }));

  // "Select all" checkboxes.
  $$('[data-select-all]').forEach((master) => {
    master.addEventListener('change', () => {
      const form = master.closest('form') || document;
      $$(`input[type=checkbox][name="${master.dataset.selectAll}"]`, form).forEach((cb) => { cb.checked = master.checked; });
    });
  });

  // CEP lookup (ViaCEP) fills the address fields.
  $$('input[data-cep]').forEach((input) => {
    const form = input.form;
    const status = input.parentElement.querySelector('[data-cep-status]');
    input.addEventListener('blur', async () => {
      const cep = input.value.replace(/\D/g, '');
      if (cep.length !== 8) return;
      if (status) status.textContent = 'Looking up…';
      try {
        const res = await fetch(`/api/cep/${cep}`, { credentials: 'same-origin' });
        const data = await res.json();
        if (data.error) { if (status) status.textContent = data.error; return; }
        for (const k of ['street', 'neighborhood', 'city', 'state']) {
          const field = form.elements[k];
          if (field && data[k] && !field.readOnly) field.value = data[k];
        }
        if (form.elements.complement && !form.elements.complement.value && data.complement) form.elements.complement.value = data.complement;
        input.value = `${cep.slice(0, 5)}-${cep.slice(5)}`;
        if (status) status.textContent = '✓ address filled';
        if (form.elements.number) form.elements.number.focus();
      } catch {
        if (status) status.textContent = 'Lookup unavailable';
      }
    });
  });

  // Live Hebrew date next to a civil date input.
  $$('input[data-hebrew-preview]').forEach((input) => {
    const out = input.parentElement.querySelector('[data-hebrew-out]');
    const sunset = input.form.elements[input.dataset.hebrewPreview];
    const update = async () => {
      if (!out || !input.value) return;
      const q = new URLSearchParams({ date: input.value, after_sunset: sunset && sunset.checked ? '1' : '0' });
      try {
        const r = await fetch(`/api/hebrew-date?${q}`, { credentials: 'same-origin' });
        const d = await r.json();
        out.textContent = d.en ? `${d.en} · ${d.he}` : '';
      } catch { /* ignore */ }
    };
    input.addEventListener('change', update);
    if (sunset) sunset.addEventListener('change', update);
    update();
  });

  // Family search with datalist; stores the chosen id in a hidden field.
  $$('input[data-family-search]').forEach((input) => {
    const hidden = input.form.querySelector('[data-family-id]');
    const list = document.getElementById(input.getAttribute('list'));
    let results = [];
    let timer;
    input.addEventListener('input', () => {
      const match = results.find((r) => label(r) === input.value);
      if (hidden) hidden.value = match ? match.id : '';
      clearTimeout(timer);
      if (match || input.value.length < 2) return;
      timer = setTimeout(async () => {
        const r = await fetch(`/api/families?q=${encodeURIComponent(input.value)}`, { credentials: 'same-origin' });
        results = await r.json();
        list.innerHTML = '';
        for (const f of results) {
          const opt = document.createElement('option');
          opt.value = label(f);
          list.appendChild(opt);
        }
      }, 200);
    });
    function label(f) { return `${f.family_name}${f.city ? ` (${f.city})` : ''} #${f.id}`; }
  });

  // Campaign recipients: show the panel for the chosen audience; searchable contact picker.
  $$('[data-audience-form]').forEach((form) => {
    const panels = $$('[data-audience-panel]', form);
    const sync = () => {
      const chosen = (form.querySelector('input[name=audience]:checked') || {}).value;
      panels.forEach((p) => {
        const on = p.dataset.audiencePanel === chosen;
        p.hidden = !on;
        // Hidden panels must not submit their fields.
        $$('input, select', p).forEach((el) => { el.disabled = !on; });
      });
    };
    $$('input[name=audience]', form).forEach((r) => r.addEventListener('change', sync));
    sync();

    const rows = $$('.pick-row', form);
    const count = form.querySelector('[data-pick-count]');
    const search = form.querySelector('[data-pick-search]');
    const updateCount = () => { if (count) count.textContent = rows.filter((r) => r.querySelector('input').checked).length; };
    const visible = () => rows.filter((r) => !r.hidden);
    if (search) search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      rows.forEach((r) => { r.hidden = q && !r.dataset.pickText.includes(q); });
    });
    const all = form.querySelector('[data-pick-all]');
    const none = form.querySelector('[data-pick-none]');
    if (all) all.addEventListener('click', () => { visible().forEach((r) => { r.querySelector('input').checked = true; }); updateCount(); });
    if (none) none.addEventListener('click', () => { rows.forEach((r) => { r.querySelector('input').checked = false; }); updateCount(); });
    form.addEventListener('change', updateCount);
    form.addEventListener('submit', (e) => {
      const chosen = (form.querySelector('input[name=audience]:checked') || {}).value;
      if (chosen === 'pick' && rows.length && !rows.some((r) => r.querySelector('input').checked)) {
        e.preventDefault();
        window.alert('Please choose at least one contact.');
      }
    });
    updateCount();
  });

  // Money parsing for live totals (accepts 1.234,56 and 1,234.56).
  function parseMoney(s) {
    s = String(s || '').replace(/[^\d.,-]/g, '');
    if (!s) return 0;
    const hasComma = s.includes(','), hasDot = s.includes('.');
    if (hasComma && hasDot) {
      const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
    } else if (hasComma || hasDot) {
      const parts = s.split(hasComma ? ',' : '.');
      s = parts.length > 2 || parts[1].length === 3 ? parts.join('') : parts.join('.');
    }
    return Math.round((Number(s) || 0) * 100);
  }
  const fmt = (cents) => (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

  $$('[data-splits]').forEach((box) => {
    const total = box.closest('form').querySelector('[data-split-total]');
    const update = () => {
      const sum = $$('input[name$="[amount]"]', box).reduce((t, i) => t + parseMoney(i.value), 0);
      if (total) total.textContent = fmt(sum);
    };
    box.addEventListener('input', update);
  });

  $$('[data-price-form]').forEach((form) => {
    const out = form.querySelector('[data-price-total]');
    const update = () => {
      const sum = $$('input[data-price]', form).reduce((t, i) => t + Number(i.dataset.price) * (Number(i.value) || 0), 0);
      if (out) out.textContent = sum ? `R$ ${fmt(sum)}` : 'free';
    };
    form.addEventListener('input', update);
    update();
  });
})();
