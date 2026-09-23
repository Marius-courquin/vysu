# Parity scripts

Each script runs a reference engine and this one on the same inputs, in mirrored scratch folders,
and compares what they print, their exit codes and the files they write. The reference is a bash
vysu, named by `VYSU_REF`:

    git archive v0.5.1 | tar -x -C <dir> && export VYSU_REF=<dir>/bin/vysu

Without it every script stops on that line (`hooks.sh`, which compares two hooks of this engine,
needs none). The image scripts run the reference's Python helpers (`<dir>/py/<name>.py`, python3
with numpy and Pillow) against the modules of `src/img/`; the others run the reference's `vysu`
against `bin/vysu`.

| Script | Needs | Compares |
|---|---|---|
| `platform.sh <scratch> [--take <dir>] [--video]` | nothing | version, checker, doctor, setup `--dry-run`, init, up / down of scratch services, cut |
| `img.sh <inputs> <scratch>` | inputs from `img-inputs.sh [<state>] <inputs>` (copies of real shots) | every image helper: `diff.ts`, `verdict.ts`, `compare.ts`, `stitch.ts`, `fields.ts`, `burst.ts`, `motion.ts`, `take.ts`, `screen.ts`, `frame.ts`, `screencap.ts` |
| `web-cases.ts [--only <case,…>] [--skip <case,…>]` | a project (`--project`, default nidz-env) and a browser; `cache` and `prune` need neither | passthrough, check, box, lang, shots, walk, flow, rec, the project's personas, cache, prune `--dry-run` |
| `auth-cases.ts` | a browser | the auth connectors on a login form served on 127.0.0.1 |
| `push.sh <scratch>` | nothing | the push drivers against fake FCM and webhook endpoints |
| `update.sh <scratch>` | nothing | `vysu update` on two scratch clones of this engine |
| `mobile.sh <scratch> <cases>` | a claimed simulator or emulator (`VYSU_OWNER`) | one command per line of a case file (`mobile/*.cases`) |
| `hooks.sh <scratch>` | nothing (no reference) | the Stop hook, `stop-reminder.sh` against `stop-reminder.mjs` |

A deliberate difference from the reference is filtered out where the script says so (`KNOWN` in
`platform.sh`, `ignore` in a web case): the doctor's and setup's python3 and helper lines, which
this engine no longer has, and each helper naming itself without `.py`.
