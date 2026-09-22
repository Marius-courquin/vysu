import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import { cutSchema, eventsSchema, outTimeOrNext, resolveCut, totalSeconds } from '../src/cut.ts';
import {
  explainerSchema,
  FORMAT_SUFFIX,
  FPS,
  themeSchema,
  type Clip,
  type ExplainerProps,
  type Format,
  type Theme,
} from '../src/schema.ts';

// node scripts/render.ts --take <dir> [--format landscape|portrait|all] [--check] [--draft]
//                        [--out <dir>] [--props-only]
// Reads the take's cut.json (and events.json when the recorder wrote one), resolves it into the
// props of the Explainer composition and renders one mp4 per format. Output paths go to stdout,
// one per line; progress goes to stderr.

const ROOT = path.resolve(import.meta.dirname, '..');
const CHECK_STILLS = 6;
// The two scene stills of the sheet: the Opening once the loader has finished and the title is in,
// the Finish once its card has risen.
const CHECK_OPENING_AT = 2.4;
const CHECK_FINISH_BEFORE_END = 1.2;
const CHECK_LONG_EDGE = 1568;

const log = (message: string) => process.stderr.write(`${message}\n`);

function fail(message: string): never {
  process.stderr.write(`render: ${message}\n`);
  process.exit(1);
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read ${file}: ${(error as Error).message}`);
  }
}

// staticFile() only serves what sits under public/, so a file the engine does not own has to be
// copied in first. Same rule as the take's clip below: copy when missing or when the size differs.
function serveFile(source: string, servedDir: string): string {
  fs.mkdirSync(servedDir, { recursive: true });
  const target = path.join(servedDir, path.basename(source));
  if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(source).size) {
    fs.copyFileSync(source, target);
  }
  return path.basename(target);
}

// A theme is looked up in the PROJECT first — themes/<name>/ beside the config the engine loaded —
// so a project carries its own brand without touching the engine, and only then among the engine's
// own themes. $VYSU_DIR is that folder, $VYSU_PROJECT_DIR/.vysu in the ordinary case and not when a
// config lives in a worktree while the project dir stays the checkout its paths point into.
function loadTheme(name: string): Theme {
  const dirs = [process.env.VYSU_DIR, process.env.VYSU_PROJECT_DIR ? path.join(process.env.VYSU_PROJECT_DIR, '.vysu') : ''];
  const candidates = dirs
    .filter((d): d is string => Boolean(d))
    .map((d) => path.join(path.resolve(expandHome(d)), 'themes', name, 'theme.json'));
  const projectFile = candidates.find((f) => fs.existsSync(f)) ?? null;
  const engineFile = path.join(ROOT, 'themes', name, 'theme.json');
  const fromProject = projectFile !== null;
  const file = fromProject ? projectFile! : engineFile;
  if (!fs.existsSync(file)) {
    const looked = candidates.length > 0 ? candidates : ['$VYSU_DIR/themes/' + name + '/theme.json'];
    fail(`unknown theme "${name}": no ${[...looked, engineFile].join(' and no ')}`);
  }
  const parsed = themeSchema.safeParse(readJson(file));
  if (!parsed.success) fail(`${file} is invalid:\n${issues(parsed.error)}`);
  const theme = parsed.data;
  if (!fromProject) return theme;

  // A project theme names its fonts and logo relative to ITS OWN folder, which the bundler cannot
  // serve: the files are copied under public/themes/<name>/ and the paths rewritten to match. The
  // engine's own themes already point inside public/ (fonts/…, brand/…), so they are left alone.
  const themeDir = path.dirname(file);
  const servedDir = path.join(ROOT, 'public', 'themes', name);
  const serve = (relative: string): string => {
    const source = path.resolve(themeDir, relative);
    if (!fs.existsSync(source)) fail(`theme "${name}" references a missing file: ${source}`);
    return `themes/${name}/${serveFile(source, servedDir)}`;
  };
  return {
    ...theme,
    fonts: {
      ...theme.fonts,
      faces: theme.fonts.faces.map((face) => ({ ...face, file: serve(face.file) })),
    },
    ...(theme.logo
      ? { logo: { lockup: serve(theme.logo.lockup), mark: serve(theme.logo.mark) } }
      : {}),
  };
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

async function probeClip(file: string): Promise<{ width: number; height: number; fps: number; duration: number }> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) fail(`${file} has no video track`);
  const duration = await input.computeDuration();
  return {
    width: track.displayWidth,
    height: track.displayHeight,
    fps: Math.round((await track.computePacketStats(60)).averagePacketRate) || FPS,
    duration,
  };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}\n${stderr.slice(-2000)}`)),
    );
  });
}

