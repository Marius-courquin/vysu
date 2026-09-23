// `vysu checker [--for <agent family>]`: how to delegate a visual check. The brief lives in the
// skill; the model the checker sub-agent runs on is VYSU_CHECKER_MODELS for the calling agent tool.
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { checkerFamily, checkerModel } from '../setup/checker.ts';

export async function run(args: string[]): Promise<void> {
  let family = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--for' && i + 1 < args.length) family = args[++i]!;
    else die('usage: vysu checker [--for <agent family>]');
  }
  family ||= checkerFamily();
  const model = checkerModel(family);
  console.log('checker: delegate device and multi-screen checks to a sub-agent (brief and report: skill visual-check, references/delegate.md)');
  if (model) console.log(`model for ${family}: ${model} (VYSU_CHECKER_MODELS, ${config().origin('CHECKER_MODELS')})`);
  else console.log(`model for ${family}: inherit the caller's (VYSU_CHECKER_MODELS names none for ${family})`);
}
