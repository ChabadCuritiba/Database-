// Buggy page: speech in (Web Speech API), chat with the server, speech out.
(function () {
  const root = document.querySelector('[data-buggy]');
  if (!root) return;
  const $ = (sel) => root.querySelector(sel);
  const chat = $('[data-chat]');
  const input = $('[data-input]');
  const mic = $('[data-mic]');
  const status = $('[data-status]');
  const card = $('[data-confirm-card]');
  const pendingList = $('[data-pending]');
  const speakBox = $('[data-speak]');
  const wakeBox = $('[data-wake]');
  const langSel = $('[data-lang]');
  const csrf = root.dataset.csrf;
  const enabled = !!root.dataset.enabled;
  const shortcutUrl = `${location.origin}/assistant?listen=1`;
  const urlEl = $('[data-shortcut-url]');
  if (urlEl) urlEl.textContent = shortcutUrl;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(`buggy.${k}`); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`buggy.${k}`, v); } catch { /* ignore */ } },
  };
  langSel.value = store.get('lang', 'pt-BR');
  speakBox.checked = store.get('speak', '1') === '1';
  langSel.addEventListener('change', () => { store.set('lang', langSel.value); restartListening(); });
  speakBox.addEventListener('change', () => store.set('speak', speakBox.checked ? '1' : '0'));

  const setStatus = (t) => { if (status) status.textContent = t; };
  const scroll = () => { chat.scrollTop = chat.scrollHeight; };
  function bubble(text, who, links) {
    const div = document.createElement('div');
    div.className = `bubble ${who === 'me' ? 'me-msg' : 'buggy-msg'}`;
    div.textContent = text;
    for (const l of links || []) {
      const a = document.createElement('a');
      a.href = l.href;
      a.textContent = 'Abrir';
      a.className = 'bubble-link';
      div.appendChild(document.createTextNode(' '));
      div.appendChild(a);
    }
    chat.appendChild(div);
    scroll();
    return div;
  }
  function showPending(list) {
    pendingList.innerHTML = '';
    for (const p of list || []) {
      const li = document.createElement('li');
      li.textContent = p.summary;
      pendingList.appendChild(li);
    }
    card.hidden = !(list && list.length);
    if (!card.hidden) card.scrollIntoView({ block: 'nearest' });
  }

  // --- Speech out ---
  function speak(text) {
    if (!speakBox.checked || !('speechSynthesis' in window) || !text) return Promise.resolve();
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = langSel.value;
      const voice = speechSynthesis.getVoices().find((v) => v.lang && v.lang.replace('_', '-').startsWith(langSel.value.slice(0, 2)));
      if (voice) u.voice = voice;
      u.onend = resolve;
      u.onerror = resolve;
      speaking = true;
      pauseListening();
      speechSynthesis.speak(u);
    }).finally(() => { speaking = false; resumeListening(); });
  }

  // --- Talking to the server ---
  let busy = false;
  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({ error: `Erro ${res.status}` }));
    if (!res.ok && !data.error) data.error = `Erro ${res.status}`;
    return data;
  }
  async function handle(result) {
    if (result.error) { bubble(result.error, 'buggy'); setStatus(''); return speak(result.error); }
    bubble(result.reply, 'buggy', result.links);
    showPending(result.pending);
    setStatus(result.pending && result.pending.length ? 'Diga “sim” para salvar ou “não” para cancelar.' : '');
    await speak(result.reply);
  }
  /** A "working" bubble that lists each step Buggy takes, ticking off finished ones. */
  function progressBubble() {
    const div = document.createElement('div');
    div.className = 'bubble buggy-msg progress';
    const list = document.createElement('ul');
    div.appendChild(list);
    chat.appendChild(div);
    scroll();
    let started = Date.now();
    const timer = setInterval(() => {
      const cur = list.lastElementChild;
      if (cur) cur.dataset.secs = `${Math.round((Date.now() - started) / 1000)}s`;
    }, 1000);
    return {
      step(text) {
        const prev = list.lastElementChild;
        if (prev) { prev.classList.add('done'); delete prev.dataset.secs; }
        const li = document.createElement('li');
        li.textContent = text;
        list.appendChild(li);
        started = Date.now();
        setStatus(`${text}…`);
        scroll();
      },
      remove() { clearInterval(timer); div.remove(); },
    };
  }

  /** Sends a message and reads the progress lines ({"step"}) until the final {"result"}. */
  async function streamMessage(text, progress) {
    const res = await fetch('/assistant/message', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', 'x-csrf-token': csrf },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body || !(res.headers.get('content-type') || '').includes('ndjson')) {
      const data = await res.json().catch(() => ({ error: `Erro ${res.status}` }));
      return data.reply !== undefined ? data : { error: data.error || `Erro ${res.status}` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.step) progress.step(msg.step);
        else if (msg.result) final = msg.result;
        else if (msg.error) final = { error: msg.error };
      }
      if (done) break;
    }
    return final || { error: 'A conexão caiu antes da resposta. Tente de novo.' };
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy || !enabled) return;
    busy = true;
    bubble(text, 'me');
    const progress = progressBubble();
    progress.step('Enviando');
    try {
      const result = await streamMessage(text, progress);
      progress.remove();
      await handle(result);
    } catch {
      progress.remove();
      bubble('Sem conexão com o servidor.', 'buggy');
      setStatus('');
    } finally {
      busy = false;
    }
  }
  async function decide(decision) {
    if (busy) return;
    busy = true;
    bubble(decision === 'yes' ? 'Sim' : 'Não', 'me');
    try { await handle(await post('/assistant/confirm', { decision })); } finally { busy = false; }
  }

  $('[data-composer]').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value;
    input.value = '';
    send(t);
  });
  $('[data-yes]').addEventListener('click', () => decide('yes'));
  $('[data-no]').addEventListener('click', () => decide('no'));
  $('[data-reset]').addEventListener('click', async () => {
    await post('/assistant/reset');
    chat.innerHTML = '';
    showPending([]);
    bubble('Nova conversa. Como posso ajudar?', 'buggy');
  });

  // --- Speech in ---
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let listening = false;   // a single command is being captured
  let wakeMode = false;    // listening continuously for "Buggy ..."
  let speaking = false;
  let awaitingCommand = false; // heard "Buggy" alone, next phrase is the command
  const WAKE = /\b(hey |ei |oi |e a[ií] )?(bug+y|bug+ie|bagg?y|bog+y|b[aá]gui|bugue|bugui|b[uú]gui)\b[,.!]?\s*/i;

  if (!Recognition) {
    mic.title = 'Este navegador não reconhece voz. Use o Chrome, o Safari ou escreva.';
    mic.classList.add('unsupported');
    wakeBox.disabled = true;
  }

  function makeRecognizer(continuous) {
    const r = new Recognition();
    r.lang = langSel.value;
    r.continuous = continuous;
    r.interimResults = true;
    r.maxAlternatives = 1;
    return r;
  }

  function listenOnce() {
    if (!Recognition || busy) return;
    stopAll();
    rec = makeRecognizer(false);
    listening = true;
    mic.classList.add('on');
    setStatus('Escutando…');
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      input.value = finalText || interim;
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setStatus('Permita o microfone (toque no ícone de cadeado da página).');
      else if (e.error === 'no-speech') setStatus('Não ouvi nada. Toque e fale de novo.');
    };
    rec.onend = () => {
      listening = false;
      mic.classList.remove('on');
      const t = finalText.trim() || input.value.trim();
      input.value = '';
      const command = t.replace(WAKE, '').trim();
      if (command) routeSpeech(command);
      else if (t) { setStatus('Sim? Estou ouvindo…'); beep(); setTimeout(listenOnce, 300); return; } // just "Buggy"
      else if (!busy) setStatus('');
      if (wakeMode) resumeListening();
    };
    try { rec.start(); } catch { /* already started */ }
  }

  function routeSpeech(text) {
    if (!card.hidden) {
      if (/^(sim|yes|confirm|pode|ok|isso|claro|salva)/i.test(text)) return decide('yes');
      if (/^(n[aã]o|no|cancel|para|esquece)/i.test(text)) return decide('no');
    }
    send(text);
  }

  function startWake() {
    if (!Recognition || speaking || busy || listening) return;
    stopAll();
    rec = makeRecognizer(true);
    rec.interimResults = false;
    setStatus('Diga “Buggy” e o seu pedido…');
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const said = e.results[i][0].transcript.trim();
        if (awaitingCommand) { awaitingCommand = false; routeSpeech(said); continue; }
        const m = said.match(WAKE);
        if (!m) continue;
        const command = said.slice(m.index + m[0].length).trim();
        if (command) routeSpeech(command);
        else { awaitingCommand = true; setStatus('Sim? Estou ouvindo…'); beep(); }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wakeMode = false;
        wakeBox.checked = false;
        setStatus('Permita o microfone para usar o “Hey Buggy”.');
      }
    };
    rec.onend = () => { if (wakeMode && !speaking && !listening) setTimeout(startWake, 300); };
    try { rec.start(); } catch { /* already started */ }
  }

  function stopAll() {
    if (rec) { rec.onend = null; try { rec.abort(); } catch { /* ignore */ } rec = null; }
  }
  function pauseListening() { if (wakeMode) stopAll(); }
  function resumeListening() { if (wakeMode && !speaking && !listening) setTimeout(startWake, 400); }
  function restartListening() { if (wakeMode) { stopAll(); startWake(); } }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.12);
    } catch { /* ignore */ }
  }

  mic.addEventListener('click', () => {
    if (listening) { if (rec) rec.stop(); return; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    listenOnce();
  });
  wakeBox.addEventListener('change', () => {
    wakeMode = wakeBox.checked;
    store.set('wake', wakeMode ? '1' : '0');
    if (wakeMode) startWake();
    else { stopAll(); setStatus(''); }
  });

  // Keep the screen awake while hands-free mode is on (where supported).
  let wakeLock = null;
  async function keepAwake() {
    try { if (wakeMode && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
  }
  wakeBox.addEventListener('change', keepAwake);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { wakeLock = null; keepAwake(); resumeListening(); }
  });

  // Lets Chrome offer "Install app", so the phone's assistant can open Buggy by name.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  scroll();
  if (!enabled) return;
  // Opened from a Siri / Google shortcut: start listening right away.
  // Some phones still require one tap the first time (microphone permission).
  if (new URLSearchParams(location.search).get('listen') === '1') {
    history.replaceState(null, '', location.pathname);
    setTimeout(listenOnce, 400);
  } else if (store.get('wake', '0') === '1' && Recognition) {
    wakeBox.checked = true;
    wakeMode = true;
    startWake();
  }
})();
