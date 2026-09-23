// The visible label of an i18n key (`tap t:screen.home.title`), in the language the app was last
// launched in, and the languages a project declares.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './ctx.ts';
import { die } from './errors.ts';
import { commaList } from './text.ts';

// An interpolated value (« {{n}} messages ») keeps its longest literal piece, which a tap then
// matches with its « contains » fallback.
export function i18nLabel(lang: string, key: string): string {
  const dir = config().locales;
  if (!dir) die('t:<key> needs VYSU_LOCALES (the folder holding <lang>.json)');
  const file = join(dir, `${lang}.json`);
  if (!existsSync(file)) die(`no locale file ${file} (VYSU_LOCALES)`);
  let d: unknown = JSON.parse(readFileSync(file, 'utf8'));
  for (const part of key.split('.')) {
    if (!d || typeof d !== 'object' || Array.isArray(d) || !(part in d)) die(`no i18n key « ${key} » in ${file}`);
    d = (d as Record<string, unknown>)[part];
  }
  if (typeof d !== 'string') die(`i18n key « ${key} » is not a label`);
  const pieces = d.split(/{{[^}]*}}/).map((p) => p.trim());
  // max() keeps the first of equal lengths.
  const literal = pieces.reduce((best, p) => (p.length > best.length ? p : best), pieces[0] ?? '');
  if (!literal) die(`i18n key « ${key} » is all interpolation (${d})`);
  return literal;
}

// A language the project declares, or the default one. A flow that names none takes VYSU_LANG.
export function langCheck(lang: string): void {
  if (!lang) return;
  const langs = config().get('LANGS');
  if (!langs) die('--lang needs VYSU_LANGS (the languages the app offers)');
  if (commaList(langs).includes(lang) || `,${langs},`.includes(`,${lang},`)) return;
  die(`--lang is one of ${langs}`);
}
