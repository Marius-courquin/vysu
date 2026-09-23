// The Chromium-based browsers this machine already has. Safari and Firefox are not on the list:
// agent-browser drives Chromium through CDP and neither speaks it.
import { accessSync, constants, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isMac, isWindows, which } from '../core/host.ts';

const MAC_APPS = ['Brave Browser', 'Google Chrome', 'Microsoft Edge', 'Chromium'];
const LINUX_COMMANDS = ['brave-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser'];

export function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!isWindows) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsCandidates(): string[] {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((r): r is string => !!r);
  const rel = [
    ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Chromium', 'Application', 'chrome.exe'],
  ];
  const out: string[] = [];
  for (const r of rel) for (const root of roots) out.push(join(root, ...r));
  return out;
}

// One executable path per browser actually installed, in the order a reader would expect them.
export function browsersFound(): string[] {
  let candidates: string[];
  if (isMac) candidates = MAC_APPS.map((app) => `/Applications/${app}.app/Contents/MacOS/${app}`);
  else if (isWindows) candidates = windowsCandidates();
  else candidates = LINUX_COMMANDS.map((c) => which(c)).filter(Boolean);
  const seen = new Set<string>();
  return candidates.filter((p) => {
    if (seen.has(p) || !isExecutable(p)) return false;
    seen.add(p);
    return true;
  });
}

// What a browser is called in a line: its executable's name.
export function browserLabel(path: string): string {
  return basename(path).replace(/\.exe$/i, '');
}
