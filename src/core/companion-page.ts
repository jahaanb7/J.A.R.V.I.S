/** Mobile page served at GET / by the companion server. Pairing token is kept in localStorage. */
export const COMPANION_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark light" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<title>Buffy</title>
<style>
  :root {
    --bg: #0e1015; --surface: #161920; --surface-2: #1d212b; --text: #e8eaf0; --muted: #8b93a4;
    --border: rgba(255,255,255,.07); --accent: #818cf8; --accent-2: #c084fc;
    --ok: #34d399; --warn: #fbbf24; --danger: #f87171;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-size: 15px;
    padding: max(14px, env(safe-area-inset-top)) 14px 40px; -webkit-font-smoothing: antialiased; }
  header { display: flex; align-items: center; justify-content: space-between; margin: 4px 2px 14px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .logo { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; font-weight: 700; color: white;
    background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 6px 16px rgba(129,140,248,.35); }
  .brand-name { font-size: 18px; font-weight: 700; letter-spacing: -.01em; }
  .status { font-size: 12px; color: var(--muted); }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); margin-right: 6px; vertical-align: middle; }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--danger); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 14px; margin-bottom: 12px; }
  .card-title { font-size: 11px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
  .briefing { line-height: 1.55; margin: 0; }
  input { width: 100%; padding: 12px 13px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text); font-size: 16px; outline: none; }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(129,140,248,.18); }
  button { padding: 12px 16px; border-radius: 12px; border: 0; color: white; font-size: 15px; font-weight: 600; cursor: pointer;
    background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
  button.ghost { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
  button.danger { background: transparent; color: var(--danger); border: 1px solid rgba(248,113,113,.4); }
  button:active { transform: scale(.98); }
  .row { display: flex; gap: 8px; align-items: center; }
  .row input { flex: 1; }
  .chat { display: flex; flex-direction: column; gap: 8px; max-height: 52vh; overflow-y: auto; padding: 2px 0 10px; }
  .bubble { max-width: 82%; padding: 10px 13px; border-radius: 16px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
  .bubble.user { align-self: flex-end; color: white; background: linear-gradient(135deg, var(--accent), var(--accent-2)); border-bottom-right-radius: 5px; }
  .bubble.assistant { align-self: flex-start; background: var(--surface-2); border-bottom-left-radius: 5px; }
  .bubble.error { align-self: flex-start; color: var(--danger); background: rgba(248,113,113,.1); }
  .item { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .item:last-child { border-bottom: 0; }
  .item-title { font-weight: 550; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .empty { color: var(--muted); font-size: 14px; padding: 4px 0; }
  .actions { display: flex; gap: 8px; margin-top: 10px; }
  .actions button { flex: 1; padding: 10px; font-size: 14px; }
  .safety { display: flex; gap: 8px; }
  .safety button { flex: 1; }
  .toast { position: fixed; left: 14px; right: 14px; bottom: max(14px, env(safe-area-inset-bottom)); padding: 12px 14px; border-radius: 12px;
    background: var(--surface-2); border: 1px solid var(--border); font-size: 14px; opacity: 0; transform: translateY(8px); transition: .18s; pointer-events: none; }
  .toast.show { opacity: 1; transform: none; }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <div class="brand"><div class="logo">B</div><div><div class="brand-name">Buffy</div><div class="status" id="status"><span class="dot" id="dot"></span><span id="status-text">Not connected</span></div></div></div>
</header>

<div class="card" id="pair-card">
  <h2 class="card-title">Pair with your Mac</h2>
  <div class="row"><input id="token" type="password" placeholder="Pairing token from the desktop app" autocomplete="off" /><button id="save" class="ghost">Save</button></div>
</div>

<div id="app" class="hidden">
  <section class="card">
    <h2 class="card-title">Today</h2>
    <p class="briefing" id="briefing">Loading…</p>
  </section>

  <section class="card">
    <h2 class="card-title">Chat</h2>
    <div class="chat" id="chat"></div>
    <div class="row" style="margin-top:10px"><input id="text" placeholder="Ask Buffy or give a command" autocomplete="off" /><button id="send">Send</button></div>
  </section>

  <section class="card">
    <h2 class="card-title">Waiting for you</h2>
    <div id="approvals"></div>
  </section>

  <section class="card">
    <h2 class="card-title">Next 24 hours</h2>
    <div id="schedule"></div>
  </section>

  <section class="card">
    <h2 class="card-title">Open tasks</h2>
    <div id="tasks"></div>
  </section>

  <section class="card">
    <h2 class="card-title">Safety</h2>
    <div class="safety"><button id="pause" class="danger">Pause everything</button><button id="resume" class="ghost">Resume</button></div>
  </section>
</div>

<div class="toast" id="toast"></div>

<script>
(function () {
  var token = localStorage.getItem('buffy-token') || '';
  var $ = function (id) { return document.getElementById(id); };
  $('token').value = token;

  var toastTimer = null;
  function toast(text) {
    var box = $('toast');
    box.textContent = text;
    box.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.className = 'toast'; }, 3000);
  }

  function setStatus(text, state) {
    $('status-text').textContent = text;
    $('dot').className = 'dot ' + (state || '');
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'authorization': 'Bearer ' + token, 'content-type': 'application/json' }, options.headers || {});
    return fetch(path, options).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
        return body;
      });
    });
  }

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }

  function fmt(iso) {
    return new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function renderBriefing() {
    return api('/api/briefing').then(function (b) { $('briefing').textContent = b.summary; });
  }

  function renderSchedule() {
    var from = new Date().toISOString();
    var to = new Date(Date.now() + 86400000).toISOString();
    return api('/api/schedule?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)).then(function (b) {
      var box = $('schedule'); box.replaceChildren();
      if (!b.events.length) box.appendChild(el('div', 'Nothing scheduled.', 'empty'));
      b.events.forEach(function (e) {
        var item = el('div', undefined, 'item');
        item.appendChild(el('div', e.title, 'item-title'));
        item.appendChild(el('div', fmt(e.startAt), 'meta'));
        box.appendChild(item);
      });
    });
  }

  function renderApprovals() {
    return api('/api/approvals').then(function (b) {
      var box = $('approvals'); box.replaceChildren();
      if (!b.approvals.length) box.appendChild(el('div', 'Nothing waiting for you.', 'empty'));
      b.approvals.forEach(function (a) {
        var item = el('div', undefined, 'item');
        item.appendChild(el('div', a.description, 'item-title'));
        var row = el('div', undefined, 'actions');
        var ok = el('button', 'Approve'); ok.onclick = function () { decide(a.id, 'approve'); };
        var no = el('button', 'Deny', 'ghost'); no.onclick = function () { decide(a.id, 'deny'); };
        row.appendChild(no); row.appendChild(ok);
        item.appendChild(row);
        box.appendChild(item);
      });
    });
  }

  function decide(id, action) {
    api('/api/approvals/' + id + '/' + action, { method: 'POST', body: '{}' })
      .then(function () { toast(action === 'approve' ? 'Approved' : 'Declined'); return renderApprovals(); })
      .catch(function (err) { toast(err.message); });
  }

  function renderTasks() {
    return api('/api/tasks').then(function (b) {
      var box = $('tasks'); box.replaceChildren();
      if (!b.tasks.length) box.appendChild(el('div', 'No open tasks.', 'empty'));
      b.tasks.forEach(function (t) {
        var item = el('div', undefined, 'item');
        item.appendChild(el('div', t.title, 'item-title'));
        item.appendChild(el('div', 'Priority ' + t.priority, 'meta'));
        box.appendChild(item);
      });
    });
  }

  function addMessage(role, text) {
    var box = $('chat');
    var cls = role === 'You' ? 'user' : role === 'Error' ? 'error' : 'assistant';
    box.appendChild(el('div', text, 'bubble ' + cls));
    box.scrollTop = box.scrollHeight;
  }

  function refreshAll() {
    return Promise.all([renderBriefing(), renderSchedule(), renderApprovals(), renderTasks()])
      .then(function () { setStatus('Connected', 'ok'); })
      .catch(function (err) { setStatus(err.message, 'bad'); });
  }

  function showApp(on) {
    $('app').className = on ? '' : 'hidden';
    $('pair-card').className = on ? 'card hidden' : 'card';
  }

  $('save').onclick = function () {
    token = $('token').value.trim();
    localStorage.setItem('buffy-token', token);
    showApp(!!token);
    refreshAll();
  };

  $('send').onclick = function () {
    var text = $('text').value.trim();
    if (!text) return;
    $('text').value = '';
    addMessage('You', text);
    api('/api/chat', { method: 'POST', body: JSON.stringify({ text: text }) })
      .then(function (b) { addMessage('Buffy', b.reply); return refreshAll(); })
      .catch(function (err) { addMessage('Error', err.message); });
  };
  $('text').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('send').click(); });

  $('pause').onclick = function () { api('/api/pause', { method: 'POST', body: '{}' }).then(function () { toast('Everything is paused'); }); };
  $('resume').onclick = function () { api('/api/resume', { method: 'POST', body: '{}' }).then(function () { toast('Resumed'); }); };

  if (token) { showApp(true); refreshAll(); }
  else { setStatus('Enter the pairing token from the desktop app', ''); }
})();
</script>
</body>
</html>
`;
