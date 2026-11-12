// Cricket Live Studio relay: serves cricket-studio.html and pipes the browser's program feed to Facebook Live.
// Setup:  npm i ws   |   needs ffmpeg on PATH   |   node cricket-relay.js   |   open http://localhost:8080
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080;

const srv = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'cricket-studio.html'), (e, d) => {
    if (e) { res.writeHead(404); return res.end('cricket-studio.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
  });
});

const wss = new WebSocketServer({
  server: srv, path: '/ingest',
  verifyClient: ({ origin, req }) => { // page origin must be localhost OR the same host that serves this relay (Render)
    if (!origin) return true;
    try { const u = new URL(origin); return u.host === req.headers.host || u.hostname === 'localhost' || u.hostname === '127.0.0.1'; } catch { return false; }
  }
});

wss.on('connection', ws => {
  let ff = null;
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type !== 'start' || ff) return;
      const key = String(m.key || '').trim();
      if (!/^[\w-]+$/.test(key)) { send({ type: 'error', msg: 'Invalid stream key' }); return ws.close(); }
      const args = ['-loglevel', 'warning', '-fflags', '+genpts', '-i', 'pipe:0'];
      if (!m.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-map', '0:v:0', '-map', '1:a:0', '-shortest');
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k', '-g', '60', '-r', '30',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', 'rtmps://live-api-s.facebook.com:443/rtmp/' + key);
      ff = spawn('ffmpeg', args);
      ff.on('error', () => { send({ type: 'error', msg: 'ffmpeg not found — install ffmpeg' }); ws.close(); });
      ff.stderr.on('data', d => send({ type: 'log', msg: d.toString().trim().replace(key, '****') }));
      ff.on('exit', c => { send({ type: 'ended', msg: 'ffmpeg exited (' + c + ')' }); ws.close(); });
      ff.stdin.on('error', () => {});
      send({ type: 'log', msg: 'Relay connected to ffmpeg → Facebook' });
    } else if (ff && ff.stdin.writable) ff.stdin.write(data);
  });
  ws.on('close', () => { if (ff) { try { ff.stdin.end(); ff.kill('SIGINT'); } catch {} } });
});

srv.listen(PORT, process.env.PORT ? '0.0.0.0' : '127.0.0.1', () => console.log('Cricket Live Studio → http://localhost:' + PORT));
