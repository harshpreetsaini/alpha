'use strict';

/**
 * Minecraft Bedrock Server Panel - Backend
 * A production-grade Node.js server panel for managing a Bedrock dedicated server.
 * Features: Console, File Manager, Addons, Settings, Players, Tunnel, Backups
 */

const express      = require('express');
const session      = require('express-session');
const cookieParser = require('cookie-parser');
const http         = require('http');
const path         = require('path');
const fs           = require('fs');
const { exec, spawn, execSync } = require('child_process');
const WebSocket    = require('ws');
const multer       = require('multer');
const archiver     = require('archiver');

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────
const CONFIG = {
  PORT            : process.env.PORT || 3000,
  SESSION_SECRET  : 'mc-panel-secret-' + Math.random().toString(36).slice(2),
  DEFAULT_PASS    : 'admin',          // First-run password — setup page forces change
  CONSOLE_HISTORY : 500,              // Lines kept in memory
  STOP_TIMEOUT_MS : 12000,            // ms before force-killing after "stop"
  BACKUP_ON_STOP  : true,
};

const BASE_DIR      = __dirname;
const SERVER_DIR    = path.join(BASE_DIR, 'server');
const BACKUPS_DIR   = path.join(BASE_DIR, 'backups');
const PUBLIC_DIR    = path.join(BASE_DIR, 'public');
const USERS_FILE    = path.join(BASE_DIR, 'users.json');
const TUNNEL_FILE   = path.join(BASE_DIR, 'tunnel_secret.json');
const EULA_FILE     = path.join(SERVER_DIR, 'eula.txt');
const ALLOWLIST_FILE= path.join(SERVER_DIR, 'allowlist.json');
const PERMS_FILE    = path.join(SERVER_DIR, 'permissions.json');
const PROPS_FILE    = path.join(SERVER_DIR, 'server.properties');

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let serverProcess   = null;
let serverStatus    = 'stopped';   // 'starting' | 'running' | 'stopping' | 'stopped'
let consoleHistory  = [];          // Last N lines
let onlinePlayers   = [];          // { name, xuid }
let tunnelProcess   = null;
let tunnelStatus    = 'stopped';   // 'starting' | 'running' | 'stopped'
let stopRequested   = false;       // Flag: stop triggered by panel (triggers auto-backup)

// ─────────────────────────────────────────────
// HELPERS — File system utils
// ─────────────────────────────────────────────
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function safeReadJSON(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeWriteJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Validate that a requested path stays inside SERVER_DIR
 * (prevents path-traversal attacks)
 */
function safePath(rel) {
  const resolved = path.resolve(SERVER_DIR, rel || '');
  if (!resolved.startsWith(SERVER_DIR)) {
    throw new Error('Path traversal denied');
  }
  return resolved;
}

// ─────────────────────────────────────────────
// EULA
// ─────────────────────────────────────────────
function ensureEula() {
  ensureDir(SERVER_DIR);
  try {
    fs.writeFileSync(EULA_FILE, 'eula=true\n', 'utf8');
  } catch (e) {
    console.error('[Panel] Could not write eula.txt:', e.message);
  }
}

// ─────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────
function loadUsers() {
  return safeReadJSON(USERS_FILE, { setupDone: false, users: [] });
}

function saveUsers(data) {
  safeWriteJSON(USERS_FILE, data);
}

function findUser(username, password) {
  const data = loadUsers();
  if (!data.setupDone) {
    // Pre-setup: any login with default pass works
    if (password === CONFIG.DEFAULT_PASS) return { username: 'admin', role: 'admin', setupDone: false };
    return null;
  }
  return data.users.find(u => u.username === username && u.password === password) || null;
}

function isSetupDone() {
  return loadUsers().setupDone;
}

// ─────────────────────────────────────────────
// BROADCAST to all WebSocket clients
// ─────────────────────────────────────────────
let wsClients = new Set();

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch {}
    }
  });
}

function pushLog(line) {
  consoleHistory.push(line);
  if (consoleHistory.length > CONFIG.CONSOLE_HISTORY) {
    consoleHistory = consoleHistory.slice(-CONFIG.CONSOLE_HISTORY);
  }
  broadcast('log', { line });
}

function pushStatus(status, extra = {}) {
  serverStatus = status;
  broadcast('status', { status, ...extra });
}

