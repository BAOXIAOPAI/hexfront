/**
 * 最小 WebSocket 连通性探针。
 * 零依赖手写握手 + 帧解析，用来验证发布沙箱的反向代理是否放行 Upgrade。
 */

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 3000;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WebSocket 连通性测试</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;
       font-family:-apple-system,"PingFang SC",sans-serif;
       background:radial-gradient(circle at 50% 20%,#1e4254,#07141a 70%);color:#dbe8ec}
  .card{width:min(560px,90vw);background:#0f2630;border:1px solid rgba(255,255,255,.14);
        border-radius:16px;padding:24px}
  h1{font-size:15px;margin:0 0 4px;letter-spacing:.06em}
  .sub{font-size:12px;color:#6f93a1;margin-bottom:16px}
  #state{font-size:13px;font-weight:600;margin-bottom:14px}
  .ok{color:#7fd6a4}.bad{color:#e0715b}.wait{color:#e8b84b}
  #log{height:260px;overflow:auto;background:#08181f;border-radius:10px;padding:12px;
       font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.8;color:#9ec4d2}
  .t{color:#5a7f8c}
  button{margin-top:14px;width:100%;padding:11px;border-radius:10px;border:0;cursor:pointer;
         background:#2f6e83;color:#eaf6fa;font-size:13px;font-weight:600;font-family:inherit}
  button:disabled{opacity:.4;cursor:default}
</style>
</head>
<body>
<div class="card">
  <h1>WebSocket 连通性测试</h1>
  <div class="sub">验证发布沙箱的反向代理是否放行 Upgrade 头</div>
  <div id="state" class="wait">连接中…</div>
  <div id="log"></div>
  <button id="send" disabled>发送 ping</button>
</div>
<script>
  var logEl = document.getElementById('log');
  var stateEl = document.getElementById('state');
  var sendBtn = document.getElementById('send');
  var ws = null;

  function log(msg, cls){
    var t = new Date().toLocaleTimeString('zh-CN', {hour12:false});
    var row = document.createElement('div');
    row.innerHTML = '<span class="t">' + t + '</span> ' + msg;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
    if (cls) row.style.color = cls;
  }

  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  var url = proto + '://' + location.host;

  log('目标 ' + url);
  try {
    ws = new WebSocket(url);
  } catch (e) {
    log('构造失败: ' + e.message, '#e0715b');
  }

  if (ws) {
    ws.onopen = function(){
      stateEl.textContent = '已连接';
      stateEl.className = 'ok';
      log('OPEN 握手成功', '#7fd6a4');
      sendBtn.disabled = false;
      ws.send('ping');
    };
    ws.onmessage = function(e){
      log('RECV ' + e.data, '#9ec4d2');
    };
    ws.onerror = function(){
      stateEl.textContent = '连接失败';
      stateEl.className = 'bad';
      log('ERROR 握手或连接出错', '#e0715b');
    };
    ws.onclose = function(e){
      if (stateEl.className !== 'bad') {
        stateEl.textContent = '已断开';
        stateEl.className = 'bad';
      }
      log('CLOSE code=' + e.code, '#e8b84b');
      sendBtn.disabled = true;
    };
  }

  sendBtn.onclick = function(){
    if (ws && ws.readyState === 1) ws.send('ping ' + Date.now());
  };
</script>
</body>
</html>`;

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  socket.write(encodeFrame('CONNECTED ' + new Date().toISOString()));

  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;

      const mask = masked ? buf.subarray(off, off + 4) : null;
      off += maskLen;

      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        payload[i] = buf[off + i] ^ (mask ? mask[i % 4] : 0);
      }
      buf = buf.subarray(off + len);

      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x1) {
        socket.write(encodeFrame('ECHO: ' + payload.toString('utf8')));
      }
    }
  });

  socket.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('ws-check listening on ' + PORT);
});
