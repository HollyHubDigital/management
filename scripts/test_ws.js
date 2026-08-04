const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');

function makeKey() { return crypto.randomBytes(16).toString('base64'); }
function makeAccept(key) { return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); }

function wsUpgrade(options, path, onConnect) {
  const client = net.createConnection(options.port || 8080, options.host || '127.0.0.1', () => {
    const key = makeKey();
    const req = [];
    req.push(`GET ${path} HTTP/1.1`);
    req.push(`Host: ${options.host || '127.0.0.1'}`);
    req.push('Upgrade: websocket');
    req.push('Connection: Upgrade');
    req.push(`Sec-WebSocket-Key: ${key}`);
    req.push('Sec-WebSocket-Version: 13');
    req.push('\r\n');
    client.write(req.join('\r\n'));
    client._wsKey = key;
  });
  let buffer = Buffer.alloc(0);
  client.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!client._upgraded) {
      const s = buffer.toString('utf8');
      if (s.indexOf('\r\n\r\n') !== -1) {
        client._upgraded = true;
        onConnect(null, client);
      }
    } else {
      onConnect(null, client, chunk);
    }
  });
  client.on('error', (e) => onConnect(e, client));
}

function sendMaskedFrame(socket, data) {
  const opcode = 2; // binary
  const fin = 0x80 | opcode;
  let header = Buffer.from([fin]);
  const mask = crypto.randomBytes(4);
  if (data.length < 126) {
    header = Buffer.concat([header, Buffer.from([0x80 | data.length])]);
  } else if (data.length < 65536) {
    header = Buffer.concat([header, Buffer.from([0x80 | 126, (data.length >> 8) & 255, data.length & 255])]);
  } else {
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64BE(BigInt(data.length), 0);
    header = Buffer.concat([header, Buffer.from([0x80 | 127]), lenBuf]);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  socket.write(Buffer.concat([header, mask, masked]));
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) { length = buffer.readUInt16BE(offset); offset += 2; }
  else if (length === 127) { length = Number(buffer.readBigUInt64BE(offset)); offset += 8; }
  if (offset + length > buffer.length) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  return { payload, remaining: buffer.slice(offset + length) };
}

(async () => {
  // enroll new device first via HTTP to obtain deviceId and token
  const http = require('http');
  function enroll() {
    const body = JSON.stringify({ enrollmentSecret: 'testsecret', platform: 'android', name: 'ws-sim', serial: 'WS123', ownerConsent: true });
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: 8080, path: '/api/enroll', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  const enrollment = await enroll();
  console.log('ENROLLED', enrollment.deviceId, enrollment.token);
  const deviceId = enrollment.deviceId;
  const token = enrollment.token;

  // create viewer WS (admin)
  wsUpgrade({ host: '127.0.0.1', port: 8080 }, `/ws/live?deviceId=${deviceId}&adminToken=admintoken`, (err, viewerSocket, chunk) => {
    if (err) return console.error('Viewer upgrade error', err);
    console.log('Viewer connected (raw). Waiting for server frames...');
    let buf = Buffer.alloc(0);
    viewerSocket.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      const frame = readFrame(buf);
      if (frame) {
        console.log('Viewer received frame length', frame.payload.length);
        require('fs').writeFileSync('ws_got.jpg', frame.payload);
        console.log('Saved ws_got.jpg');
        viewerSocket.end();
        process.exit(0);
      }
    });

    // after viewer connected, open device WS and send a binary frame
    wsUpgrade({ host: '127.0.0.1', port: 8080 }, `/ws/device/${deviceId}?token=${token}`, (err2, deviceSocket) => {
      if (err2) return console.error('Device upgrade error', err2);
      console.log('Device WebSocket connected, sending binary frame');
      const payload = Buffer.from([0,1,2,3,4,5,6,7,8,9]);
      sendMaskedFrame(deviceSocket, payload);
      console.log('Sent masked frame from device');
    });
  });
})();
