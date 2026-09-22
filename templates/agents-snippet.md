## Visual verification (`vysu`)

UI work is checked on the real app before the merge request, with `vysu`: a real browser and a real
simulator / emulator, one session per persona whose login is kept, captures written outside every
repo, a 25-line text report before any image.

- **Done means**: every web screen the change touches walked
  (`vysu walk <persona> <name> --url <origin>/<path> --baseline-url @`, `check: clean`), every
  mobile screen on the recent **and** the old device plus `vysu textsize <platform> xl`, and any
  notification it touches triggered for real (`vysu push …`).
  `vysu report <name> --md` goes into the `## Tests` section of the merge request.
- **Skills**: `visual-check` (the loop, commands, diffs, mobile, notifications) and `demo-video`
  (a recording turned into an explainer video), installed by `vysu init`.
- **Values live in** `.vysu/config` (origin, baseline, devices, services, push, theme);
  `vysu persona list` for the personas, `vysu doctor` for what is resolved and what is missing.
- No Playwright or MSW harness to "see" a screen, and no captures committed.
