# vysu

Look at a real app the way a reviewer does, in tokens an agent can afford.

vysu ("visu") drives a real browser, an iOS simulator and an Android emulator against the app you
are building: one session per persona whose login survives across runs, screenshots and diffs kept
outside every repo, a 25-line text report before any image, and a recorded flow that becomes a demo
video. It works the same for Claude Code, Codex, or a human in a terminal.

## Install

```bash
git clone https://github.com/Marius-courquin/vysu ~/vysu
echo 'export PATH="$HOME/vysu/bin:$PATH"' >> ~/.zshrc && exec zsh
vysu setup                     # tools, browser, simulators, emulators (asks before creating devices)
```

Then, in your project:

```bash
vysu init                      # writes .vysu/config, picks an auth connector, installs the agent skills
vysu persona add alice         # e-mail + password, stored under ~/.vysu/<project>/ (mode 600)
vysu login alice               # once; the session is kept
vysu walk alice home --url http://localhost:3000/
```

`vysu update` pulls the latest engine. `vysu doctor` says what is configured and what is missing.

## Status

Being extracted from the Nidz monorepo (`tools/visual/nv`). The design note is
[docs/design.md](docs/design.md); the lots are listed at its end. Nothing here is usable before
lot 1 lands.

## License

MIT.
