// `vysu persona add|set|list [--json]|import <file> [--prefix <P>] [--to <file>]`.
import { existsSync } from 'node:fs';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { personaCheckName, personaImport, personaKey, personaList, personaWrite } from '../core/personas.ts';
import { ask, askSecret } from '../setup/prompt.ts';

const USAGE = 'usage: vysu persona add <name> | set <name> <KEY> <value> | list [--json] | import <file> [--prefix <P>] [--to <file>]';

export async function run(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'add':
      return add(rest);
    case 'set':
      return set(rest);
    case 'list':
      return list(rest);
    case 'import':
      return importFile(rest);
    default:
      die(USAGE);
  }
}

// Asked for, not taken as arguments: a password typed into a prompt is not in the shell history, not
// in an agent's transcript and not in a process list. A pipe answers too, one line per question.
async function add(args: string[]): Promise<void> {
  config().needProject();
  const name = args[0];
  if (!name) die('usage: vysu persona add <name>');
  personaCheckName(name);
  const email = await ask(`e-mail for ${name}: `);
  if (!email) die('persona add: no e-mail');
  const password = await askSecret(`password for ${name} (not echoed): `);
  if (!password) die('persona add: no password');
  personaWrite(personaKey(name, 'EMAIL'), email);
  personaWrite(personaKey(name, 'PASSWORD'), password);
  console.log(`persona ${name}: ${email} → ${config().personas} (mode 600)`);
}

// Any other key a connector or a driver reads: an FCM token, an auth id, a residence — free-form on
// purpose, since only the project knows what its own commands need.
async function set(args: string[]): Promise<void> {
  config().needProject();
  const [name, key, value = ''] = args;
  if (!name || !key) die('usage: vysu persona set <name> <KEY> <value>');
  personaCheckName(name);
  personaWrite(personaKey(name, key), value);
  const k = key.toUpperCase();
  console.log(k === 'PASSWORD' || k.endsWith('TOKEN') || k.endsWith('SECRET') ? `persona ${name}: ${key} set` : `persona ${name}: ${key} = ${value}`);
}

// Names and the non-secret keys, never a value that reads as a credential: `--json` is what a project
// command consumes (`vysu persona list --json`).
async function list(args: string[]): Promise<void> {
  const json = args[0] === '--json';
  if (!existsSync(config().personas)) {
    // A consumer asking for JSON gets an empty list, not a failure: no persona yet is an answer.
    if (!json) die(`no ${config().personas} (vysu persona add <name>)`);
    console.log('[]');
    return;
  }
  const people = personaList();
  if (json) {
    console.log(JSON.stringify(people, null, 1));
    return;
  }
  for (const p of people) {
    const keys = Object.keys(p)
      .filter((k) => k !== 'name' && k !== 'email')
      .sort()
      .join(' ');
    console.log(`${p.name}: ${p.email ?? '(no e-mail)'}${keys ? ` · ${keys}` : ''}`);
  }
}

// The one-off that replaces a vault: an existing env file of credentials read into this project's
// personas. `--to` writes elsewhere than the state folder, which is how a converted file is tried
// before it is adopted.
async function importFile(args: string[]): Promise<void> {
  const file = args[0];
  if (!file) die('usage: vysu persona import <file> [--prefix <P>] [--to <file>]');
  if (!existsSync(file)) die(`no file ${file}`);
  let prefix = '';
  let to = config().personas;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--prefix') prefix = args[++i] ?? '';
    else if (args[i] === '--to') to = args[++i] ?? '';
    else die(`vysu persona import: unknown option ${args[i]}`);
  }
  try {
    for (const line of personaImport(file, to, prefix)) console.log(line);
  } catch {
    die(`persona import: could not read ${file}`);
  }
}
