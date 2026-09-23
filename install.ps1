# vysu installer for Windows: clones (or updates) the engine, installs its dependencies and puts
# `vysu` on the PATH. The same steps as install.sh, in PowerShell (5.1, the one every Windows has, or 7).
#
#   irm https://raw.githubusercontent.com/Marius-courquin/vysu/main/install.ps1 | iex
#
# While the repository is private, the raw file above is not reachable: log in once with the GitHub
# CLI (`winget install GitHub.cli`, then `gh auth login`), then
#   gh repo clone Marius-courquin/vysu $HOME\vysu
#   powershell -ExecutionPolicy Bypass -File $HOME\vysu\install.ps1
#
# What it does, in order:
#   1. git clone https://github.com/Marius-courquin/vysu into $env:VYSU_INSTALL_DIR (default
#      $HOME\vysu), or `git pull` when it is already there;
#   2. checks node >= 22.18, which the engine runs on, and installs the engine's own dependencies in
#      its folder (`npm ci --omit=dev`: sharp, for sheets and diffs);
#   3. adds <engine>\bin to your user PATH (the one every new terminal reads) and to this session's:
#      `vysu` is bin\vysu.cmd;
#   4. checks that `vysu version` answers, and says what to do next.
# Nothing else is installed here: `vysu setup` does the tools. The iOS simulator needs a Mac; the
# browser and the Android emulator work here.
#
# The file is ASCII on purpose: Windows PowerShell 5.1 reads a script without a byte-order mark in
# the system code page, so the report markers are built from their code points.

$Repo = if ($env:VYSU_REPO) { $env:VYSU_REPO } else { 'https://github.com/Marius-courquin/vysu' }
$Dir = if ($env:VYSU_INSTALL_DIR) { $env:VYSU_INSTALL_DIR } else { Join-Path $HOME 'vysu' }
# Run as a file, a failure ends the script with exit 1; piped into iex, `exit` would close the
# reader's own PowerShell window, so the script stops there instead.
$AsFile = [bool]$MyInvocation.MyCommand.Path

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$Color = -not $env:NO_COLOR
$MarkOk = [string][char]0x2713
$MarkInfo = [string][char]0x00B7
$Dash = [string][char]0x2014
$script:OkN = 0
$script:WarnN = 0

function Write-Mark([string]$Mark, [string]$Colour) {
  if ($Color) { Write-Host $Mark -ForegroundColor $Colour -NoNewline } else { Write-Host $Mark -NoNewline }
}
function Say-Ok([string]$Text) { Write-Mark $MarkOk 'Green'; Write-Host " $Text"; $script:OkN++ }
function Say-Warn([string]$Text) { Write-Mark '!' 'Yellow'; Write-Host " $Text"; $script:WarnN++ }
function Say-Info([string]$Text) { Write-Mark $MarkInfo 'DarkGray'; Write-Host " $Text" }
function Say-Head([string]$Text) { Write-Host ''; Write-Host "## $Text" }
# One red line for what went wrong, one plain line for what to run about it.
function Stop-Install([string]$Message, [string]$Next) {
  if ($Color) { Write-Host "install: $Message" -ForegroundColor Red } else { Write-Host "install: $Message" }
  if ($Next) { Write-Host "next: $Next" }
  throw 'vysu-install-stop'
}

