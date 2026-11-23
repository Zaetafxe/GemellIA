// VisitorIA — app móvil (expositor + participante)
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem('vi.' + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('vi.' + k) : localStorage.setItem('vi.' + k, v); } catch {} },
};
async function api(path, data) {
  const r = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Error de conexión');
  return j;
}
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let timers = [];
function show(view) {
  timers.forEach(clearInterval); timers = [];
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('hidden', s.id !== view));
  if (view === 'v-ex-setup') loadEvents();
  if (view === 'v-vi-setup') { $('vi-name').value = store.get('name') || ''; $('vi-company').value = store.get('company') || ''; }
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

// ---------- Expositor ----------
async function loadEvents() {
  const evs = await api('/api/events').catch(() => []);
  $('ex-event').innerHTML = evs.map((e) => `<option value="${e.id}">${esc(e.name)} · ${e.date}</option>`).join('')
    + '<option value="new">+ Crear evento nuevo</option>';
  if (!evs.length) $('ex-event').value = 'new';
  toggleNewEvent();
  $('ev-date').value ||= new Date().toISOString().slice(0, 10);
}
const toggleNewEvent = () => $('new-event').classList.toggle('hidden', $('ex-event').value !== 'new');
$('ex-event').addEventListener('change', toggleNewEvent);

$('ex-create').addEventListener('click', async () => {
  $('ex-err').textContent = '';
  try {
    let eventId = $('ex-event').value;
    if (eventId === 'new') {
      const ev = await api('/api/events', { name: $('ev-name').value, date: $('ev-date').value, venue: $('ev-venue').value });
      eventId = ev.id;
    }
    const ex = await api('/api/exhibitors', { eventId, name: $('ex-name').value, company: $('ex-company').value });
    store.set('exCode', ex.code);
    openStand(ex.code);
  } catch (e) { $('ex-err').textContent = e.message; }
});
$('ex-open').addEventListener('click', () => openStand($('ex-code').value.trim().toUpperCase()));
$('exl-exit').addEventListener('click', () => { store.set('exCode', null); show('v-ex-setup'); });

async function openStand(code) {
  try {
    const ex = await api('/api/exhibitor?code=' + encodeURIComponent(code));
    store.set('exCode', code);
    show('v-ex-live');
    $('exl-name').textContent = ex.name + (ex.company ? ` · ${ex.company}` : '');
    $('exl-event').textContent = `${ex.event_name} · ${ex.event_date}`;
    $('exl-code').textContent = ex.code;
    const qr = qrcode(0, 'M');
    qr.addData(`${location.origin}/?c=${ex.code}`);
    qr.make();
    $('exl-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    renderStand(ex);
    timers.push(setInterval(async () => renderStand(await api('/api/exhibitor?code=' + code).catch(() => ex)), 5000));
    keepAwake();
  } catch (e) { $('ex-err').textContent = e.message; show('v-ex-setup'); }
}
function renderStand(ex) {
  $('exl-live').textContent = ex.live;
  $('exl-people').textContent = ex.people;
  $('exl-min').textContent = Math.round(ex.ms / 60000);
  $('exl-current').innerHTML = ex.current.length
    ? ex.current.map((c) => `<li><span>${esc(c.name)}</span><span class="hint">${fmt(Date.now() - c.started_at)}</span></li>`).join('')
    : '<li class="hint">Aún no hay participantes enlazados</li>';
}

// ---------- Participante ----------
function visitorId() {
  let id = store.get('vid');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    store.set('vid', id);
  }
  return id;
}
$('vi-start').addEventListener('click', () => startVisit($('vi-code').value.trim().toUpperCase()));

let visit = null;
async function startVisit(code) {
  $('vi-err').textContent = '';
  const name = $('vi-name').value.trim() || store.get('name');
  if (!name) { show('v-vi-setup'); $('vi-code').value = code; $('vi-err').textContent = 'Escribe tu nombre para enlazarte'; $('vi-name').focus(); return; }
  if ($('vi-name').value.trim()) { store.set('name', $('vi-name').value.trim()); store.set('company', $('vi-company').value.trim()); }
  try {
    const r = await api('/api/visits/start', { code, visitorId: visitorId(), visitorName: store.get('name'), visitorCompany: store.get('company') });
    visit = { id: r.visitId, code, started: Date.now(), ex: r.exhibitor };
    store.set('visit', JSON.stringify(visit));
    show('v-vi-live');
    $('vil-name').textContent = r.exhibitor.name;
    $('vil-event').textContent = r.exhibitor.event_name;
    setLive(true);
    if (r.resumed) ping(); // sincroniza el cronómetro con el servidor
    timers.push(setInterval(() => { $('vil-timer').textContent = fmt(Date.now() - visit.started); }, 1000));
    timers.push(setInterval(ping, 15000));
    keepAwake();
  } catch (e) { show('v-vi-setup'); $('vi-code').value = code; $('vi-err').textContent = e.message; }
}
async function ping() {
  if (!visit) return;
  const r = await api('/api/visits/ping', { visitId: visit.id, visitorId: visitorId() }).catch(() => null);
  if (r && !r.active) setLive(false);
  if (r && r.active) visit.started = Date.now() - r.elapsed;
}
function setLive(on) {
  $('vil-status').textContent = on ? 'Enlazado con' : 'Visita cerrada por inactividad';
  $('vil-end').classList.toggle('hidden', !on);
  $('vil-resume').classList.toggle('hidden', on);
}
$('vil-resume').addEventListener('click', () => startVisit(visit.code));
$('vil-end').addEventListener('click', async () => {
  await api('/api/visits/end', { visitId: visit.id, visitorId: visitorId() }).catch(() => {});
  visit = null; store.set('visit', null);
  $('vi-code').value = '';
  show('v-vi-setup');
});
// Al volver a la app, se manda señal de inmediato
document.addEventListener('visibilitychange', () => { if (!document.hidden && visit) { ping(); keepAwake(); } });

// Evita que la pantalla se apague (solo HTTPS / localhost)
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } } catch {}
}

// ---------- Arranque ----------
const qsCode = new URLSearchParams(location.search).get('c');
if (qsCode) {
  history.replaceState(null, '', '/');
  if (store.get('name')) startVisit(qsCode.toUpperCase());
  else { show('v-vi-setup'); $('vi-code').value = qsCode.toUpperCase(); }
} else if (store.get('visit')) {
  try { const v = JSON.parse(store.get('visit')); startVisit(v.code); } catch { show('v-home'); }
} else if (store.get('exCode')) {
  openStand(store.get('exCode'));
} else show('v-home');