// ─────────────────────────────────────────────
// PLAYER TRACKING from log lines
// ─────────────────────────────────────────────
function trackPlayer(line) {
  // Connected: "Player connected: <name>, xuid: <xuid>"
  const connectMatch = line.match(/Player connected:\s+([^,]+),\s+xuid:\s+(\d+)/);
  if (connectMatch) {
    const name = connectMatch[1].trim();
    const xuid = connectMatch[2].trim();
    if (!onlinePlayers.find(p => p.xuid === xuid)) {
      onlinePlayers.push({ name, xuid });
    }
    broadcast('players', { players: onlinePlayers });
    return;
  }

  // Disconnected: "Player disconnected: <name>, xuid: <xuid>"
  const disconnectMatch = line.match(/Player disconnected:\s+([^,]+),\s+xuid:\s+(\d+)/);
  if (disconnectMatch) {
    const xuid = disconnectMatch[2].trim();
    onlinePlayers = onlinePlayers.filter(p => p.xuid !== xuid);
    broadcast('players', { players: onlinePlayers });
  }
}

// ─────────────────────────────────────────────
// MINECRAFT SERVER PROCESS
// ─────────────────────────────────────────────
function killExistingBedrock(cb) {
  exec("pkill -f bedrock_server 2>/dev/null; sleep 0.5", () => cb());
}

function startServer() {
  if (serverProcess) {
    pushLog('[Panel] Server is already running.');
    return;
  }
  pushStatus('starting');
  pushLog('[Panel] Starting Bedrock server…');

  killExistingBedrock(() => {
    const binaryPath = path.join(SERVER_DIR, 'bedrock_server');
    if (!fs.existsSync(binaryPath)) {
      pushLog('[Panel] ERROR: bedrock_server binary not found in server/ folder!');
      pushStatus('stopped');
      return;
    }

    // Ensure executable
    try { fs.chmodSync(binaryPath, 0o755); } catch {}

    serverProcess = spawn('./bedrock_server', [], {
      cwd  : SERVER_DIR,
      env  : { ...process.env, LD_LIBRARY_PATH: SERVER_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', data => {
      data.toString().split('\n').forEach(line => {
        if (!line.trim()) return;
        pushLog(line);
        if (line.includes('Server started')) pushStatus('running');
        trackPlayer(line);
      });
    });

    serverProcess.stderr.on('data', data => {
      data.toString().split('\n').forEach(line => {
        if (!line.trim()) return;
        pushLog('[ERR] ' + line);
      });
    });

    serverProcess.on('error', err => {
      pushLog('[Panel] Process error: ' + err.message);
      pushStatus('stopped');
      serverProcess = null;
    });

    serverProcess.on('exit', async (code, signal) => {
      const triggered = stopRequested;
      stopRequested = false;
      onlinePlayers = [];
      serverProcess = null;
      pushLog(`[Panel] Server exited (code ${code}, signal ${signal})`);
      pushStatus('stopped');
      broadcast('players', { players: [] });

      if (triggered && CONFIG.BACKUP_ON_STOP) {
        pushLog('[Panel] Auto-backup triggered…');
        try {
          await createBackup();
          pushLog('[Panel] Auto-backup complete.');
        } catch (e) {
          pushLog('[Panel] Auto-backup failed: ' + e.message);
        }
      }
    });
  });
}

function stopServer(forceKill = false) {
  if (!serverProcess) {
    pushLog('[Panel] Server is not running.');
    return;
  }

  if (forceKill) {
    pushLog('[Panel] Force-killing server…');
    pushStatus('stopping');
    serverProcess.kill('SIGKILL');
    return;
  }

  pushLog('[Panel] Stopping server gracefully…');
  pushStatus('stopping');
  stopRequested = true;

  try { serverProcess.stdin.write('stop\n'); } catch {}

  const timeout = setTimeout(() => {
    if (serverProcess) {
      pushLog('[Panel] Server did not exit in time — force killing.');
      serverProcess.kill('SIGKILL');
    }
  }, CONFIG.STOP_TIMEOUT_MS);

  serverProcess.once('exit', () => clearTimeout(timeout));
}

async function restartServer() {
  if (serverProcess) {
    pushLog('[Panel] Restarting server…');
    stopRequested = false; // Don't backup on restart-stop
    pushStatus('stopping');
    try { serverProcess.stdin.write('stop\n'); } catch {}

    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        if (serverProcess) serverProcess.kill('SIGKILL');
        resolve();
      }, CONFIG.STOP_TIMEOUT_MS);
      serverProcess.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  setTimeout(() => startServer(), 800);
}

function sendCommand(cmd) {
  if (!serverProcess) {
    pushLog('[Panel] Cannot send command — server is not running.');
    return;
  }
  try {
    serverProcess.stdin.write(cmd + '\n');
    pushLog('> ' + cmd);
  } catch (e) {
    pushLog('[Panel] Failed to send command: ' + e.message);
  }
}