// --- CLI --------------------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    take: { type: 'string' },
    format: { type: 'string' },
    check: { type: 'boolean', default: false },
    draft: { type: 'boolean', default: false },
    out: { type: 'string' },
    'props-only': { type: 'boolean', default: false },
  },
});

if (!values.take) fail('missing --take <dir> (a take folder under the vysu shots directory)');
const takeDir = path.resolve(expandHome(values.take));
if (!fs.statSync(takeDir, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`no such take directory: ${takeDir}`);
}
const takeName = path.basename(takeDir);

const cutFile = path.join(takeDir, 'cut.json');
if (!fs.existsSync(cutFile)) fail(`${cutFile} not found (write the montage script first)`);
const cutParsed = cutSchema.safeParse(readJson(cutFile));
if (!cutParsed.success) fail(`${cutFile} is invalid:\n${issues(cutParsed.error)}`);
const cut = cutParsed.data;

const eventsFile = path.join(takeDir, 'events.json');
let events = null;
if (fs.existsSync(eventsFile)) {
  const parsed = eventsSchema.safeParse(readJson(eventsFile));
  if (!parsed.success) fail(`${eventsFile} is invalid:\n${issues(parsed.error)}`);
  events = parsed.data;
}

const asked = values.format ?? 'all';
const formats: Format[] =
  asked === 'all'
    ? (cut.formats ?? ['landscape'])
    : asked === 'landscape' || asked === 'portrait'
      ? [asked]
      : fail(`--format must be landscape, portrait or all (got "${asked}")`);

// --- The clip ---------------------------------------------------------------------------------

const clipName =
  cut.clip?.file ??
  events?.clip ??
  fs.readdirSync(takeDir).find((f) => f.endsWith('.mp4') && !f.includes('-framed'));
if (!clipName) fail(`no clip in ${takeDir}: name it in cut.json ("clip": { "file": "…" })`);
const clipFile = path.join(takeDir, clipName);
if (!fs.existsSync(clipFile)) fail(`clip not found: ${clipFile}`);

const probe = await probeClip(clipFile);
const logical = events?.size ?? cut.clip?.size ?? { w: probe.width, h: probe.height };

// staticFile() only serves what sits under public/, so the take's clip is copied in (gitignored).
const publicTake = path.join(ROOT, 'public', 'takes', takeName);
fs.mkdirSync(publicTake, { recursive: true });
const servedClip = path.join(publicTake, clipName);
if (
  !fs.existsSync(servedClip) ||
  fs.statSync(servedClip).size !== fs.statSync(clipFile).size
) {
  fs.copyFileSync(clipFile, servedClip);
}

const clip: Clip = {
  src: `takes/${takeName}/${clipName}`,
  width: probe.width,
  height: probe.height,
  fps: probe.fps,
  logical: { w: logical.w, h: logical.h },
};

const theme = loadTheme(cut.theme ?? 'default');
const propsOf = (f: Format): ExplainerProps => {
  let resolved;
  try {
    resolved = resolveCut({
      cut,
      events,
      theme,
      format: f,
      clip,
      clipDuration: probe.duration,
      name: cut.take ?? takeName,
    });
  } catch (error) {
    fail(`${cutFile}: ${(error as Error).message}`);
  }
  const checked = explainerSchema.safeParse(resolved);
  if (!checked.success) fail(`resolved props are invalid:\n${issues(checked.error)}`);
  return checked.data;
};

// Resolved up front so a bad cut.json fails before the browser and the bundle are paid for.
const props = new Map(formats.map((f) => [f, propsOf(f)] as const));

if (values['props-only']) {
  for (const f of formats) {
    const file = path.join(publicTake, `props-${FORMAT_SUFFIX[f]}.json`);
    fs.writeFileSync(file, `${JSON.stringify(props.get(f)!, null, 2)}\n`);
    process.stdout.write(`${file}\n`);
  }
  process.exit(0);
}

const outDir = path.resolve(expandHome(values.out ?? path.join(takeDir, 'video')));
fs.mkdirSync(outDir, { recursive: true });

// --- Render -----------------------------------------------------------------------------------

log(`take ${takeName}: ${cut.keep?.length ?? 0} kept segments, formats ${formats.join(', ')}`);
await ensureBrowser();

