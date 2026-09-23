// One reader for « a file, or stdin »: a flow and a recording both take « - ». A line per step, the
// last one kept without its newline, a carriage return left by a Windows editor dropped.
import { readFileSync, statSync } from 'node:fs';

export function readLines(file: string): string[] {
  const text = readFileSync(file === '-' ? 0 : file, 'utf8');
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
