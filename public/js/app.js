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

  // Campaign recipients: type to get a dropdown of contacts, click to add; or "All contacts".
  $$('[data-recipients-form]').forEach((form) => {
    const picker = form.querySelector('[data-picker]');
    const search = form.querySelector('[data-recipient-search]');
    const dropdown = form.querySelector('[data-dropdown]');
    const chips = form.querySelector('[data-chips]');
    const allBox = form.querySelector('[data-all-contacts]');
    const box = form.querySelector('.recipient-box');
    const hint = form.querySelector('[data-recipient-hint]');
    const filters = form.querySelector('[data-filters]');
    if (!picker || !search) return;
    picker.classList.add('enhanced');
    const items = $$('.pick-row', picker).map((row) => ({
      row,
      input: row.querySelector('input'),
      name: row.dataset.name,
      sub: row.dataset.sub,
      contact: row.dataset.contact,
      // Words a query can start with: names, salutation, and the parts of the email/phone.
      words: `${row.dataset.name} ${row.dataset.sub} ${row.dataset.contact}`.toLowerCase().split(/[\s@.,()&-]+/).filter(Boolean),
      contactLower: row.dataset.contact.toLowerCase(),
      digits: row.dataset.contact.replace(/\D/g, ''),
    }));
    const matches = (it, q) => {
      if (it.contactLower.startsWith(q) || it.words.some((w) => w.startsWith(q))) return true;
      const d = q.replace(/\D/g, '');
      return d.length >= 3 && it.digits.includes(d); // phone numbers typed with any formatting
    };
    let active = -1;

    const selected = () => items.filter((i) => i.input.checked);
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

    function renderChips() {
      chips.innerHTML = '';
      for (const it of selected()) {
        const chip = el('span', 'chip', it.name);
        const x = el('button', '', '×');
        x.type = 'button';
        x.setAttribute('aria-label', `Remove ${it.name}`);
        x.addEventListener('click', () => { it.input.checked = false; update(); search.focus(); });
        chip.appendChild(x);
        chips.appendChild(chip);
      }
    }

    function update() {
      const all = allBox && allBox.checked;
      box.classList.toggle('disabled', !!all);
      items.forEach((i) => { i.input.disabled = !!all; });
      const n = selected().length;
      if (filters) filters.hidden = !!all || n > 0;
      if (hint) {
        hint.textContent = all ? `Sending to all ${items.length} contacts.`
          : n ? `Sending to ${n} chosen contact${n > 1 ? 's' : ''}.`
          : 'Type to find people, choose “All contacts”, or leave empty and use the filters below.';
      }
      renderChips();
    }

    function options() {
      const q = search.value.trim().toLowerCase();
      const list = items.filter((i) => !i.input.checked && (!q || matches(i, q))).slice(0, 50);
      return { q, list };
    }

    function openDropdown() {
      const { q, list } = options();
      dropdown.innerHTML = '';
      const buttons = [];
      if (!q) {
        const all = el('button', 'all-option', `All contacts (${items.length})`);
        all.type = 'button';
        all.addEventListener('click', () => { if (allBox) allBox.checked = true; closeDropdown(); update(); });
        buttons.push(all);
      }
      for (const it of list) {
        const b = el('button');
        b.type = 'button';
        const left = el('span');
        left.appendChild(el('strong', '', it.name));
        if (it.sub) left.appendChild(el('span', 'muted small', ` ${it.sub}`));
        b.appendChild(left);
        b.appendChild(el('span', 'muted small', it.contact));
        b.addEventListener('click', () => { it.input.checked = true; search.value = ''; update(); openDropdown(); search.focus(); });
        buttons.push(b);
      }
      if (!buttons.length) dropdown.appendChild(el('div', 'empty', 'No matching contacts'));
      buttons.forEach((b) => dropdown.appendChild(b));
      active = -1;
      dropdown.hidden = false;
    }
    function closeDropdown() { dropdown.hidden = true; active = -1; }
    function move(step) {
      const btns = $$('button', dropdown);
      if (!btns.length) return;
      active = (active + step + btns.length) % btns.length;
      btns.forEach((b, i) => b.classList.toggle('active', i === active));
      btns[active].scrollIntoView({ block: 'nearest' });
    }

    search.addEventListener('focus', openDropdown);
    search.addEventListener('input', openDropdown);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (dropdown.hidden) openDropdown(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault(); // never submit the form from the search box
        const btns = $$('button', dropdown);
        const target = btns[active] || (search.value.trim() && btns.find((b) => !b.classList.contains('all-option')));
        if (target) target.click();
      } else if (e.key === 'Escape') closeDropdown();
      else if (e.key === 'Backspace' && !search.value) {
        const last = selected().pop();
        if (last) { last.input.checked = false; update(); }
      }
    });
    document.addEventListener('click', (e) => {
      // A clicked option is re-rendered (detached) before this runs; that is not an outside click.
      if (e.target.isConnected && !form.querySelector('.recipients').contains(e.target)) closeDropdown();
    });
    box.addEventListener('click', (e) => { if (e.target === box) search.focus(); });
    if (allBox) allBox.addEventListener('change', update);
    update();
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
