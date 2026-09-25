// The project's personas: the `personas.env` file under $VYSU_STATE (mode 600) and the
// `VYSU_PERSONA_<NAME>_<KEY>` lookup every connector and driver reads its credentials through.
// Nothing here ever prints a password.
//
// A key is `<prefix><NAME>_<FIELD>` and both halves may hold underscores (`tb_non_verifie`,
// `FCM_TOKEN_IOS`), so no regex can split it. A persona is declared by its `_EMAIL` key; every other
// key belongs to the longest declared name it starts with; a key that belongs to none (an id a project
// kept next to its credentials) is nobody's. An `_EMAIL` key under a declared name, with no
// `_PASSWORD` of its own, is that persona's field (`RESIDENT_BACKUP_EMAIL`), not a persona of its own.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './ctx.ts';
import { readShellEnv } from './config.ts';
import { die } from './errors.ts';
import { shellQuote } from './shellenv.ts';
import { slug } from './text.ts';

export const PREFIX = 'VYSU_PERSONA_';
const SECRET = /(PASSWORD|TOKEN|SECRET|KEY)$/;

let loaded: Map<string, string> | undefined;

export function loadPersonas(): Map<string, string> {
  if (loaded) return loaded;
  const file = config().personas;
  if (!existsSync(file)) die(`no ${file} (vysu persona add <name>)`);
  loaded = readShellEnv(file, (n) => config().fileVars.get(n) ?? process.env[n]);
  return loaded;
}

export function personaKey(persona: string, key: string): string {
  return `${PREFIX}${persona.toUpperCase()}_${key.toUpperCase()}`;
}

// A persona's extra browser sessions: `alice@2` is alice's credentials in a session of its own, so
// two agents checking as alice at the same time each drive their own browser instead of taking turns
// on one. `alice@1` is alice. A slot logs in by itself and is never handed a copy of alice's login: an
// identity provider that rotates its refresh tokens (Auth0 does) revokes the whole family the moment
// two sessions refresh with the same one, and both would find themselves logged out. The anonymous
// session has slots too (`-@2`): two agents on a public page each get a browser of their own.
export interface PersonaRef {
  base: string;
  slot: number;
}
export function personaSlot(ref: string): PersonaRef {
  const at = ref.indexOf('@');
  if (at < 0) return { base: ref, slot: 1 };
  const base = ref.slice(0, at);
  const n = ref.slice(at + 1);
  if (!/^([A-Za-z0-9_]+|-)$/.test(base) || !/^[1-9][0-9]?$/.test(n)) die(`persona '${ref}': a session slot is <persona>@<2-99> (alice@2, -@2)`);
  return { base, slot: Number(n) };
}
export const personaBase = (ref: string): string => personaSlot(ref).base;
// The name a slot goes by everywhere: `alice@1` is written `alice`.
export function personaRefName(base: string, slot: number): string {
  return slot > 1 ? `${base}@${slot}` : base;
}
// What a persona's session is called in agent-browser (letters, digits, - and _), and what its lock
// and its claim are called. A persona's slug never holds two dashes in a row, so `--2` is a slot's alone
// (the anonymous session is `web--`, its slots `web----2`).
export function personaSessionSuffix(ref: string): string {
  const { base, slot } = personaSlot(ref);
  return slot > 1 ? `${base}--${slot}` : base;
}
export function webResource(ref: string): string {
  const { base, slot } = personaSlot(ref);
  return `web-${slug(base)}${slot > 1 ? `--${slot}` : ''}`;
}

// Any key the project set (`vysu persona set alice TOTP …`), from the file, else the config or the
// environment, which is where a sourced file finds a variable it does not set.
export function personaVar(persona: string, key: string): string {
  const k = `${PREFIX}${personaBase(persona).toUpperCase()}_${key}`;
  const file = existsSync(config().personas) ? loadPersonas() : new Map<string, string>();
  return file.get(k) ?? config().fileVars.get(k) ?? process.env[k] ?? '';
}

// The credentials a login needs, loaded and checked in one place: every connector starts here.
export function personaRequire(persona: string): { email: string; password: string } {
  loadPersonas();
  const email = personaVar(persona, 'EMAIL');
  const password = personaVar(persona, 'PASSWORD');
  if (!email || !password) die(`persona '${personaBase(persona)}' not in ${config().personas} (vysu persona add ${persona})`);
  return { email, password };
}

