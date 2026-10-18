// Dot page: speech in (Web Speech API), chat with the server, speech out.
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
  // Speak replies: 'voice' = only when the request was spoken (default), 'always', or 'never'.
  speakBox.value = store.get('speakMode', store.get('speak', '1') === '0' ? 'never' : 'voice');
  langSel.addEventListener('change', () => { store.set('lang', langSel.value); applyLanguage(); restartListening(); });
  speakBox.addEventListener('change', () => store.set('speakMode', speakBox.value));

  const setStatus = (t) => { if (status) status.textContent = t; };

  // The page's own short texts, in the chosen language.
  const UI = {
    'pt-BR': { open: 'Abrir', confirmTitle: 'Confirmar?', yes: '✓ Sim, salvar', no: 'Cancelar', yesWord: 'Sim', noWord: 'Não', placeholder: 'Escreva para o Dot…',
      sayYes: 'Diga “sim” para salvar ou “não” para cancelar.', tapYes: 'Toque em “Sim, salvar” ou “Cancelar”.', listening: 'Escutando…',
      micBlocked: 'Permita o microfone (toque no ícone à esquerda do endereço).', noSpeech: 'Não ouvi nada. Toque e fale de novo.',
      yesListening: 'Sim? Estou ouvindo…', wakeHint: 'Diga “Dot” e o seu pedido…', wakeBlocked: 'Permita o microfone para usar o “Hey Dot”.',
      welcome: 'Shalom! Eu sou o Dot. Posso procurar contatos, adicionar pessoas, registrar doações e Yahrzeits. Por exemplo: “Adiciona Joseli e Dimini aos contatos, email joseli@gmail.com”.',
      offline: 'Sem conexão com o servidor.', dropped: 'A conexão caiu antes da resposta. Tente de novo.', newChat: 'Nova conversa. Como posso ajudar?',
      send: 'Enviar', voice: 'Voz:', reset: 'Nova conversa', speak: ['quando eu falar', 'sempre', 'nunca'] },
    'en-US': { open: 'Open', confirmTitle: 'Confirm?', yes: '✓ Yes, save', no: 'Cancel', yesWord: 'Yes', noWord: 'No', placeholder: 'Write to Dot…',
      sayYes: 'Say “yes” to save or “no” to cancel.', tapYes: 'Tap “Yes, save” or “Cancel”.', listening: 'Listening…',
      micBlocked: 'Allow the microphone (tap the icon left of the address).', noSpeech: "I didn't hear anything. Tap and speak again.",
      yesListening: "Yes? I'm listening…", wakeHint: 'Say “Dot” and your request…', wakeBlocked: 'Allow the microphone to use “Hey Dot”.',
      welcome: 'Shalom! I am Dot. I can find contacts, add people, record donations and Yahrzeits. For example: “Add Joseli and Dimini to the contacts, email joseli@gmail.com”.',
      offline: 'No connection to the server.', dropped: 'The connection dropped before the answer. Please try again.', newChat: 'New conversation. How can I help?',
      send: 'Send', voice: 'Voice:', reset: 'New conversation', speak: ['when I speak', 'always', 'never'] },
    'he-IL': { open: 'פתח', confirmTitle: 'לאשר?', yes: '✓ כן, לשמור', no: 'ביטול', yesWord: 'כן', noWord: 'לא', placeholder: 'כתוב לדוט…',
      sayYes: 'אמור “כן” כדי לשמור או “לא” כדי לבטל.', tapYes: 'הקש “כן, לשמור” או “ביטול”.', listening: 'מקשיב…',
      micBlocked: 'אשר גישה למיקרופון (הקש על הסמל משמאל לכתובת).', noSpeech: 'לא שמעתי כלום. הקש ודבר שוב.',
      yesListening: 'כן? אני מקשיב…', wakeHint: 'אמור “דוט” ואת הבקשה שלך…', wakeBlocked: 'אשר גישה למיקרופון כדי להשתמש ב“Hey Dot”.',
      welcome: 'שלום! אני דוט. אני יכול לחפש אנשי קשר, להוסיף אנשים, לרשום תרומות ויארצייטים. לדוגמה: “תוסיף את יוסי כהן לאנשי הקשר, אימייל yossi@gmail.com”.',
      offline: 'אין חיבור לשרת.', dropped: 'החיבור נותק לפני התשובה. נסה שוב.', newChat: 'שיחה חדשה. איך אפשר לעזור?',
      send: 'שלח', voice: 'קול:', reset: 'שיחה חדשה', speak: ['כשאני מדבר', 'תמיד', 'אף פעם'] },
  };
  const ui = () => UI[langSel.value] || UI['pt-BR'];
  function applyLanguage() {
    const u = ui();
    const title = card.querySelector('strong');
    if (title) title.textContent = u.confirmTitle;
    $('[data-yes]').textContent = u.yes;
    $('[data-no]').textContent = u.no;
    input.placeholder = u.placeholder;
    $('[data-send]').textContent = u.send;
    $('[data-voice-label]').textContent = u.voice;
    $('[data-reset]').textContent = u.reset;
    [...$('[data-speak]').options].forEach((o, n) => { o.textContent = u.speak[n]; });
    const welcome = chat.querySelector('[data-welcome]');
    if (welcome) welcome.textContent = u.welcome;
    chat.dir = langSel.value === 'he-IL' ? 'auto' : '';
  }
  const scroll = () => { chat.scrollTop = chat.scrollHeight; };
  function bubble(text, who, links) {
    const div = document.createElement('div');
    div.className = `bubble ${who === 'me' ? 'me-msg' : 'buggy-msg'}`;
    div.textContent = text;
    for (const l of links || []) {
      const a = document.createElement('a');
      a.href = l.href;
      a.textContent = ui().open;
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
  const synth = window.speechSynthesis;
  let voiceUnlocked = false;
  // Chrome only lets a page speak after the user has touched it once: "unlock" on first touch.
  function unlockVoice() {
    if (voiceUnlocked || !synth) return;
    voiceUnlocked = true;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } catch { /* ignore */ }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlockVoice, { once: true, capture: true }));

  function pickVoice() {
    const want = langSel.value.slice(0, 2);
    const voices = synth.getVoices();
    return voices.find((v) => v.lang && v.lang.replace('_', '-') === langSel.value)
      || voices.find((v) => v.lang && v.lang.replace('_', '-').startsWith(want));
  }

  /** Reads text aloud; resolves when done. */
  function say(text) {
    if (!synth || !text) return Promise.resolve();
    return new Promise((resolve) => {
      speaking = true;
      stopAll(); // release the microphone: phones mute speech while it is listening
      setTimeout(() => {
        try { synth.cancel(); if (synth.paused) synth.resume(); } catch { /* ignore */ }
        const u = new SpeechSynthesisUtterance(text);
        u.lang = langSel.value;
        const voice = pickVoice();
        if (voice) u.voice = voice;
        let started = false;
        const finish = () => { clearTimeout(guard); resolve(); };
        u.onstart = () => { started = true; };
        u.onend = finish;
        u.onerror = (e) => {
          finish();
        };
        // If speech never starts (blocked by the phone), stop waiting.
        const guard = setTimeout(() => { if (!started) { try { synth.cancel(); } catch { /* ignore */ } resolve(); } }, 3000);
        synth.speak(u);
      }, 250);
    }).finally(() => { speaking = false; resumeListening(); });
  }

  function speak(text, viaVoice) {
    const mode = speakBox.value;
    if (mode === 'never' || (mode === 'voice' && !viaVoice)) return Promise.resolve();
    return say(text);
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
  async function handle(result, viaVoice) {
    if (result.error) { bubble(result.error, 'buggy'); setStatus(''); return speak(result.error, viaVoice); }
    bubble(result.reply, 'buggy', result.links);
    showPending(result.pending);
    setStatus(result.pending && result.pending.length ? (viaVoice ? ui().sayYes : ui().tapYes) : '');
    await speak(result.reply, viaVoice);
  }
  // Progress steps, in the language chosen on the page.
  const STEPS = {
    'pt-BR': { thinking: 'Pensando', searching: 'Procurando', reading: 'Lendo a ficha', checking_dates: 'Verificando datas', checking_funds: 'Verificando fundos', creating_contact: 'Criando contato', adding_person: 'Adicionando pessoa', updating: 'Atualizando', recording_donation: 'Registrando doação', adding_date: 'Adicionando data', saving: 'Salvando', working: 'Trabalhando' },
    'en-US': { thinking: 'Thinking', searching: 'Searching', reading: 'Reading the contact', checking_dates: 'Checking dates', checking_funds: 'Checking funds', creating_contact: 'Creating contact', adding_person: 'Adding person', updating: 'Updating', recording_donation: 'Recording donation', adding_date: 'Adding date', saving: 'Saving', working: 'Working' },
    'he-IL': { thinking: 'חושב', searching: 'מחפש', reading: 'קורא את הכרטיס', checking_dates: 'בודק תאריכים', checking_funds: 'בודק קרנות', creating_contact: 'יוצר איש קשר', adding_person: 'מוסיף אדם', updating: 'מעדכן', recording_donation: 'רושם תרומה', adding_date: 'מוסיף תאריך', saving: 'שומר', working: 'עובד' },
  };
  const stepLabel = (code) => (STEPS[langSel.value] || STEPS['pt-BR'])[code] || (STEPS['pt-BR'][code] ? STEPS['pt-BR'][code] : code);

  /** A "working" bubble listing Dot's steps, ticking off finished ones. */
  function progressBubble() {
    const div = document.createElement('div');
    div.className = 'bubble buggy-msg progress';
    const list = document.createElement('ul');
    div.appendChild(list);
    chat.appendChild(div);
    scroll();
    return {
      step(code) {
        const text = stepLabel(code);
        if ([...list.children].some((li) => li.textContent === text)) return; // each step shown once
        const prev = list.lastElementChild;
        if (prev) prev.classList.add('done');
        const li = document.createElement('li');
        li.textContent = text;
        list.appendChild(li);
        setStatus(`${text}…`);
        scroll();
      },
      remove() { div.remove(); },
    };
  }

  /** Sends a message and reads the progress lines ({"step"}) until the final {"result"}. */
  async function streamMessage(text, progress) {
    const res = await fetch('/assistant/message', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', 'x-csrf-token': csrf },
      body: JSON.stringify({ text, lang: langSel.value }),
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
    return final || { error: ui().dropped };
  }

  async function send(text, viaVoice = false) {
    text = (text || '').trim();
    if (!text || busy || !enabled) return;
    busy = true;
    bubble(text, 'me');
    const progress = progressBubble();
    progress.step('thinking');
    try {
      const result = await streamMessage(text, progress);
      progress.remove();
      await handle(result, viaVoice);
    } catch {
      progress.remove();
      bubble(ui().offline, 'buggy');
      setStatus('');
    } finally {
      busy = false;
      resumeListening();
    }
  }
  async function decide(decision, viaVoice = false) {
    if (busy) return;
    busy = true;
    bubble(decision === 'yes' ? ui().yesWord : ui().noWord, 'me');
    try { await handle(await post('/assistant/confirm', { decision, lang: langSel.value }), viaVoice); } finally { busy = false; resumeListening(); }
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
    bubble(ui().newChat, 'buggy');
  });

  // --- Speech in ---
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let listening = false;   // a single command is being captured
  let wakeMode = false;    // listening continuously for "Dot ..."
  let speaking = false;
  let awaitingCommand = false; // heard "Dot" alone, next phrase is the command
  // Only at the start of a phrase, so a "dot" inside a command (e.g. "gmail dot com") is never cut out.
  const WAKE = /^\s*(hey |hei |ei |oi |e a[ií] |היי )?(dot+s?|doth|dott?[ie]|d[oó]ti|d[oó]te|דוט|דוטי)(?=$|[\s,.!?])[,.!?]?\s*/i;

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
    setStatus(ui().listening);
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
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setStatus(ui().micBlocked);
      else if (e.error === 'no-speech') setStatus(ui().noSpeech);
    };
    rec.onend = () => {
      listening = false;
      mic.classList.remove('on');
      const t = finalText.trim() || input.value.trim();
      input.value = '';
      const command = t.replace(WAKE, '').trim();
      if (command) routeSpeech(command);
      else if (t) { setStatus(ui().yesListening); beep(); setTimeout(listenOnce, 300); return; } // just "Dot"
      else if (!busy) setStatus('');
      if (wakeMode) resumeListening();
    };
    try { rec.start(); } catch { /* already started */ }
  }

  function routeSpeech(text) {
    if (!card.hidden) {
      if (/^(sim|yes|yeah|yep|sure|confirm|go ahead|save|pode|ok|isso|claro|salva|כן|בטח|אשר|תשמור)(?=$|[\s,.!])/i.test(text)) return decide('yes', true);
      if (/^(n[aã]o|no|nope|cancel|stop|para|esquece|לא|בטל|עזוב)(?=$|[\s,.!])/i.test(text)) return decide('no', true);
    }
    send(text, true);
  }

  function startWake() {
    if (!Recognition || speaking || busy || listening) return;
    stopAll();
    rec = makeRecognizer(true);
    rec.interimResults = false;
    setStatus(ui().wakeHint);
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const said = e.results[i][0].transcript.trim();
        if (awaitingCommand) { awaitingCommand = false; stopAll(); routeSpeech(said); continue; }
        const m = said.match(WAKE);
        if (!m) continue;
        const command = said.slice(m.index + m[0].length).trim();
        if (command) { stopAll(); routeSpeech(command); }
        else { awaitingCommand = true; setStatus(ui().yesListening); beep(); }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wakeMode = false;
        wakeBox.checked = false;
        setStatus(ui().wakeBlocked);
      }
    };
    rec.onend = () => { if (wakeMode && !speaking && !listening) setTimeout(startWake, 300); };
    try { rec.start(); } catch { /* already started */ }
  }

  function stopAll() {
    if (rec) { rec.onend = null; try { rec.abort(); } catch { /* ignore */ } rec = null; }
  }
  function pauseListening() { if (wakeMode) stopAll(); }
  function resumeListening() { if (wakeMode && !speaking && !listening && !busy) setTimeout(startWake, 400); }
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

  // Lets Chrome offer "Install app", so the phone's assistant can open Dot by name.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  applyLanguage();
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
