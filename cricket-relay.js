// Cricket Live Studio server
//  - serves the studio (cricket-studio.html) and the phone-camera page (/cam)
//  - /qr        : QR code for the phone-camera link
//  - /signal    : WebRTC signalling so phones can join as wireless cameras (room code = secret)
//  - /ingest    : pipes the program feed to Facebook Live through ffmpeg
// Setup:  npm install   |   needs ffmpeg on PATH   |   node cricket-relay.js   |   open http://localhost:8080
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const crypto = require('crypto');
const PORT = process.env.PORT || 8080;

/* ---------------- roles, login and join codes (all checked on the server) ----------------
   Set these environment variables on the server (Render > Environment):
     ADMIN_PHONE  = admin phone number      ADMIN_PASS = admin password
   Optional: SESSION_SECRET (any long random text; changing it logs everybody out and voids all codes). */
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '').replace(/\D/g, ''), ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_OK = !!(ADMIN_PHONE && ADMIN_PASS);
const SECRET = ADMIN_OK
  ? crypto.createHash('sha256').update('cls1|' + ADMIN_PHONE + '|' + ADMIN_PASS + '|' + (process.env.SESSION_SECRET || '')).digest()
  : crypto.randomBytes(32);
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const eq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const mkToken = role => { const p = role + '.' + (Date.now() + 12 * 3600e3); return p + '.' + hmac('t|' + p); };
function readToken(t) {
  const m = /^(admin|umpire|broadcaster)\.(\d+)\.([\w-]+)$/.exec(String(t || ''));
  if (!m || !eq(m[3], hmac('t|' + m[1] + '.' + m[2])) || Date.now() > +m[2]) return null;
  return { role: m[1] };
}
const A32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', day = () => Math.floor(Date.now() / 864e5);
const csig = (role, rand, d) => hmac('c|' + role + rand + d).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
function mkCode(role) { let r = ''; for (const b of crypto.randomBytes(6)) r += A32[b % 32]; return (role === 'umpire' ? 'UMP' : 'BRD') + '-' + r + '-' + csig(role, r, day()); }
function readCode(c) { // codes are signed, so they keep working after a server restart; valid ~7 days
  const m = /^(UMP|BRD)-([A-Z2-9]{6})-([A-Z0-9]{6})$/.exec(String(c || '').trim().toUpperCase());
  if (!m) return null; const role = m[1] === 'UMP' ? 'umpire' : 'broadcaster';
  let ok = false; for (let k = 0; k < 8; k++) if (eq(m[3], csig(role, m[2], day() - k))) ok = true;
  return ok ? role : null;
}
const fails = new Map(); // simple brute-force protection per IP
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const limited = ip => { const n = Date.now(), a = (fails.get(ip) || []).filter(t => n - t < 600e3); fails.set(ip, a); return a.length >= 15; };
const addFail = ip => { const a = fails.get(ip) || []; a.push(Date.now()); fails.set(ip, a); };
const readBody = req => new Promise(ok => { let s = ''; req.on('data', d => { s += d; if (s.length > 2048) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
const sendJson = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const bearer = req => readToken((String(req.headers.authorization || '').match(/^Bearer (.+)$/) || [])[1]);


const PHONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Phone camera</title>
<style>
body{margin:0;background:#0a0f1f;color:#e9edff;font:16px system-ui,sans-serif;padding:16px;max-width:560px;margin:auto}
video{width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;object-fit:cover}
input,button{font:inherit;padding:12px 14px;border-radius:10px;border:1px solid #2a3665;background:#1a2547;color:#e9edff;width:100%;margin-top:10px}
button{background:#22c55e;color:#04210f;font-weight:700;border:0}button.s{background:#1a2547;color:#e9edff;border:1px solid #2a3665}
button:disabled{opacity:.45}#st{margin-top:12px;color:#9fb0ff}.code{font-size:22px;font-weight:800;letter-spacing:3px}
</style></head><body>
<h2>Camera for Cricket Live Studio</h2>
<div>Room code <span class="code" id="rc"></span></div>
<video id="v" autoplay muted playsinline></video>
<input id="nm" placeholder="Camera name (e.g. Side-on)" maxlength="20">
<button id="go">Start camera</button>
<button id="flip" class="s" disabled>Flip camera</button>
<div id="st">Tap Start camera and allow camera access.</div>
<script>
var q=new URLSearchParams(location.search),room=(q.get('r')||'').toUpperCase(),id=Math.random().toString(36).slice(2,8);
var v=document.getElementById('v'),st=function(t){document.getElementById('st').textContent=t};
var ws=null,pc=null,stream=null,face='environment',chain=Promise.resolve(),wake=null,started=false;
document.getElementById('rc').textContent=room||'(missing)';
async function getCam(){
  if(stream)stream.getTracks().forEach(function(t){t.stop()});
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:face},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:false});
  v.srcObject=stream;
}
async function lock(){try{wake=await navigator.wakeLock.request('screen')}catch(e){}}
document.addEventListener('visibilitychange',function(){if(started&&document.visibilityState==='visible')lock()});
async function offer(){
  if(pc)try{pc.close()}catch(e){}
  pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  stream.getTracks().forEach(function(t){pc.addTrack(t,stream)});
  pc.onicecandidate=function(e){if(e.candidate&&ws&&ws.readyState===1)ws.send(JSON.stringify({type:'ice',c:e.candidate}))};
  pc.onconnectionstatechange=function(){st(pc.connectionState==='connected'?'LIVE to the studio. Keep this screen open and the phone charging.':'Connection: '+pc.connectionState)};
  pc.getSenders().forEach(function(s){var p=s.getParameters();if(!p.encodings||!p.encodings.length)p.encodings=[{}];p.encodings[0].maxBitrate=2500000;s.setParameters(p).catch(function(){})});
  var o=await pc.createOffer();await pc.setLocalDescription(o);
  ws.send(JSON.stringify({type:'offer',sdp:o.sdp}));
}
async function onMsg(m){
  if(m.type==='error'){st(m.msg);return}
  if(m.type==='restart'){await offer();return}
  if(m.type==='answer'&&pc){await pc.setRemoteDescription({type:'answer',sdp:m.sdp});return}
  if(m.type==='ice'&&pc&&pc.remoteDescription){try{await pc.addIceCandidate(m.c)}catch(e){}}
}
function connect(){
  var name=document.getElementById('nm').value||'Phone';
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/signal?role=cam&room='+room+'&id='+id+'&name='+encodeURIComponent(name));
  ws.onopen=function(){st('Connecting to studio...');offer()};
  ws.onmessage=function(e){var m;try{m=JSON.parse(e.data)}catch(x){return}chain=chain.then(function(){return onMsg(m)}).catch(function(){})};
  ws.onclose=function(){if(started){st('Disconnected. Reconnecting...');setTimeout(connect,2000)}};
}
document.getElementById('go').onclick=async function(){
  if(!/^[A-Z2-9]{6}$/.test(room)){st('Invalid link. Scan the QR code again.');return}
  try{await getCam()}catch(e){st('Camera blocked: '+e.message);return}
  started=true;this.disabled=true;document.getElementById('flip').disabled=false;lock();connect();
};
document.getElementById('flip').onclick=async function(){
  face=face==='environment'?'user':'environment';
  try{await getCam();var s=pc&&pc.getSenders()[0];if(s)await s.replaceTrack(stream.getVideoTracks()[0])}catch(e){st('Flip failed: '+e.message)}
};
</script></body></html>`;

const okOrigin = req => { // page must come from this same server (or localhost)
  const o = req.headers.origin; if (!o) return true;
  try { const u = new URL(o); return u.host === req.headers.host || u.hostname === 'localhost' || u.hostname === '127.0.0.1'; } catch { return false; }
};

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
    const b = await readBody(req), ip = ipOf(req);
    if (u.pathname === '/api/me') { const w = bearer(req); return w ? sendJson(res, 200, w) : sendJson(res, 401, { error: 'Not logged in' }); }
    if (u.pathname === '/api/gen') {
      const w = bearer(req); if (!w || w.role !== 'admin') return sendJson(res, 403, { error: 'Admin only' });
      if (b.role !== 'umpire' && b.role !== 'broadcaster') return sendJson(res, 400, { error: 'role must be umpire or broadcaster' });
      return sendJson(res, 200, { code: mkCode(b.role), role: b.role });
    }
    if (u.pathname === '/api/key/get') {
      const w = bearer(req); if (!w || (w.role !== 'broadcaster' && w.role !== 'admin')) return sendJson(res, 403, { error: 'Not allowed' });
      return sendJson(res, 200, shared ? { ready: true, title: shared.title, privacy: shared.privacy, at: shared.at } : { ready: false });
    }
    if (u.pathname === '/api/key/set' || u.pathname === '/api/key/clear') {
      const w = bearer(req); if (!w || w.role !== 'admin') return sendJson(res, 403, { error: 'Admin only' });
      if (u.pathname === '/api/key/clear') { shared = null; return sendJson(res, 200, { ready: false }); }
      if (!fbUrlOk(b.url)) return sendJson(res, 400, { error: 'Invalid Facebook stream URL' });
      shared = { url: String(b.url), title: String(b.title || '').slice(0, 100), privacy: String(b.privacy || '').slice(0, 20), at: Date.now() };
      return sendJson(res, 200, { ready: true });
    }
    if (limited(ip)) return sendJson(res, 429, { error: 'Too many attempts. Wait 10 minutes.' });
    if (u.pathname === '/api/login') {
      if (!ADMIN_OK) return sendJson(res, 503, { error: 'Admin login is not set up on the server (set ADMIN_PHONE and ADMIN_PASS).' });
      const a = eq(String(b.phone || '').replace(/\D/g, ''), ADMIN_PHONE), c = eq(String(b.password || ''), ADMIN_PASS);
      if (a && c) return sendJson(res, 200, { token: mkToken('admin'), role: 'admin' });
      addFail(ip); return sendJson(res, 401, { error: 'Wrong phone number or password' });
    }
    if (u.pathname === '/api/join') {
      const role = readCode(b.code);
      if (role) return sendJson(res, 200, { token: mkToken(role), role });
      addFail(ip); return sendJson(res, 401, { error: 'Invalid or expired code' });
    }
    return sendJson(res, 404, { error: 'Not found' });
  }
  if (u.pathname === '/cam') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PHONE_PAGE); }
  if (u.pathname === '/qr') {
    const d = u.searchParams.get('d') || '';
    if (!/^https?:\/\//.test(d) || d.length > 300) { res.writeHead(400); return res.end('bad request'); }
    try { const svg = await QRCode.toString(d, { type: 'svg', margin: 1 }); res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(svg); }
    catch { res.writeHead(500); return res.end('qr error'); }
  }
  fs.readFile(path.join(__dirname, 'cricket-studio.html'), (e, d) => {
    if (e) { res.writeHead(404); return res.end('cricket-studio.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
  });
});

/* ---------------- Facebook Live ingest ---------------- */
function ingest(ws) {
  let ff = null;
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type !== 'start' || ff) return;
      let target, secret;
      if (m.shared) { // key prepared by the admin
        if (!shared) { send({ type: 'error', msg: 'The admin has not generated a stream key yet' }); return ws.close(); }
        target = shared.url; secret = target;
      } else if (m.url) { // direct mode: URL returned by Facebook's Live Video API
        try { const u = new URL(String(m.url)); if (!/^rtmps?:$/.test(u.protocol) || !/(^|\.)facebook\.com$/.test(u.hostname)) throw 0; target = String(m.url); secret = target; }
        catch { send({ type: 'error', msg: 'Invalid Facebook stream URL' }); return ws.close(); }
      } else {
        const key = String(m.key || '').trim();
        if (!/^[\w-]+$/.test(key)) { send({ type: 'error', msg: 'Invalid stream key' }); return ws.close(); }
        target = 'rtmps://live-api-s.facebook.com:443/rtmp/' + key; secret = key;
      }
      const args = ['-loglevel', 'warning', '-fflags', '+genpts', '-i', 'pipe:0'];
      if (!m.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-map', '0:v:0', '-map', '1:a:0', '-shortest');
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k', '-g', '60', '-r', '30',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', target);
      ff = spawn('ffmpeg', args);
      ff.on('error', () => { send({ type: 'error', msg: 'ffmpeg not found — install ffmpeg' }); ws.close(); });
      ff.stderr.on('data', d => send({ type: 'log', msg: d.toString().trim().split(secret).join('****') }));
      ff.on('exit', c => { send({ type: 'ended', msg: 'ffmpeg exited (' + c + ')' }); ws.close(); });
      ff.stdin.on('error', () => {});
      send({ type: 'log', msg: 'Relay connected to ffmpeg → Facebook' });
    } else if (ff && ff.stdin.writable) ff.stdin.write(data);
  });
  ws.on('close', () => { if (ff) { try { ff.stdin.end(); ff.kill('SIGINT'); } catch {} } });
}

/* ---------------- phone camera signalling ---------------- */
const rooms = new Map(); // code -> { studio: ws|null, cams: Map(id -> {ws,name}) }
const out = (w, o) => { if (w && w.readyState === 1) w.send(JSON.stringify(o)); };
function signal(ws, url) {
  const q = url.searchParams, room = (q.get('room') || '').toUpperCase(), role = q.get('role'), id = q.get('id') || '';
  if (!/^[A-Z2-9]{6}$/.test(room)) return ws.close();
  let r = rooms.get(room);
  if (role === 'studio') {
    if (!r) { r = { studio: null, cams: new Map() }; rooms.set(room, r); }
    if (r.studio && r.studio !== ws) try { r.studio.close(); } catch {}
    r.studio = ws;
    r.cams.forEach((c, cid) => { out(ws, { type: 'join', id: cid, name: c.name }); out(c.ws, { type: 'restart' }); });
    ws.on('close', () => { if (r.studio === ws) { r.studio = null; if (!r.cams.size) rooms.delete(room); } });
  } else if (role === 'cam') {
    if (!/^[\w-]{4,24}$/.test(id)) return ws.close();
    if (!r || !r.studio) { out(ws, { type: 'error', msg: 'Studio not found for this code. Open "Add phone camera" in the studio first.' }); return ws.close(); }
    if (r.cams.size >= 6 && !r.cams.has(id)) { out(ws, { type: 'error', msg: 'Too many cameras in this room.' }); return ws.close(); }
    const name = (q.get('name') || 'Phone').slice(0, 20);
    const old = r.cams.get(id); if (old && old.ws !== ws) try { old.ws.close(); } catch {}
    r.cams.set(id, { ws, name }); out(r.studio, { type: 'join', id, name });
    ws.on('close', () => {
      const c = r.cams.get(id);
      if (c && c.ws === ws) { r.cams.delete(id); out(r.studio, { type: 'leave', id }); if (!r.studio && !r.cams.size) rooms.delete(room); }
    });
  } else return ws.close();
  ws.on('message', data => {
    if (data.length > 20000) return;
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (role === 'cam') out(r.studio, Object.assign({}, m, { from: id }));
    else { const c = r.cams.get(m.to); if (c) out(c.ws, m); }
  });
}

/* ---------------- stream key set by the admin (kept on the server, never sent to the broadcaster) ---------------- */
let shared = null; // { url, title, privacy, at }
const fbUrlOk = v => { try { const u = new URL(String(v)); return /^rtmps?:$/.test(u.protocol) && /(^|\.)facebook\.com$/.test(u.hostname); } catch { return false; } };

/* ---------------- live match state (umpire -> broadcaster) ---------------- */
let lastState = null; const stClients = new Set();
function stateConn(ws, who) {
  stClients.add(ws); if (lastState) ws.send(lastState);
  ws.on('message', d => {
    if (who.role !== 'umpire' && who.role !== 'admin') return; // only the scorer can write
    const s = d.toString(); let m; try { m = JSON.parse(s); } catch { return; }
    if (m.type !== 'state' || !m.db) return;
    lastState = s; stClients.forEach(c => { if (c !== ws && c.readyState === 1) c.send(s); });
  });
  ws.on('close', () => stClients.delete(ws));
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });
srv.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url, 'http://x');
  const who = readToken(u.searchParams.get('t'));
  const isStudio = u.pathname === '/signal' && u.searchParams.get('role') === 'studio';
  const allowed = okOrigin(req) && (
    (u.pathname === '/ingest' && who && (who.role === 'broadcaster' || who.role === 'admin')) ||
    (u.pathname === '/signal' && (!isStudio || (who && (who.role === 'broadcaster' || who.role === 'admin')))) ||
    (u.pathname === '/state' && who));
  if (!allowed) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => (u.pathname === '/ingest' ? ingest(ws) : u.pathname === '/state' ? stateConn(ws, who) : signal(ws, u)));
});

srv.listen(PORT, process.env.PORT ? '0.0.0.0' : '127.0.0.1', () => { console.log('Cricket Live Studio → http://localhost:' + PORT); if (!ADMIN_OK) console.log('WARNING: set ADMIN_PHONE and ADMIN_PASS environment variables to enable admin login.'); });
