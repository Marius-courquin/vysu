import http from 'node:http';
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    appendFileSync(log, `${req.method} ${req.url} ${req.headers['content-type']} ${body.replace(/assertion=[^&]*/, 'assertion=<jwt>')}\n`);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
    if (req.url === '/token') return send(200, { access_token: 'bearer-1', expires_in: 3600 });
    if (req.url === '/send') return body.includes('tok-and') ? send(404, { error: { code: 404, message: 'UNREGISTERED' } }) : send(200, { name: 'projects/demo-proj/messages/0:123' });
    if (req.url === '/badtoken') return send(401, { error: 'invalid_grant' });
    if (req.url === '/hook') return send(200, { results: [{ platform: 'ios', deviceModel: 'iPhone 15', ok: true, messageName: 'm-1' }, { platform: 'android', deviceModel: null, ok: false, error: 'gone é' }] });
    if (req.url === '/hook-flat') return send(200, { accepted: true, note: 'élan' });
    if (req.url === '/hook-404') return send(404, 'nope');
    if (req.url === '/hook-500') return send(500, 'server exploded with a very long message '.repeat(10));
    send(418, 'teapot');
  });
}).listen(18089, '127.0.0.1');
