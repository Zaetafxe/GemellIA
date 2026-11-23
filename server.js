// VisitorIA — servidor MVP (Node 22+ sin dependencias externas)
// Ejecuta:  node server.js   ->  http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const PING_TIMEOUT_MS = 60_000;   // sin señal 60 s => visita cerrada
const CONVERSATION_MS = 120_000;  // >= 2 min cuenta como "conversación"
const RSSI_MIN = -80;             // señal BLE mínima para considerar "cerca" (~3-5 m)

const db = new DatabaseSync(path.join(__dirname, 'visitoria.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, date TEXT NOT NULL, venue TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS exhibitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, company TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exhibitor_id INTEGER NOT NULL REFERENCES exhibitors(id),
    visitor_id TEXT NOT NULL REFERENCES visitors(id),
    started_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS ix_visits_ex ON visits(exhibitor_id);
  CREATE INDEX IF NOT EXISTS ix_visits_vi ON visits(visitor_id);
`);
// Migración: fuente de la visita (qr | ble) e intensidad de señal Bluetooth
const visitCols = db.prepare('PRAGMA table_info(visits)').all().map((c) => c.name);
if (!visitCols.includes('source')) db.exec("ALTER TABLE visits ADD COLUMN source TEXT NOT NULL DEFAULT 'qr'");
if (!visitCols.includes('rssi_sum')) db.exec('ALTER TABLE visits ADD COLUMN rssi_sum REAL NOT NULL DEFAULT 0');
if (!visitCols.includes('rssi_n')) db.exec('ALTER TABLE visits ADD COLUMN rssi_n INTEGER NOT NULL DEFAULT 0');

// ---------- utilidades ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!db.prepare('SELECT 1 FROM exhibitors WHERE code = ?').get(c)) return c;
  }
}
const clean = (s, max = 120) => String(s ?? '').trim().slice(0, max);
const now = () => Date.now();

// Cierra visitas abiertas cuyo último ping es viejo
function closeStale() {
  const cutoff = now() - PING_TIMEOUT_MS;
  db.prepare('UPDATE visits SET ended_at = last_seen WHERE ended_at IS NULL AND last_seen < ?').run(cutoff);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) break; }
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ---------- API ----------
const routes = {
  'GET /api/events': () => db.prepare(`
      SELECT e.*, (SELECT COUNT(*) FROM exhibitors x WHERE x.event_id = e.id) AS exhibitors
      FROM events e ORDER BY e.date DESC, e.id DESC`).all(),

  'POST /api/events': (b) => {
    const name = clean(b.name), date = clean(b.date, 10) || new Date().toISOString().slice(0, 10);
    if (!name) throw { status: 400, error: 'El nombre del evento es obligatorio' };
    const r = db.prepare('INSERT INTO events (name, date, venue, created_at) VALUES (?,?,?,?)')
      .run(name, date, clean(b.venue) || null, now());
    return db.prepare('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid);
  },

  'POST /api/exhibitors': (b) => {
    const eventId = Number(b.eventId), name = clean(b.name);
    if (!name) throw { status: 400, error: 'El nombre del expositor es obligatorio' };
    if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) throw { status: 404, error: 'Evento no encontrado' };
    const code = newCode();
    db.prepare('INSERT INTO exhibitors (event_id, code, name, company, created_at) VALUES (?,?,?,?,?)')
      .run(eventId, code, name, clean(b.company) || null, now());
    return exhibitorByCode(code);
  },

  'GET /api/exhibitor': (_b, q) => {
    const ex = exhibitorByCode(clean(q.get('code'), 6).toUpperCase());
    if (!ex) throw { status: 404, error: 'Código de expositor no válido' };
    closeStale();
    ex.live = db.prepare('SELECT COUNT(*) n FROM visits WHERE exhibitor_id = ? AND ended_at IS NULL').get(ex.id).n;
    const t = db.prepare(`SELECT COUNT(*) visits, COUNT(DISTINCT visitor_id) people,
        COALESCE(SUM(COALESCE(ended_at,last_seen) - started_at),0) ms
        FROM visits WHERE exhibitor_id = ?`).get(ex.id);
    Object.assign(ex, t);
    ex.current = db.prepare(`SELECT v.name, s.started_at FROM visits s JOIN visitors v ON v.id = s.visitor_id
        WHERE s.exhibitor_id = ? AND s.ended_at IS NULL ORDER BY s.started_at`).all(ex.id);
    return ex;
  },

  // El visitante se enlaza a un expositor
  'POST /api/visits/start': (b) => {
    const ex = exhibitorByCode(clean(b.code, 6).toUpperCase());
    if (!ex) throw { status: 404, error: 'Código de expositor no válido' };
    const vid = clean(b.visitorId, 64), vname = clean(b.visitorName);
    if (!vid || !vname) throw { status: 400, error: 'Falta el nombre del participante' };
    db.prepare(`INSERT INTO visitors (id, name, company, created_at) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, company = excluded.company`)
      .run(vid, vname, clean(b.visitorCompany) || null, now());
    closeStale();
    // Si ya tenía una visita abierta con este expositor, se reanuda
    const open = db.prepare('SELECT id FROM visits WHERE visitor_id = ? AND exhibitor_id = ? AND ended_at IS NULL').get(vid, ex.id);
    // Una persona solo puede estar con un expositor a la vez
    db.prepare('UPDATE visits SET ended_at = last_seen WHERE visitor_id = ? AND ended_at IS NULL AND exhibitor_id <> ?').run(vid, ex.id);
    if (open) return { visitId: open.id, exhibitor: ex, resumed: true };
    const t = now();
    const r = db.prepare('INSERT INTO visits (exhibitor_id, visitor_id, started_at, last_seen) VALUES (?,?,?,?)').run(ex.id, vid, t, t);
    return { visitId: Number(r.lastInsertRowid), exhibitor: ex, resumed: false };
  },

  'POST /api/visits/ping': (b) => {
    const v = db.prepare('SELECT * FROM visits WHERE id = ? AND visitor_id = ?').get(Number(b.visitId), clean(b.visitorId, 64));
    if (!v) throw { status: 404, error: 'Visita no encontrada' };
    if (v.ended_at) return { active: false };
    db.prepare('UPDATE visits SET last_seen = ? WHERE id = ?').run(now(), v.id);
    return { active: true, elapsed: now() - v.started_at };
  },

  'POST /api/visits/end': (b) => {
    db.prepare('UPDATE visits SET last_seen = ?, ended_at = ? WHERE id = ? AND visitor_id = ? AND ended_at IS NULL')
      .run(now(), now(), Number(b.visitId), clean(b.visitorId, 64));
    return { ok: true };
  },

  // Avistamientos Bluetooth: la app del participante reporta cada ~10 s los stands que detecta.
  // readings: [{ code, rssi }]  (rssi en dBm, p. ej. -60 = muy cerca, -85 = lejos)
  'POST /api/sightings': (b) => {
    const vid = clean(b.visitorId, 64), vname = clean(b.visitorName);
    if (!vid || !vname) throw { status: 400, error: 'Falta el participante' };
    db.prepare(`INSERT INTO visitors (id, name, company, created_at) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, company = excluded.company`)
      .run(vid, vname, clean(b.visitorCompany) || null, now());
    closeStale();
    // Solo cuenta el stand con la señal más fuerte y por encima del umbral
    const readings = (Array.isArray(b.readings) ? b.readings : [])
      .map((r) => ({ code: clean(r.code, 6).toUpperCase(), rssi: Number(r.rssi) }))
      .filter((r) => r.code && Number.isFinite(r.rssi) && r.rssi >= RSSI_MIN)
      .sort((a, b) => b.rssi - a.rssi);
    let best = null;
    for (const r of readings) { const ex = exhibitorByCode(r.code); if (ex) { best = { ...r, ex }; break; } }
    if (!best) return { active: false };
    const t = now();
    const open = db.prepare('SELECT * FROM visits WHERE visitor_id = ? AND exhibitor_id = ? AND ended_at IS NULL').get(vid, best.ex.id);
    db.prepare('UPDATE visits SET ended_at = last_seen WHERE visitor_id = ? AND ended_at IS NULL AND exhibitor_id <> ?').run(vid, best.ex.id);
    if (open) {
      db.prepare('UPDATE visits SET last_seen = ?, rssi_sum = rssi_sum + ?, rssi_n = rssi_n + 1 WHERE id = ?').run(t, best.rssi, open.id);
      return { active: true, visitId: open.id, exhibitor: best.ex, elapsed: t - open.started_at };
    }
    const r = db.prepare(`INSERT INTO visits (exhibitor_id, visitor_id, started_at, last_seen, source, rssi_sum, rssi_n)
        VALUES (?,?,?,?, 'ble', ?, 1)`).run(best.ex.id, vid, t, t, best.rssi);
    return { active: true, visitId: Number(r.lastInsertRowid), exhibitor: best.ex, elapsed: 0 };
  },

  // Indicadores para el tablero
  'GET /api/stats': (_b, q) => {
    closeStale();
    const eventId = Number(q.get('eventId'));
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) throw { status: 404, error: 'Evento no encontrado' };
    const visits = db.prepare(`
      SELECT s.id, s.started_at, COALESCE(s.ended_at, s.last_seen) AS end_at, s.ended_at IS NULL AS live,
             s.source, CASE WHEN s.rssi_n > 0 THEN ROUND(s.rssi_sum / s.rssi_n) END AS rssi,
             x.id AS exhibitor_id, x.name AS exhibitor, x.company AS exhibitor_company, x.code,
             v.id AS visitor_id, v.name AS visitor, v.company AS visitor_company
      FROM visits s JOIN exhibitors x ON x.id = s.exhibitor_id JOIN visitors v ON v.id = s.visitor_id
      WHERE x.event_id = ? ORDER BY s.started_at`).all(eventId);
    const exhibitors = db.prepare('SELECT id, code, name, company FROM exhibitors WHERE event_id = ? ORDER BY name').all(eventId);
    return { event, exhibitors, visits, conversationMs: CONVERSATION_MS, serverTime: now() };
  },

  // Datos de demostración para ver el tablero lleno
  'POST /api/demo': () => seedDemo(),
};

function exhibitorByCode(code) {
  return db.prepare(`SELECT x.id, x.code, x.name, x.company, x.event_id, e.name AS event_name, e.date AS event_date
     FROM exhibitors x JOIN events e ON e.id = x.event_id WHERE x.code = ?`).get(code);
}

function seedDemo() {
  const t0 = new Date(); t0.setHours(10, 0, 0, 0);
  const start = t0.getTime() - 86400000; // ayer 10:00
  const ev = routes['POST /api/events']({ name: 'Expo Innovación TI (demo)', date: new Date(start).toISOString().slice(0, 10), venue: 'Centro de Convenciones' });
  const names = [['Nube Segura', 'CloudSec'], ['DataViva', 'Analytics MX'], ['RoboLab', 'Automatiza'], ['FinTech Plus', 'PagoFácil'],
    ['IA Aplicada', 'NeuroSoft'], ['GreenTech', 'Solaria'], ['EduDigital', 'Aula 360'], ['Salud Conectada', 'MediNet']];
  const pull = [1.6, 1.3, 1.1, 0.7, 1.9, 0.5, 0.8, 1.0]; // atractivo relativo
  const exs = names.map(([n, c]) => routes['POST /api/exhibitors']({ eventId: ev.id, name: n, company: c }));
  const first = ['Ana', 'Luis', 'María', 'Carlos', 'Sofía', 'Jorge', 'Lucía', 'Diego', 'Valeria', 'Miguel', 'Fernanda', 'Andrés', 'Paola', 'Ricardo', 'Daniela', 'Héctor', 'Camila', 'Pablo', 'Regina', 'Iván'];
  const last = ['García', 'López', 'Martínez', 'Hernández', 'Pérez', 'Ramírez', 'Torres', 'Flores', 'Gómez', 'Díaz'];
  const insV = db.prepare('INSERT OR IGNORE INTO visitors (id, name, company, created_at) VALUES (?,?,?,?)');
  const insS = db.prepare(`INSERT INTO visits (exhibitor_id, visitor_id, started_at, last_seen, ended_at, source, rssi_sum, rssi_n)
      VALUES (?,?,?,?,?,?,?,?)`);
  const totalPull = pull.reduce((a, b) => a + b, 0);
  for (let p = 0; p < 120; p++) {
    const vid = `demo-${ev.id}-${p}`;
    insV.run(vid, `${first[p % 20]} ${last[(Math.floor(p / 20) * 3 + p) % 10]}`, null, start);
    let t = start + Math.random() * 6 * 3600e3; // llega entre 10:00 y 16:00
    const stops = 1 + Math.floor(Math.random() * 5);
    for (let s = 0; s < stops; s++) {
      let r = Math.random() * totalPull, i = 0;
      while ((r -= pull[i]) > 0) i++;
      const dur = Math.max(15e3, -Math.log(Math.random()) * 150e3 * pull[i]); // exponencial
      const ble = Math.random() < 0.7, rssi = -55 - Math.random() * 25;
      insS.run(exs[i].id, vid, Math.round(t), Math.round(t + dur), Math.round(t + dur), ble ? 'ble' : 'qr', ble ? rssi : 0, ble ? 1 : 0);
      t += dur + Math.random() * 15 * 60e3;
    }
  }
  return ev;
}

// ---------- servidor estático + API ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  if (routes[key]) {
    try { send(res, 200, routes[key](req.method === 'POST' ? await body(req) : {}, url.searchParams)); }
    catch (e) { e.status ? send(res, e.status, { error: e.error }) : (console.error(e), send(res, 500, { error: 'Error interno' })); }
    return;
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`\n  VisitorIA corriendo`);
  console.log(`  Local:    http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Celular:  http://${ip}:${PORT}   (misma red Wi-Fi)`));
  console.log(`  Tablero:  http://localhost:${PORT}/dashboard.html\n`);
});
