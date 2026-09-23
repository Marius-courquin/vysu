// A login form on 127.0.0.1 for the connector parity cases: GET /login shows it (an e-mail field
// labelled « E-mail », a password field, a « Se connecter » button), POST /login answers with a
// redirect to /home, which says « Bienvenue » and leaves a token in localStorage. Any password
// passes but « wrong », which answers in place. Prints its port, then serves until killed.
import { createServer } from 'node:http';

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>form</title></head><body>${body}</body></html>`;
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (new URLSearchParams(body).get('p') === 'wrong') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(page('<p>Mot de passe incorrect</p>'));
        return;
      }
      res.writeHead(303, { location: '/home' }).end();
    });
    return;
  }
  if (req.url === '/login') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      page(`<h1>Connexion</h1><form method="post" action="/login"><label for="e">E-mail</label><input id="e" name="e" type="email">
<label for="p">Mot de passe</label><input id="p" name="p" type="password"><button type="submit">Se connecter</button></form>`),
    );
    return;
  }
  if (req.url === '/home') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(page(`<h1>Bienvenue</h1><script>localStorage.setItem('access_token', 'tok-' + 'fixture')</script>`));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(page('<a href="/login">Se connecter</a>'));
});
server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
