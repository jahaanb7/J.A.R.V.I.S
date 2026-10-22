/* Buffy orb: an arc-reactor icon drawn on canvas, a compact panel, and voice in and out. */
(() => {
  'use strict';

  const canvas = document.getElementById('orb');
  const ctx = canvas.getContext('2d');
  const shell = document.getElementById('shell');
  const head = document.getElementById('head');
  const statusEl = document.getElementById('status');
  const transcript = document.getElementById('transcript');
  const composer = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const micBtn = document.getElementById('mic');
  const muteBtn = document.getElementById('mute');
  const noteEl = document.getElementById('note');
  const collapseBtn = document.getElementById('collapse');
  const openBtn = document.getElementById('open-main');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = getComputedStyle(document.documentElement);
  const ACCENT = css.getPropertyValue('--accent').trim();
  const WARN = css.getPropertyValue('--warn').trim();

  const STATUS_LABEL = {
    idle: 'STANDBY',
    listening: 'LISTENING',
    thinking: 'THINKING',
    speaking: 'SPEAKING',
    alert: 'CHECK',
  };

  let state = 'idle';
  let expanded = false;
  let busy = false;
  let voiceOn = true;
  let recognition = null;
  let alertTimer = null;
  let press = null;

  // ---- Icon -------------------------------------------------------------------------------------

  function resizeCanvas() {
    const size = canvas.clientWidth || 96;
    const dpr = window.devicePixelRatio || 1;
    const pixels = Math.round(size * dpr);
    if (canvas.width !== pixels) {
      canvas.width = pixels;
      canvas.height = pixels;
    }
    return { size, dpr };
  }

  function drawOrb(ts) {
    const { size, dpr } = resizeCanvas();
    const c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 3;
    const speed = reduceMotion ? 0.25 : 1;
    const t = (ts / 1000) * speed;
    const color = state === 'alert' ? WARN : ACCENT;
    const breath = 0.5 + 0.5 * Math.sin(ts / 1400);

    // Outer tick ring: 48 ticks, every fourth one longer.
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.globalAlpha = 0.3 + 0.1 * breath;
    for (let i = 0; i < 48; i += 1) {
      const a = (i / 48) * Math.PI * 2 + t * 0.05;
      const inner = R * (i % 4 === 0 ? 0.86 : 0.92);
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      c.stroke();
    }

    // Three arc segments that rotate faster while thinking.
    const spin = state === 'thinking' ? 2.6 : 0.8;
    const r1 = R * 0.76;
    c.lineWidth = 1.5;
    c.globalAlpha = 0.95;
    for (let k = 0; k < 3; k += 1) {
      const start = t * spin + (k * Math.PI * 2) / 3;
      c.beginPath();
      c.arc(cx, cy, r1, start, start + (Math.PI * 2) / 3 * 0.62);
      c.stroke();
    }

    // Dashed inner ring, turning the other way.
    c.lineWidth = 1;
    c.globalAlpha = 0.5;
    c.setLineDash([2, 5]);
    c.beginPath();
    c.arc(cx, cy, R * 0.58, -t * 0.6, -t * 0.6 + Math.PI * 2);
    c.stroke();
    c.setLineDash([]);

    // Listening: a ring that expands and fades, like a sound wave.
    if (state === 'listening') {
      const phase = (ts / 900) % 1;
      c.globalAlpha = 1 - phase;
      c.beginPath();
      c.arc(cx, cy, R * (0.45 + 0.5 * phase), 0, Math.PI * 2);
      c.stroke();
    }

    // Core glow and disc.
    const energy = state === 'listening' ? 0.75 + 0.25 * Math.sin(ts / 120) : 0.35 + 0.15 * breath;
    const coreR = R * 0.3 * (state === 'speaking' ? 1 + 0.08 * Math.sin(ts / 90) : 1);
    const grad = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    c.globalAlpha = energy * 0.55;
    c.fillStyle = grad;
    c.beginPath();
    c.arc(cx, cy, R * 0.6, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = color;
    c.beginPath();
    c.arc(cx, cy, coreR, 0, Math.PI * 2);
    c.fill();

    // Speaking: short bars around the core that move with the voice.
    if (state === 'speaking') {
      c.strokeStyle = color;
      c.lineWidth = 1.5;
      for (let i = 0; i < 24; i += 1) {
        const a = (i / 24) * Math.PI * 2;
        const amp = 0.5 + 0.5 * Math.sin(ts / 60 + i * 1.3);
        const r0 = R * 0.4;
        const r1b = r0 + R * 0.12 * amp;
        c.globalAlpha = 0.4 + 0.6 * amp;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        c.lineTo(cx + Math.cos(a) * r1b, cy + Math.sin(a) * r1b);
        c.stroke();
      }
    }
    c.globalAlpha = 1;
  }

  function loop(ts) {
    drawOrb(ts);
    requestAnimationFrame(loop);
  }

  // ---- State and panel ---------------------------------------------------------------------------

  function setState(next) {
    state = next;
    statusEl.textContent = STATUS_LABEL[next] || 'STANDBY';
    micBtn.setAttribute('aria-pressed', String(next === 'listening'));
  }

  function flashAlert(message) {
    setState('alert');
    note(message, true);
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => {
      if (state === 'alert') setState('idle');
    }, 4000);
  }

  function note(message, isAlert = false) {
    noteEl.textContent = message || '';
    noteEl.classList.toggle('alert', Boolean(isAlert));
  }

  function setExpanded(value) {
    expanded = value;
    shell.classList.toggle('expanded', value);
    canvas.setAttribute('aria-expanded', String(value));
    window.orb.resize(value);
    if (value) input.focus();
  }

  function addLine(who, text) {
    const empty = transcript.querySelector('.empty');
    if (empty) empty.remove();

    const line = document.createElement('div');
    const label = who === 'you' ? 'YOU' : who === 'buffy' ? 'BUFFY' : 'ALERT';
    line.className = `line ${who}`;
    const whoEl = document.createElement('span');
    whoEl.className = 'line-who';
    whoEl.textContent = label;
    const textEl = document.createElement('p');
    textEl.className = 'line-text';
    textEl.textContent = text;
    line.append(whoEl, textEl);
    transcript.append(line);
    transcript.scrollTop = transcript.scrollHeight;
  }

  // ---- Voice out ----------------------------------------------------------------------------------

  function pickVoice() {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find((v) => /^en/i.test(v.lang) && /(Daniel|Samantha|Google UK English Male|Alex)/i.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang)) ||
      null
    );
  }

  function speak(text) {
    if (!voiceOn || !window.speechSynthesis || !text) {
      setState('idle');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = 1.02;
    utterance.onstart = () => setState('speaking');
    utterance.onend = () => setState('idle');
    utterance.onerror = () => setState('idle');
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  // ---- Voice in -----------------------------------------------------------------------------------

  function startListening() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      flashAlert('Voice input is not available here. Type instead.');
      return;
    }
    if (state === 'listening') {
      recognition?.stop();
      return;
    }
    if (busy) return;

    if (!expanded) setExpanded(true);
    recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = '';
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece;
        else interim += piece;
      }
      input.value = (finalText + interim).trim();
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      flashAlert(`Voice input stopped: ${event.error}`);
    };
    recognition.onend = () => {
      recognition = null;
      if (state === 'listening') setState('idle');
      const text = input.value.trim();
      if (text) submit(text);
    };
    note('Listening. Speak, then pause to send.');
    setState('listening');
    recognition.start();
  }

  // ---- Ask ----------------------------------------------------------------------------------------

  async function submit(rawText) {
    const text = rawText.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    note('');
    addLine('you', text);
    setState('thinking');
    try {
      const result = await window.orb.ask(text);
      addLine('buffy', result.reply);
      speak(result.spoken || result.reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLine('alert', message);
      flashAlert('Something went wrong. Try again.');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      if (state === 'thinking') setState('idle');
      input.focus();
    }
  }

  // ---- Events -------------------------------------------------------------------------------------

  // Drag: the header moves the window. A press on the orb with no movement toggles the panel.
  head.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, input, form')) return;
    press = { x: event.screenX, y: event.screenY, moved: false, onOrb: event.target === canvas };
    head.setPointerCapture(event.pointerId);
    window.orb.dragStart();
  });

  head.addEventListener('pointermove', (event) => {
    if (!press) return;
    if (!press.moved && Math.hypot(event.screenX - press.x, event.screenY - press.y) > 4) press.moved = true;
    if (press.moved) window.orb.dragMove();
  });

  const endPress = (event) => {
    if (!press) return;
    const finished = press;
    press = null;
    window.orb.dragEnd();
    if (head.hasPointerCapture(event.pointerId)) head.releasePointerCapture(event.pointerId);
    if (event.type === 'pointerup' && !finished.moved && finished.onOrb) setExpanded(!expanded);
  };
  head.addEventListener('pointerup', endPress);
  head.addEventListener('pointercancel', endPress);

  canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setExpanded(!expanded);
    }
  });

  collapseBtn.addEventListener('click', () => setExpanded(false));
  openBtn.addEventListener('click', () => window.orb.openMain());

  muteBtn.addEventListener('click', () => {
    voiceOn = !voiceOn;
    muteBtn.setAttribute('aria-pressed', String(voiceOn));
    muteBtn.textContent = voiceOn ? 'VOICE ON' : 'VOICE OFF';
    if (!voiceOn) window.speechSynthesis?.cancel();
    if (!voiceOn && state === 'speaking') setState('idle');
  });

  micBtn.addEventListener('click', startListening);

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(input.value);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (expanded) setExpanded(false);
    else window.orb.hide();
  });

  window.orb.onShown(() => {
    shell.classList.remove('pop');
    void shell.offsetWidth;
    shell.classList.add('pop');
    if (expanded) input.focus();
  });

  setState('idle');
  requestAnimationFrame(loop);
})();