// ─────────────────────────────────────────────
// BACKUP
// ─────────────────────────────────────────────
function createBackup() {
  return new Promise((resolve, reject) => {
    ensureDir(BACKUPS_DIR);
    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${ts}.zip`;
    const outPath  = path.join(BACKUPS_DIR, filename);
    const output   = fs.createWriteStream(outPath);
    const archive  = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => {
      broadcast('backup', { filename, size: archive.pointer() });
      resolve(filename);
    });
    archive.on('error', err => reject(err));
    archive.pipe(output);
    archive.directory(SERVER_DIR, false);
    archive.finalize();
  });
}

// ─────────────────────────────────────────────
// PLAYIT TUNNEL
// ─────────────────────────────────────────────
function readTunnelSecret() {
  const d = safeReadJSON(TUNNEL_FILE, { secret: '' });
  return d.secret || '';
}

function startTunnel() {
  if (tunnelProcess) {
    pushLog('[Tunnel] Already running.');
    return;
  }
  const secret = readTunnelSecret();
  if (!secret) {
    broadcast('tunnelStatus', { status: 'error', message: 'No tunnel secret saved.' });
    return;
  }

  tunnelStatus = 'starting';
  broadcast('tunnelStatus', { status: 'starting' });

  // Try Docker first
  const dockerCmd = [
    'docker', 'run', '--rm', '--name', 'playit-tunnel',
    '-e', `PLAYIT_SECRET=${secret}`,
    'ghcr.io/playit-cloud/playit-agent:0.17',
  ];

  exec('docker info 2>&1', (err) => {
    if (!err) {
      tunnelProcess = spawn(dockerCmd[0], dockerCmd.slice(1), { stdio: ['ignore','pipe','pipe'] });
    } else {
      // Fallback: local binary
      const localBin = path.join(BASE_DIR, 'playit');
      if (!fs.existsSync(localBin)) {
        broadcast('tunnelStatus', { status: 'error', message: 'Docker unavailable and no local playit binary found.' });
        tunnelStatus = 'stopped';
        return;
      }
      tunnelProcess = spawn(localBin, ['--secret', secret], { stdio: ['ignore','pipe','pipe'] });
    }

    tunnelProcess.stdout.on('data', d => {
      d.toString().split('\n').forEach(l => { if (l.trim()) pushLog('[Tunnel] ' + l); });
      if (tunnelStatus !== 'running') {
        tunnelStatus = 'running';
        broadcast('tunnelStatus', { status: 'running' });
      }
    });
    tunnelProcess.stderr.on('data', d => {
      d.toString().split('\n').forEach(l => { if (l.trim()) pushLog('[Tunnel ERR] ' + l); });
    });
    tunnelProcess.on('exit', (code) => {
      pushLog('[Tunnel] Exited with code ' + code);
      tunnelProcess = null;
      tunnelStatus  = 'stopped';
      broadcast('tunnelStatus', { status: 'stopped' });
    });
  });
}

function stopTunnel() {
  if (!tunnelProcess) {
    broadcast('tunnelStatus', { status: 'stopped' });
    return;
  }
  exec('docker stop playit-tunnel 2>/dev/null', () => {});
  try { tunnelProcess.kill('SIGTERM'); } catch {}
  tunnelProcess = null;
  tunnelStatus  = 'stopped';
  broadcast('tunnelStatus', { status: 'stopped' });
  pushLog('[Tunnel] Stopped.');
}

// ─────────────────────────────────────────────
// SERVER.PROPERTIES parser
// ─────────────────────────────────────────────
function readProperties() {
  if (!fs.existsSync(PROPS_FILE)) return {};
  const lines  = fs.readFileSync(PROPS_FILE, 'utf8').split('\n');
  const result = {};
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  });
  return result;
}

function writeProperties(props) {
  if (!fs.existsSync(PROPS_FILE)) return;
  let lines = fs.readFileSync(PROPS_FILE, 'utf8').split('\n');
  lines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return line;
    const key = trimmed.slice(0, idx).trim();
    if (props.hasOwnProperty(key)) return `${key}=${props[key]}`;
    return line;
  });
  fs.writeFileSync(PROPS_FILE, lines.join('\n'), 'utf8');
}

// ─────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────
const app = express();

app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret           : CONFIG.SESSION_SECRET,
  resave           : false,
  saveUninitialized: false,
  cookie           : { maxAge: 24 * 60 * 60 * 1000 },
}));

// ── Auth Middleware ──────────────────────────
function requireAuth(req, res, next) {
  if (!isSetupDone()) return res.redirect('/setup.html');
  if (!req.session.user) return res.redirect('/login.html');
  next();
}

// ── Static (with auth guard) ─────────────────
app.get('/setup.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'setup.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/', (req, res) => {
  if (!isSetupDone()) return res.redirect('/setup.html');
  if (!req.session.user) return res.redirect('/login.html');
  return res.redirect('/index.html');
});
app.use((req, res, next) => {
  const open = ['/setup.html', '/login.html', '/api/login', '/api/setup', '/api/logout'];
  if (open.some(p => req.path === p)) return next();
  if (req.path.endsWith('.html') || req.path === '/' ) return requireAuth(req, res, next);
  next();
});
app.use(express.static(PUBLIC_DIR));

// ─────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────
app.post('/api/setup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 4) {
    return res.json({ ok: false, error: 'Username and password (min 4 chars) required.' });
  }
  const data = loadUsers();
  data.users = [{ username, password, role: 'admin' }];
  data.setupDone = true;
  saveUsers(data);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = findUser(username, password);
  if (!user) return res.json({ ok: false, error: 'Invalid credentials.' });
  req.session.user = user;
  res.json({ ok: true, setupDone: isSetupDone() });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// API — all below require auth
// ─────────────────────────────────────────────
const apiRouter = express.Router();
apiRouter.use((req, res, next) => {
  if (!isSetupDone()) return res.status(403).json({ error: 'Setup not complete.' });
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── Players ──────────────────────────────────
apiRouter.get('/players', (req, res) => res.json({ players: onlinePlayers }));

// ── Permissions ──────────────────────────────
apiRouter.get('/permissions', (req, res) => {
  res.json(safeReadJSON(PERMS_FILE, []));
});
apiRouter.post('/permissions', (req, res) => {
  safeWriteJSON(PERMS_FILE, req.body);
  res.json({ ok: true });
});

// ── Allowlist ────────────────────────────────
apiRouter.get('/allowlist', (req, res) => {
  res.json(safeReadJSON(ALLOWLIST_FILE, []));
});
apiRouter.post('/allowlist', (req, res) => {
  safeWriteJSON(ALLOWLIST_FILE, req.body);
  res.json({ ok: true });
});

// ── Server Properties ─────────────────────────
apiRouter.get('/server-properties', (req, res) => {
  res.json(readProperties());
});
apiRouter.post('/server-properties', (req, res) => {
  try {
    writeProperties(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
apiRouter.get('/server-details', (req, res) => {
  const p = readProperties();
  res.json({
    serverName : p['server-name']          || 'Dedicated Server',
    gamemode   : p['gamemode']              || 'survival',
    difficulty : p['difficulty']            || 'easy',
    maxPlayers : p['max-players']           || '10',
    port       : p['server-port']           || '19132',
    levelName  : p['level-name']            || 'Bedrock level',
    whitelist  : p['allow-list']            || 'false',
    cheats     : p['allow-cheats']          || 'false',
  });
});

// ── Packs ─────────────────────────────────────
function listPacks(dir) {
  const full = path.join(SERVER_DIR, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const stat = fs.statSync(path.join(full, f));
      return { name: f, isDir: stat.isDirectory(), size: stat.size };
    });
}

apiRouter.get('/behavior-packs',  (req, res) => res.json(listPacks('behavior_packs')));
apiRouter.get('/resource-packs',  (req, res) => res.json(listPacks('resource_packs')));

// ── Upload Pack ───────────────────────────────
const packUpload = multer({ dest: path.join(BASE_DIR, 'tmp_upload') });
apiRouter.post('/upload-pack', packUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const packType = req.body.type === 'resource' ? 'resource_packs' : 'behavior_packs';
  const destDir  = path.join(SERVER_DIR, packType);
  ensureDir(destDir);

  const AdmZip = require('adm-zip');
  try {
    const zip     = new AdmZip(req.file.path);
    const entries = zip.getEntries();
    // Figure out pack folder name from manifest
    let packName = path.basename(req.file.originalname, path.extname(req.file.originalname));
    zip.extractAllTo(path.join(destDir, packName), true);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, name: packName });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Failed to extract pack: ' + e.message });
  }
});

// ── Tunnel Secret ─────────────────────────────
apiRouter.get('/tunnel-secret', (req, res) => {
  res.json({ secret: readTunnelSecret() });
});
apiRouter.post('/tunnel-secret', (req, res) => {
  safeWriteJSON(TUNNEL_FILE, { secret: req.body.secret || '' });
  res.json({ ok: true });
});
apiRouter.get('/tunnel-status', (req, res) => {
  res.json({ status: tunnelStatus });
});

// ── Server Status ─────────────────────────────
apiRouter.get('/server-status', (req, res) => {
  res.json({ status: serverStatus });
});

// ── Backups ───────────────────────────────────
apiRouter.post('/backup', async (req, res) => {
  try {
    const filename = await createBackup();
    res.json({ ok: true, filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

apiRouter.get('/backups', (req, res) => {
  ensureDir(BACKUPS_DIR);
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { filename: f, size: stat.size, date: stat.mtime };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(files);
});

apiRouter.get('/backup/download/:filename', (req, res) => {
  const f = path.join(BACKUPS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Not found' });
  res.download(f);
});

// ── File Manager ──────────────────────────────
apiRouter.get('/files', (req, res) => {
  try {
    const dir = safePath(req.query.path || '');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.status(404).json({ error: 'Not a directory' });
    }
    const entries = fs.readdirSync(dir).map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return {
        name,
        type : stat.isDirectory() ? 'directory' : 'file',
        size : stat.size,
        date : stat.mtime,
      };
    });
    res.json(entries);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

apiRouter.get('/file/read', (req, res) => {
  try {
    const fp = safePath(req.query.path);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(fp);
    if (stat.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'File too large to edit (>5MB)' });
    res.json({ content: fs.readFileSync(fp, 'utf8') });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

apiRouter.post('/file/write', (req, res) => {
  try {
    const fp = safePath(req.body.path);
    fs.writeFileSync(fp, req.body.content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const fileUpload = multer({ dest: path.join(BASE_DIR, 'tmp_upload') });
apiRouter.post('/file/upload', fileUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const dest = safePath(path.join(req.body.path || '', req.file.originalname));
    fs.renameSync(req.file.path, dest);
    res.json({ ok: true });
  } catch (e) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: e.message });
  }
});

apiRouter.delete('/file', (req, res) => {
  try {
    const fp = safePath(req.query.path);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) {
      fs.rmSync(fp, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fp);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

apiRouter.post('/file/mkdir', (req, res) => {
  try {
    const fp = safePath(req.body.path);
    fs.mkdirSync(fp, { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

apiRouter.post('/file/rename', (req, res) => {
  try {
    const from = safePath(req.body.from);
    const to   = safePath(req.body.to);
    fs.renameSync(from, to);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

apiRouter.get('/file/download', (req, res) => {
  try {
    const fp = safePath(req.query.path);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    res.download(fp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use('/api', apiRouter);

// ─────────────────────────────────────────────
// HTTP + WebSocket SERVER
// ─────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss        = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  wsClients.add(ws);

  // Send initial state
  ws.send(JSON.stringify({ type: 'history',  data: { lines: consoleHistory } }));
  ws.send(JSON.stringify({ type: 'status',   data: { status: serverStatus } }));
  ws.send(JSON.stringify({ type: 'players',  data: { players: onlinePlayers } }));
  ws.send(JSON.stringify({ type: 'tunnelStatus', data: { status: tunnelStatus } }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'start'       : startServer();                   break;
      case 'stop'        : stopServer(false);               break;
      case 'forceStop'   : stopServer(true);                break;
      case 'restart'     : restartServer();                 break;
      case 'tunnelStart' : startTunnel();                   break;
      case 'tunnelStop'  : stopTunnel();                    break;
      case 'command'     : sendCommand(msg.data.cmd || ''); break;
    }
  });

  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', ()  => wsClients.delete(ws));
});

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
process.on('SIGINT',  () => { stopServer(true); setTimeout(() => process.exit(0), 1500); });
process.on('SIGTERM', () => { stopServer(true); setTimeout(() => process.exit(0), 1500); });

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────
function init() {
  ensureDir(SERVER_DIR);
  ensureDir(BACKUPS_DIR);
  ensureDir(PUBLIC_DIR);
  ensureDir(path.join(BASE_DIR, 'tmp_upload'));
  ensureEula();

  const binaryExists = fs.existsSync(path.join(SERVER_DIR, 'bedrock_server'));

  httpServer.listen(CONFIG.PORT, () => {
    console.log(`\n🎮  Minecraft Bedrock Panel running at http://localhost:${CONFIG.PORT}`);
    if (!isSetupDone()) {
      console.log('⚙️   First run — open the URL above to complete setup.');
    }
    if (binaryExists) {
      startServer();
    } else {
      console.log('⚠️   bedrock_server binary not found in server/ — use the panel after placing it there.');
    }
  });
}

// Try to install adm-zip if not present
try {
  require.resolve('adm-zip');
  init();
} catch {
  console.log('Installing adm-zip…');
  const { execSync } = require('child_process');
  execSync('npm install adm-zip --no-save', { stdio: 'inherit' });
  init();
}