const started = Date.now();
const serveUrl = await bundle({
  entryPoint: path.join(ROOT, 'src', 'index.ts'),
  // Webpack caches in node_modules/.cache between runs, so a second render only re-links.
  onProgress: (percent) => {
    if (percent === 100) log(`bundle ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  },
});

for (const f of formats) {
  const resolved = props.get(f)!;
  const suffix = FORMAT_SUFFIX[f];
  const composition = await selectComposition({
    serveUrl,
    id: 'Explainer',
    inputProps: resolved,
  });
  const seconds = composition.durationInFrames / composition.fps;
  log(`${suffix}: ${composition.width}x${composition.height}, ${seconds.toFixed(1)}s`);

  // --check is the cheap loop: the contact sheet alone, no mp4, so a cut can be read and fixed
  // before a single frame of video is encoded.
  if (values.check) {
    const sheet = await renderCheckSheet({
      serveUrl,
      props: resolved,
      composition,
      outFile: path.join(outDir, `${takeName}-${suffix}-check.png`),
    });
    process.stdout.write(`${sheet}\n`);
    continue;
  }

  const video = path.join(outDir, `${takeName}-${suffix}.mp4`);
  const clock = Date.now();
  let lastLogged = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    imageFormat: 'jpeg',
    outputLocation: video,
    inputProps: resolved,
    overwrite: true,
    ...(values.draft
      ? { hardwareAcceleration: 'if-possible' as const, videoBitrate: '8M' }
      : { crf: 18 }),
    onProgress: ({ progress }) => {
      const step = Math.floor(progress * 10);
      if (step > lastLogged) {
        lastLogged = step;
        log(`${suffix}: ${step * 10}%`);
      }
    },
  });
  log(`${suffix}: rendered in ${((Date.now() - clock) / 1000).toFixed(1)}s`);
  process.stdout.write(`${video}\n`);

  // The poster is the first chapter's frame: the product on screen, never the intro card.
  const firstChapter = resolved.chapters[0];
  const posterSeconds =
    resolved.openingSeconds +
    (firstChapter ? outTimeOrNext(resolved.segments, firstChapter.at) + 0.4 : 0.4);
  const posterFrame = Math.round(posterSeconds * composition.fps);
  const poster = path.join(outDir, `${takeName}-${suffix}-poster.jpg`);
  await renderStill({
    composition,
    serveUrl,
    inputProps: resolved,
    output: poster,
    overwrite: true,
    imageFormat: 'jpeg',
    jpegQuality: 90,
    frame: Math.min(posterFrame, composition.durationInFrames - 1),
  });
  process.stdout.write(`${poster}\n`);

}

// Six stills — the Opening once the lockup is assembled, four spread over the montage, the Finish
// once its card has risen — tiled with ffmpeg into one sheet an agent can read in a single image.
async function renderCheckSheet(input: {
  serveUrl: string;
  props: ExplainerProps;
  composition: Awaited<ReturnType<typeof selectComposition>>;
  outFile: string;
}): Promise<string> {
  const { serveUrl, props, composition, outFile } = input;
  const openingFrames = Math.round(props.openingSeconds * composition.fps);
  const montageFrames = Math.round(totalSeconds(props.segments) * composition.fps);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explainer-check-'));
  try {
    for (let i = 0; i < CHECK_STILLS; i += 1) {
      const frame =
        i === 0
          ? Math.round(CHECK_OPENING_AT * composition.fps)
          : i === CHECK_STILLS - 1
            ? composition.durationInFrames - Math.round(CHECK_FINISH_BEFORE_END * composition.fps)
            : openingFrames + Math.round((montageFrames * i) / (CHECK_STILLS - 1));
      await renderStill({
        composition,
        serveUrl,
        inputProps: props,
        output: path.join(tmp, `s${String(i).padStart(2, '0')}.png`),
        overwrite: true,
        imageFormat: 'png',
        frame: Math.min(Math.max(0, frame), composition.durationInFrames - 1),
      });
    }
    const cols = 3;
    const rows = Math.ceil(CHECK_STILLS / cols);
    const sheetW = composition.width * cols;
    const sheetH = composition.height * rows;
    const scale =
      sheetW >= sheetH ? `${CHECK_LONG_EDGE}:-2` : `-2:${CHECK_LONG_EDGE}`;
    await run('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      path.join(tmp, 's%02d.png'),
      '-filter_complex',
      `tile=${cols}x${rows}:margin=6:padding=6:color=0x00000000,scale=${scale}:flags=lanczos`,
      '-frames:v',
      '1',
      outFile,
    ]);
    return outFile;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
