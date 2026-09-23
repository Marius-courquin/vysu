// The one command that installs a missing tool, for the machine the report is read on: Homebrew on
// macOS, the distribution's package manager on Linux (apt or dnf), winget on Windows. A line that
// names a command the reader cannot run is noise, so each OS gets its own.
import { isMac, isWindows, which } from '../core/host.ts';

export type Need = 'node' | 'ffmpeg' | 'git' | 'xcode' | 'android' | 'gh';

type Os = 'mac' | 'apt' | 'dnf' | 'linux' | 'windows';

export function hostOs(): Os {
  if (isMac) return 'mac';
  if (isWindows) return 'windows';
  if (which('apt-get')) return 'apt';
  if (which('dnf')) return 'dnf';
  return 'linux';
}

const HINTS: Record<Need, Record<Os, string>> = {
  node: {
    mac: 'brew install node',
    // The distributions ship an older Node than the engine needs: NodeSource's is the current one.
    apt: 'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs',
    dnf: 'sudo dnf install nodejs',
    linux: 'https://nodejs.org/en/download (>= 22.18)',
    windows: 'winget install OpenJS.NodeJS.LTS',
  },
  ffmpeg: {
    mac: 'brew install ffmpeg',
    apt: 'sudo apt-get install -y ffmpeg',
    dnf: 'sudo dnf install ffmpeg-free',
    linux: 'https://ffmpeg.org/download.html',
    windows: 'winget install Gyan.FFmpeg',
  },
  git: {
    mac: 'xcode-select --install',
    apt: 'sudo apt-get install -y git',
    dnf: 'sudo dnf install git',
    linux: 'https://git-scm.com/downloads',
    windows: 'winget install Git.Git',
  },
  xcode: {
    mac: 'xcode-select --install',
    apt: '',
    dnf: '',
    linux: '',
    windows: '',
  },
  android: {
    mac: 'brew install --cask android-commandlinetools',
    apt: 'sudo snap install android-studio --classic',
    dnf: 'sudo snap install android-studio --classic',
    linux: 'https://developer.android.com/studio',
    windows: 'winget install Google.AndroidStudio',
  },
  gh: {
    mac: 'brew install gh && gh auth login',
    apt: 'sudo apt-get install -y gh && gh auth login',
    dnf: 'sudo dnf install gh && gh auth login',
    linux: 'https://cli.github.com (then gh auth login)',
    windows: 'winget install GitHub.cli && gh auth login',
  },
};

export function installHint(need: Need): string {
  return HINTS[need][hostOs()];
}
