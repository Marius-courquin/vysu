// screen.py against src/img/screen.ts on agent-device snapshots: the real ones of the inputs (iOS
// 17 Pro, SE, a clone, two Android emulators), and variants of them that exercise what the real ones
// may not show (a keyboard window, a focused field, a password, a system dialog, hidden and covered
// nodes, scroll indicators, bars, an error answer, an empty or broken file). Every verb, every
// option: what is printed, the exit code, and the keys file written must match.
//
//   node test/parity/screen.ts <inputs> <scratch>      (<inputs>/snap/.snap-*.json)
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/screen.ts';
import { dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/screen.ts <inputs> <scratch>');
const [work] = dirs(scratch, `screen-${Date.now()}`) as [string];
const report = new Report();

type Node = Record<string, unknown>;
const snaps: Array<[string, string]> = [];
for (const f of readdirSync(join(inputs, 'snap')).filter((f) => f.endsWith('.json')).sort()) {
  const text = readFileSync(join(inputs, 'snap', f), 'utf8');
  snaps.push([f, text]);
  let doc: { data?: { nodes?: Node[]; androidSnapshot?: Node } };
  try {
    doc = JSON.parse(text);
  } catch {
    continue;
  }
  const nodes = doc.data?.nodes;
  if (!Array.isArray(nodes) || !nodes.length) continue;
  const android = f.includes('android');
  const vary = (name: string, edit: (nodes: Node[], d: typeof doc) => void): void => {
    const d = JSON.parse(text) as typeof doc;
    edit(d.data!.nodes!, d);
    snaps.push([`${f}~${name}`, JSON.stringify(d)]);
  };
  const w = android ? 1080 : 402;
  const h = android ? 2340 : 874;
  vary('keyboard', (ns) => {
    const base = 900;
    ns.push({ type: android ? 'android.widget.FrameLayout' : 'Window', depth: 1, index: base, parentIndex: 0, rect: { x: 0, y: h * 0.6, width: w, height: h * 0.4 } });
    ns.push({ type: android ? 'android.inputmethodservice.KeyboardView' : 'Keyboard', depth: 2, index: base + 1, parentIndex: base, rect: { x: 0, y: h * 0.65, width: w, height: h * 0.35 } });
    for (const [i, k] of ['q', 'w', 'e', 'Suppr', 'retour'].entries()) ns.push({ type: 'Key', depth: 3, index: base + 2 + i, parentIndex: base + 1, label: k, rect: { x: 10 + i * 40, y: h * 0.7, width: 36, height: 44 } });
    ns.push({ type: 'Other', depth: 2, index: base + 10, parentIndex: base, label: 'Suggestions de saisie', rect: { x: 0, y: h * 0.6, width: w, height: 40 } });
  });
  vary('keyboard-below', (ns) => {
    ns.push({ type: 'Keyboard', depth: 1, index: 950, parentIndex: 0, rect: { x: 0, y: h + 10, width: w, height: 300 } });
  });
  vary('focus', (ns) => {
    ns.push({ type: android ? 'android.widget.EditText' : 'TextField', depth: 2, index: 800, parentIndex: 0, focused: true, editable: true, label: 'Adresse e-mail de connexion très longue pour être coupée', identifier: 'email', rect: { x: 16, y: h * 0.3, width: w - 32, height: 48 } });
    ns.push({ type: 'StaticText', depth: 2, index: 801, parentIndex: 0, label: 'Mot de passe', rect: { x: 16, y: h * 0.4, width: 120, height: 20 } });
    ns.push({ type: android ? 'android.widget.EditText' : 'SecureTextField', depth: 2, index: 802, parentIndex: 0, password: true, label: '', rect: { x: 16, y: h * 0.43, width: w - 32, height: 48 } });
  });
  vary('password', (ns) => {
    ns.push({ type: 'android.widget.EditText', depth: 2, index: 800, parentIndex: 0, focused: true, password: true, editable: true, label: 'secret', rect: { x: 16, y: 300, width: 300, height: 48 } });
  });
  vary('onefield', (ns) => {
    ns.push({ type: 'SearchField', depth: 2, index: 800, parentIndex: 0, label: '', rect: { x: 16, y: 120, width: w - 32, height: 40 } });
  });
  vary('system', (_ns, d) => {
    d.data!.androidSnapshot = { ...(d.data!.androidSnapshot ?? {}), systemSurfaceOnly: true };
  });
  vary('hidden', (ns) => {
    ns.forEach((n, i) => {
      if (i % 2) n.visibleToUser = false;
      if (i % 3 === 0) n.presentationHints = ['covered'];
    });
  });
  vary('chrome', (ns) => {
    ns.push({ type: 'ScrollBar', depth: 2, index: 700, parentIndex: 0, label: 'Barre de défilement verticale, 2 pages', value: '50%', rect: { x: w - 5, y: 100, width: 5, height: 400 } });
    ns.push({ type: 'TabBar', depth: 2, index: 701, parentIndex: 0, label: "Barre d'onglets", rect: { x: 0, y: h - 80, width: w, height: 80 } });
    ns.push({ type: 'android.widget.Toolbar', depth: 2, index: 702, parentIndex: 0, label: 'Barre d’outils', rect: { x: 0, y: 40, width: w, height: 56 } });
    ns.push({ type: 'Other', depth: 2, index: 703, parentIndex: 0, label: 'AB', rect: { x: 10, y: 200, width: 30, height: 30 } });
    ns.push({ type: 'Button', depth: 2, index: 704, parentIndex: 0, label: 'OK', rect: { x: 10, y: 250, width: 80, height: 44 } });
    ns.push({ type: 'Other', depth: 2, index: 705, parentIndex: 0, label: 'Conteneur plein écran', rect: { x: 0, y: 0, width: w, height: h } });
    ns.push({ type: 'Image', depth: 2, index: 706, parentIndex: 0, label: 'Photo de profil', rect: { x: 0, y: 300, width: 200, height: 200 } });
    ns.push({ type: 'StaticText', depth: 2, index: 707, parentIndex: 0, label: '  Un   libellé ,  espacé , ', rect: { x: 0, y: 330, width: 200, height: 20 } });
    ns.push({ type: 'StaticText', depth: 2, index: 708, parentIndex: 0, label: 'Straße ÉCOLE ﬁn', rect: { x: 0, y: 360, width: 200, height: 20 } });
  });
}
snaps.push(['empty', ''], ['broken', '{"data": {"nodes": [1, 2'], ['error', '{"success": false, "error": {"code": "TIMEOUT"}}'], ['notlist', '{"data": {"nodes": {"a": 1}}}']);

let n = 0;
for (const [name, text] of snaps) {
  n++;
  const file = join(work, `${n}.json`);
  writeFileSync(file, text);
  let labels: string[] = [];
  try {
    labels = (JSON.parse(text).data.nodes as Node[]).map((x) => String(x.label ?? '')).filter(Boolean);
  } catch {
    labels = [];
  }
  const probes = [...new Set([...labels.slice(0, 12), ...labels.slice(0, 4).map((l) => l.slice(1, 5).toUpperCase()), 'e-mail', 'mot de passe', 'STRASSE', 'nope-zzz'])];
  const keysPy = join(work, `${n}-py.keys`);
  const keysTs = join(work, `${n}-ts.keys`);
  const orig = join(inputs, 'snap', `${name.split('~')[0]}.keys`);
  for (const k of [keysPy, keysTs]) {
    try {
      copyFileSync(orig, k);
    } catch {
      writeFileSync(k, 'Other|x|\n\n  \nButton|Retour|\n');
    }
  }
  const cases: Array<[string[], string[]]> = [
    [['line', file], ['line', file]],
    [['line', file, '--scale', '2.625', '--keyboard', 'no'], ['line', file, '--scale', '2.625', '--keyboard', 'no']],
    [['line', file, '--keyboard', 'yes', '--scale', 'x'], ['line', file, '--keyboard', 'yes', '--scale', 'x']],
    [['line', file, '--prev', keysPy, '--save', keysPy], ['line', file, '--prev', keysTs, '--save', keysTs]],
    [['line', file, '--prev', join(work, 'missing.keys')], ['line', file, '--prev', join(work, 'missing.keys')]],
    [['sig', file], ['sig', file]],
    [['sig', file, '--geometry'], ['sig', file, '--geometry']],
    [['editable', file], ['editable', file]],
  ];
  for (const p of probes) {
    cases.push([['has', file, p], ['has', file, p]]);
    cases.push([['has', file, p, '--visible'], ['has', file, p, '--visible']]);
    cases.push([['field', file, p], ['field', file, p]]);
  }
  for (const [a, b] of cases) {
    const p = py('screen', a);
    const t = await ts(main, b);
    report.text(`${name} ${a[0]} ${a.slice(2).join(' ').slice(0, 40)}`, p, t);
  }
  if (readFileSync(keysPy, 'utf8') !== readFileSync(keysTs, 'utf8')) {
    report.failures.push(`${name} keys`);
    console.log(`✗ ${name}: keys file differs`);
  }
}
for (const args of [[], ['line'], ['line', join(work, '1.json'), '--bogus', 'x'], ['line', join(work, '1.json'), '--scale'], ['has', join(work, '1.json')], ['zzz', join(work, '1.json')]]) {
  const p = py('screen', args);
  const t = await ts(main, args);
  report.text(`usage ${args.join(' ').slice(-30)}`, p, t);
  if (p.stderr !== t.stderr) console.log(`✗ stderr ${JSON.stringify(p.stderr.slice(0, 200))} / ${JSON.stringify(t.stderr.slice(0, 200))}`);
}
report.done('screen');
