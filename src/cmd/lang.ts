// `vysu lang <persona> <lang>`: the web app's language (the localStorage key the project names),
// then a reload, since the key is read at boot only.
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { setLang } from '../web/page.ts';

export async function run(args: string[]): Promise<void> {
  const [persona, lang] = args;
  if (!persona || !lang) die('usage: vysu lang <persona> <lang>');
  await setLang(persona, lang);
  console.log(`${persona}: ${config().get('LANG_STORAGE_KEY')} = ${lang}`);
}
