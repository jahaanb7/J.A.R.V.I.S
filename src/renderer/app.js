/* global window, document */
(function () {
  const api = window.jarvis;
  const $ = (id) => document.getElementById(id);

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function fmt(iso) {
    return new Date(iso).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function empty(text) {
    return el('li', text, 'empty');
  }

  let toastTimer = null;
  function toast(text, alert) {
    const box = $('toast');
    box.textContent = text;
    box.className = alert ? 'toast alert show' : 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.className = 'toast'; }, 3800);
  }

  function describeOutcome(result) {
    switch (result.status) {
      case 'done': return result.output.summary;
      case 'pending': return 'Waiting for your approval (see Approvals).';
      case 'denied': return `Blocked: ${result.reason}`;
      case 'error': return `Error: ${result.message}`;
      default: return 'Done.';
    }
  }

  function handleResult(result) {
    if (!result) return;
    toast(describeOutcome(result), result.status !== 'done');
  }

  async function invokeTool(name, args) {
    const result = await api.call('tools.invoke', { name, args });
    handleResult(result);
    return result;
  }

  // ---- Navigation ----
  let currentView = 'today';
  function showView(name) {
    currentView = name;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    refreshAll();
  }
  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ---- Today ----
  function renderGreeting() {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    $('greeting').textContent = part;
    $('today-date').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  async function renderToday() {
    const [briefing] = await Promise.all([api.call('briefing.get')]);
    $('briefing-text').textContent = briefing.summary;
    const events = $('briefing-events');
    events.replaceChildren();
    if (!briefing.events.length) events.appendChild(empty('No events today. Enjoy the open time.'));
    for (const ev of briefing.events) {
      const li = el('li');
      const main = el('div', undefined, 'item-main');
      main.appendChild(el('div', ev.title, 'item-title'));
      main.appendChild(el('div', `${fmtTime(ev.startAt)} – ${fmtTime(ev.endAt)}`, 'meta'));
      li.appendChild(main);
      events.appendChild(li);
    }

    const tasks = $('today-tasks');
    tasks.replaceChildren();
    if (!briefing.topTasks.length) tasks.appendChild(empty('No open tasks.'));
    for (const task of briefing.topTasks) appendTaskRow(tasks, task);
  }

  $('sticky-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('sticky-text').value.trim();
    if (!text) return;
    const seconds = Number($('sticky-seconds').value) || 25;
    const result = await invokeTool('sticky.show', { text, seconds });
    if (result.status === 'done') $('sticky-text').value = '';
  });

  // ---- Chat ----
  async function renderChat() {
    const history = await api.call('chat.history');
    const log = $('chat-log');
    log.replaceChildren();
    if (!history.length) log.appendChild(el('div', 'Say hello, or ask Buffy to add something to your day.', 'empty'));
    for (const message of history) {
      log.appendChild(el('div', message.content, `bubble ${message.role === 'user' ? 'user' : 'assistant'}`));
    }
    log.scrollTop = log.scrollHeight;
  }

  function speak(text) {
    if (!$('speak-replies').checked || !window.speechSynthesis) return;
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  $('chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const reply = await api.call('chat.send', { text });
      speak(reply.reply);
    } catch (err) {
      toast(err.message, true);
    }
    await renderChat();
    refreshAll();
  });

  // Voice input uses the browser speech recognizer where the platform provides it.
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  $('mic-btn').addEventListener('click', () => {
    if (!Recognition) {
      toast('Speech input is not available in this build. Type instead.', true);
      return;
    }
    const recognizer = new Recognition();
    recognizer.lang = 'en-US';
    recognizer.interimResults = false;
    recognizer.onresult = (e) => {
      $('chat-input').value = e.results[0][0].transcript;
      $('chat-form').requestSubmit();
    };
    recognizer.onerror = (e) => toast(`Voice input error: ${e.error}`, true);
    recognizer.start();
    toast('Listening…');
  });

  // ---- Schedule ----
  async function renderSchedule() {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const events = await api.call('calendar.list', { from, to });
    const list = $('schedule-list');
    list.replaceChildren();
    if (!events.length) list.appendChild(empty('Nothing scheduled this week.'));
    let lastDay = '';
    for (const ev of events) {
      const day = dayLabel(ev.startAt);
      if (day !== lastDay) {
        list.appendChild(el('li', day, 'day-heading'));
        lastDay = day;
      }
      const li = el('li');
      const main = el('div', undefined, 'item-main');
      main.appendChild(el('div', ev.title, 'item-title'));
      main.appendChild(el('div', `${fmtTime(ev.startAt)} – ${fmtTime(ev.endAt)}${ev.location ? ` · ${ev.location}` : ''}`, 'meta'));
      li.appendChild(main);
      const actions = el('div', undefined, 'actions');
      const del = el('button', 'Delete', 'btn small danger');
      del.addEventListener('click', () => invokeTool('calendar.remove', { id: ev.id }).then(refreshAll));
      actions.appendChild(del);
      li.appendChild(actions);
      list.appendChild(li);
    }
  }

  $('event-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await invokeTool('calendar.add', {
      title: $('event-title').value,
      start: new Date($('event-start').value).toISOString(),
      end: new Date($('event-end').value).toISOString(),
    });
    if (result.status === 'done') $('event-form').reset();
    refreshAll();
  });

  // ---- Tasks ----
  function appendTaskRow(list, task) {
    const li = el('li');
    const main = el('div', undefined, 'item-main');
    const title = el('div', task.title, 'item-title');
    main.appendChild(title);
    const meta = [];
    if (task.dueAt) meta.push(`due ${fmt(task.dueAt)}`);
    if (task.estimateMinutes) meta.push(`~${task.estimateMinutes} min`);
    if (meta.length) main.appendChild(el('div', meta.join(' · '), 'meta'));
    li.appendChild(main);
    const actions = el('div', undefined, 'actions');
    const pClass = task.priority === 1 ? 'p1' : task.priority === 2 ? 'p2' : '';
    actions.appendChild(el('span', `P${task.priority}`, `pill ${pClass}`));
    const done = el('button', 'Done', 'btn small');
    done.addEventListener('click', () => invokeTool('tasks.complete', { id: task.id }).then(refreshAll));
    actions.appendChild(done);
    li.appendChild(actions);
    list.appendChild(li);
  }

  async function renderTasks() {
    const tasks = await api.call('tasks.list');
    const list = $('task-list');
    list.replaceChildren();
    if (!tasks.length) list.appendChild(empty('No open tasks. Add one, or ask Buffy.'));
    for (const task of tasks) appendTaskRow(list, task);
  }

  $('task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('task-title');
    const result = await invokeTool('tasks.add', { title: input.value });
    if (result.status === 'done') input.value = '';
    refreshAll();
  });

  // ---- Widgets ----
  async function renderWidgets() {
    const widgets = await api.call('widgets.list');
    const grid = $('widget-grid');
    grid.replaceChildren();
    if (!widgets.length) {
      grid.appendChild(el('div', 'No widgets yet. Try a sticky note on the Today page, or ask Buffy to build a widget.', 'empty'));
      return;
    }
    for (const widget of widgets) {
      const tile = el('article', undefined, 'card widget-tile');
      const sticky = widget.kind === 'sticky';
      const preview = el('div', sticky ? 'Sticky note' : widget.name, sticky ? 'widget-preview sticky' : 'widget-preview');
      tile.appendChild(preview);
      tile.appendChild(el('div', widget.name, 'name'));
      tile.appendChild(el('div', widget.description || (sticky ? 'Sticky note' : 'Custom widget'), 'desc'));
      const row = el('div', undefined, 'row');
      const show = el('button', 'Show', 'btn small primary');
      show.addEventListener('click', () => invokeTool('widgets.show', { id: widget.id }));
      const del = el('button', 'Delete', 'btn small danger');
      del.addEventListener('click', () => invokeTool('widgets.delete', { id: widget.id }).then(refreshAll));
      row.appendChild(show);
      row.appendChild(del);
      tile.appendChild(row);
      grid.appendChild(tile);
    }
  }

  // ---- Approvals ----
  async function renderApprovals() {
    const approvals = await api.call('approvals.list');
    const badge = $('approval-badge');
    badge.hidden = approvals.length === 0;
    badge.textContent = String(approvals.length);
    const list = $('approval-list');
    list.replaceChildren();
    if (!approvals.length) list.appendChild(empty('Nothing waiting for you.'));
    for (const approval of approvals) {
      const li = el('li');
      const main = el('div', undefined, 'item-main');
      main.appendChild(el('div', approval.description, 'item-title'));
      main.appendChild(el('div', fmt(approval.requestedAt), 'meta'));
      li.appendChild(main);
      const actions = el('div', undefined, 'actions');
      const ok = el('button', 'Approve', 'btn small primary');
      ok.addEventListener('click', () => api.call('approvals.approve', { id: approval.id }).then(handleResult).then(refreshAll));
      const no = el('button', 'Deny', 'btn small');
      no.addEventListener('click', () => api.call('approvals.deny', { id: approval.id }).then(handleResult).then(refreshAll));
      actions.appendChild(no);
      actions.appendChild(ok);
      li.appendChild(actions);
      list.appendChild(li);
    }
  }

  // ---- Memory ----
  async function renderMemory() {
    const memories = await api.call('memory.list');
    const list = $('memory-list');
    list.replaceChildren();
    if (!memories.length) list.appendChild(empty('Nothing remembered yet.'));
    for (const memory of memories) {
      const li = el('li');
      const main = el('div', undefined, 'item-main');
      main.appendChild(el('div', memory.content, 'item-title'));
      main.appendChild(el('div', memory.kind, 'meta'));
      li.appendChild(main);
      const forget = el('button', 'Forget', 'btn small danger');
      forget.addEventListener('click', () => invokeTool('memory.forget', { id: memory.id }).then(refreshAll));
      const actions = el('div', undefined, 'actions');
      actions.appendChild(forget);
      li.appendChild(actions);
      list.appendChild(li);
    }
  }

  $('memory-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('memory-input');
    const result = await invokeTool('memory.remember', { content: input.value });
    if (result.status === 'done') input.value = '';
    refreshAll();
  });

  // ---- Activity ----
  async function renderAudit() {
    const entries = await api.call('audit.list', { limit: 80 });
    const list = $('audit-list');
    list.replaceChildren();
    if (!entries.length) list.appendChild(empty('No activity yet.'));
    for (const entry of entries) {
      const li = el('li');
      const main = el('div', undefined, 'item-main');
      main.appendChild(el('div', entry.action, 'item-title'));
      main.appendChild(el('div', entry.detail || '', 'meta'));
      li.appendChild(main);
      const right = el('div', undefined, 'actions');
      right.appendChild(el('span', entry.status, `pill ${entry.status}`));
      right.appendChild(el('span', fmtTime(entry.ts), 'meta'));
      li.appendChild(right);
      list.appendChild(li);
    }
  }

  // ---- Status, phone, kill switch ----
  async function renderStatus() {
    const info = await api.call('app.info');
    $('model-status').textContent = info.modelHealth.ok
      ? `${info.model} · ready`
      : `${info.model} · offline`;
    $('pause-status').textContent = info.paused ? 'PAUSED — all actions blocked' : '';
    $('pause-btn').textContent = info.paused ? 'Resume actions' : 'Pause all actions';
    $('pause-btn').className = info.paused ? 'btn primary wide' : 'btn danger wide';
    $('pause-btn').dataset.paused = info.paused ? '1' : '';
    $('companion-url').textContent = info.companionUrl || info.companionError;
    $('companion-token').textContent = info.companionToken;
  }

  $('pause-btn').addEventListener('click', async () => {
    const paused = $('pause-btn').dataset.paused === '1';
    await api.call(paused ? 'system.resume' : 'system.pause');
    refreshAll();
  });

  function refreshAll() {
    renderGreeting();
    const jobs = [renderStatus(), renderApprovals(), renderToday()];
    const views = {
      today: renderToday,
      chat: renderChat,
      schedule: renderSchedule,
      tasks: renderTasks,
      widgets: renderWidgets,
      approvals: renderApprovals,
      memory: renderMemory,
      activity: renderAudit,
      phone: async () => {},
    };
    jobs.push(views[currentView]());
    return Promise.all(jobs).catch((err) => toast(err.message, true));
  }

  // Live updates: the main process pushes every bus event here.
  api.onEvent((event) => {
    if (event.type === 'calendar.changed' && event.payload && event.payload.conflicts) {
      const { event: changed, conflicts, suggestion } = event.payload;
      if (conflicts.length) {
        const names = conflicts.map((c) => `"${c.title}"`).join(', ');
        const hint = suggestion ? ` Suggested: ${fmt(suggestion.startAt)}.` : '';
        toast(`Conflict: "${changed.title}" overlaps ${names}.${hint}`, true);
      }
    }
    if (event.type === 'approval.requested' || event.type === 'approval.resolved') renderApprovals();
    if (event.type === 'calendar.changed' && currentView === 'schedule') renderSchedule();
    if (event.type === 'tasks.changed' && currentView === 'tasks') renderTasks();
    if (event.type === 'memory.added' && currentView === 'memory') renderMemory();
    if (event.type === 'message.added') {
      if (currentView === 'chat') renderChat();
    }
    if (event.type === 'widgets.changed' && currentView === 'widgets') renderWidgets();
    if (event.type === 'audit.recorded' && currentView === 'activity') renderAudit();
    if (event.type === 'system.paused' || event.type === 'system.resumed') renderStatus();
  });

  refreshAll();
})();