// A name is part of a variable name: `tb-x` or `tb.x` would write a line bash cannot source.
export function personaCheckName(name: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(name)) die(`persona '${name}': letters, digits and _ only (the name is part of a variable name)`);
}

// {KEY without the prefix, upper-cased: raw value} for the keys that carry the prefix.
export function readPairs(path: string, prefix: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    if (key.toUpperCase().startsWith(prefix.toUpperCase()) && key.length > prefix.length) {
      pairs.set(key.slice(prefix.length).toUpperCase(), line.slice(eq + 1));
    }
  }
  return pairs;
}

export function names(pairs: Map<string, string>): string[] {
  const declared = new Set<string>();
  for (const k of pairs.keys()) if (k.endsWith('_EMAIL') && k.length > 6) declared.add(k.slice(0, -6));
  const isAField = (name: string): boolean => {
    if (pairs.has(`${name}_PASSWORD`)) return false;
    return [...declared].some((other) => other !== name && name.startsWith(`${other}_`));
  };
  return [...declared].filter((n) => !isAField(n)).sort();
}

export function split(pairs: Map<string, string>): { people: Map<string, Map<string, string>>; orphans: string[] } {
  const longestFirst = names(pairs).sort((a, b) => b.length - a.length);
  const people = new Map<string, Map<string, string>>();
  const orphans: string[] = [];
  for (const [key, value] of pairs) {
    const owner = longestFirst.find((n) => key.startsWith(`${n}_`));
    if (owner === undefined) {
      orphans.push(key);
      continue;
    }
    if (!people.has(owner)) people.set(owner, new Map());
    people.get(owner)!.set(key.slice(owner.length + 1), value);
  }
  return { people, orphans: orphans.sort() };
}

// The personas the file declares, lower-case, one per name.
export function personaNames(): string[] {
  const file = config().personas;
  if (!existsSync(file)) return [];
  return names(readPairs(file, PREFIX)).map((n) => n.toLowerCase());
}

const stripQuotes = (v: string): string => v.replace(/^["']+|["']+$/g, '');

export interface ListedPersona {
  name: string;
  [field: string]: string | boolean;
}

// Names and the non-secret keys: a secret is declared, never carried.
export function personaList(): ListedPersona[] {
  const { people } = split(readPairs(config().personas, PREFIX));
  return [...people.keys()].sort().map((name) => {
    const person: ListedPersona = { name: name.toLowerCase() };
    for (const [field, value] of people.get(name)!) person[field.toLowerCase()] = SECRET.test(field) ? true : stripQuotes(value);
    return person;
  });
}

// A key is written once and rewritten in place: the file stays readable, and a `set` never leaves two
// lines for the same variable behind. Quoted, so a password with a `$` or a quote reads back as typed.
export function personaWrite(key: string, value: string): void {
  const file = config().personas;
  mkdirSync(dirname(file), { recursive: true });
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${key}=`)) : [];
  lines.push(`${key}=${shellQuote(value)}`);
  writeFileSync(`${file}.tmp`, `${lines.join('\n')}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  chmodSync(file, 0o600);
  loaded = undefined;
}

// An existing env file of credentials, whatever its prefix, read into this project's personas. Keys
// that belong to no persona are named and left behind: they are the project's config.
export function personaImport(source: string, target: string, prefix: string): string[] {
  const { people, orphans } = split(readPairs(source, prefix));
  const kept = new Map<string, string>();
  if (existsSync(target)) {
    for (const raw of readFileSync(target, 'utf8').split('\n')) {
      if (raw.includes('=') && !raw.trimStart().startsWith('#')) kept.set(raw.split('=')[0]!.trim(), raw);
    }
  }
  let added = 0;
  for (const [name, fields] of people) {
    for (const [field, value] of fields) {
      const key = `${PREFIX}${name}_${field}`;
      kept.set(key, `${key}=${value}`);
      added++;
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  // Created 600, not chmod-ed after the fact: the credentials are never readable by anyone else.
  writeFileSync(`${target}.tmp`, [...kept.keys()].sort().map((k) => `${kept.get(k)}\n`).join(''), { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
  chmodSync(target, 0o600);
  const out = [
    `persona import: ${added} key(s), ${people.size} persona(s) from ${source} → ${target} (mode 600)`,
    `personas: ${[...people.keys()].map((n) => n.toLowerCase()).sort().join(' ')}`,
  ];
  if (orphans.length) out.push(`skipped, no persona of theirs: ${orphans.map((k) => prefix + k).join(' ')}`);
  return out;
}