function Install-Vysu {
  Say-Head 'engine'
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-Install 'git is missing' 'winget install Git.Git' }

  if (Test-Path (Join-Path $Dir '.git')) {
    git -C $Dir pull -q --ff-only
    if ($LASTEXITCODE -ne 0) { Stop-Install "cannot update the checkout in $Dir" "cd $Dir; git status" }
    Say-Ok "engine: updated in $Dir"
  } elseif (Test-Path $Dir) {
    Stop-Install "$Dir exists and is not a vysu checkout" "`$env:VYSU_INSTALL_DIR = `"$HOME\vysu-engine`"; then run this installer again"
  } else {
    # A private repository needs an authenticated clone: the GitHub CLI has the login when the user
    # ran `gh auth login`; plain git only has it when a credential helper or an SSH key is set.
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $env:VYSU_REPO -and $gh) { gh auth status *> $null }
    if (-not $env:VYSU_REPO -and $gh -and $LASTEXITCODE -eq 0) {
      gh repo clone Marius-courquin/vysu $Dir -- -q *> $null
      if ($LASTEXITCODE -ne 0) { Stop-Install "cannot clone with gh $Dash is your account a collaborator of Marius-courquin/vysu?" 'gh auth status' }
    } else {
      git clone -q $Repo $Dir *> $null
      if ($LASTEXITCODE -ne 0) {
        Stop-Install "cannot clone $Repo $Dash no network, or the repository is private and this machine is not logged in" 'winget install GitHub.cli; gh auth login'
      }
    }
    Say-Ok "engine: cloned into $Dir"
  }

  # The engine is TypeScript that Node runs as it is (type stripping, 22.18 and later), on its own
  # node_modules: sharp, which every contact sheet and diff composes with.
  Say-Head 'node'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-Install "node is missing $Dash the engine runs on it (>= 22.18)" 'winget install OpenJS.NodeJS.LTS'
  }
  $nodeVersion = (node --version)
  # No double quote inside: Windows PowerShell 5.1 does not escape them for a native command.
  node -e 'const v = process.versions.node.split(''.'').map(Number); process.exit(v[0] > 22 || (v[0] === 22 && v[1] >= 18) ? 0 : 1)'
  if ($LASTEXITCODE -ne 0) { Stop-Install "node $nodeVersion is below 22.18, which the engine needs" 'winget upgrade OpenJS.NodeJS.LTS' }
  Say-Ok "node: $nodeVersion"
  # npm.cmd, not npm: under a restricted execution policy, npm.ps1 is refused.
  Push-Location $Dir
  try { npm.cmd ci --omit=dev --no-audit --no-fund --loglevel=error *> $null; $npm = $LASTEXITCODE } finally { Pop-Location }
  if ($npm -ne 0) { Stop-Install "npm ci --omit=dev failed in $Dir" "cd $Dir; npm ci --omit=dev" }
  Say-Ok 'engine: dependencies installed (npm ci --omit=dev)'

  # The user PATH, read raw so the entries written as %VAR% stay that way, then written back as an
  # expandable string; setting (and removing) a user variable through .NET is what tells Explorer,
  # and so every terminal opened from now on, that the environment changed.
  $bin = Join-Path $Dir 'bin'
  $key = Get-Item 'HKCU:\Environment'
  $userPath = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $entries = @($userPath -split ';' | Where-Object { $_ })
  $added = $false
  if ($entries -notcontains $bin) {
    New-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value (($entries + $bin) -join ';') -PropertyType ExpandString -Force | Out-Null
    [Environment]::SetEnvironmentVariable('VYSU_INSTALL_PING', '1', 'User')
    [Environment]::SetEnvironmentVariable('VYSU_INSTALL_PING', $null, 'User')
    $added = $true
  }
  if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$bin;$env:Path" }
  if ($added) { Say-Ok "path: $bin added to your user PATH" } else { Say-Ok "path: $bin already on your user PATH" }

  # The proof, through the absolute path.
  Say-Head 'check'
  $vysu = Join-Path $bin 'vysu.cmd'
  $out = @(& $vysu version 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0 -or -not $out) { Stop-Install "the engine does not answer: $($out -join ' ')" "$vysu version" }
  Say-Ok $out[0]
  # The two node drivers, which `vysu setup` installs right after this: a MISSING here is the next
  # thing to do, not a remark.
  foreach ($line in ($out | Select-Object -Skip 1)) {
    if ($line -match 'MISSING') { Say-Warn "$line (vysu setup)" } else { Say-Info $line }
  }
  if ($AsFile) {
    Say-Warn "vysu is on the PATH of new terminals $Dash open one to use it"
  } else {
    Say-Ok 'vysu is ready in this terminal'
  }

  Say-Head 'summary'
  Write-Host "ready: $($script:OkN) $MarkInfo to do: $($script:WarnN)"
  Write-Host ''
  Write-Host 'next:'
  Write-Host ('  {0,-36} {1}' -f 'vysu setup', 'tools, browser, emulators')
  Write-Host ('  {0,-36} {1}' -f 'cd <your project>; vysu init', 'the .vysu/config of that project')
}

try {
  Install-Vysu
  if ($AsFile) { exit 0 }
} catch {
  if ("$_" -ne 'vysu-install-stop') { throw }
  if ($AsFile) { exit 1 }
}
