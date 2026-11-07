import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir, release } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This is a prerequisite check, not a GUI test. It never requests OS permissions.
const defaultApp = process.platform === 'darwin' ? 'src-tauri/target/release/bundle/macos/Free Code Editor.app' : `src-tauri/target/release/free-code-editor${process.platform === 'win32' ? '.exe' : ''}`;
const app = resolve(process.env.EDITOR_APP_PATH ?? defaultApp);
const report = { app, platform: process.platform, packageValid: false, signatureValid: false, desktop: null, launch: null };
function run(command, args, timeout = 15000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  return { status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' };
}
if (process.platform !== 'darwin') {
  try {
    accessSync(app, constants.X_OK); report.packageValid = true; report.signatureValid = null;
    if (process.platform === 'linux') {
      report.dependencies = run('ldd', [app]);
      report.runtimeReady = report.dependencies.status === 0 && !report.dependencies.stdout.includes('not found');
      report.desktop = { graphicalSessionAvailable: Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY) };
    } else if (process.platform === 'win32') {
      const build = Number(release().split('.')[2]);
      const probe = run('powershell.exe', ['-NoProfile', '-Command', `$roots = @([Environment]::GetFolderPath('ProgramFilesX86'), $env:ProgramFiles, $env:LOCALAPPDATA); $found = $false; foreach ($root in $roots) { if ($root -and (Get-ChildItem -Path (Join-Path $root 'Microsoft\\EdgeWebView\\Application\\*\\msedgewebview2.exe') -ErrorAction SilentlyContinue)) { $found = $true } }; @{ webview2 = $found; interactive = [Environment]::UserInteractive } | ConvertTo-Json -Compress`]);
      const info = probe.status === 0 ? JSON.parse(probe.stdout) : {};
      report.runtimeReady = build >= 17763 && info.webview2 === true;
      report.desktop = { graphicalSessionAvailable: info.interactive === true, windowsBuild: build, webview2Installed: info.webview2 ?? null };
    } else { throw new Error(`Unsupported desktop platform: ${process.platform}`); }
    const ready = report.runtimeReady && report.desktop.graphicalSessionAvailable;
    report.result = !report.runtimeReady ? 'RUNTIME_MISSING' : ready ? 'PREFLIGHT_READY' : 'DESKTOP_BLOCKED';
    if (process.argv.includes('--launch')) {
      if (ready) { const child = spawn(app, [], { detached: true, stdio: 'ignore' }); child.on('error', error => console.error(error.message)); child.unref(); report.launch = 'Launch requested; interaction remains unverified'; }
      else report.launch = { skipped: 'A compatible runtime and graphical session are required.' };
    }
    report.note = 'Runtime/session checks do not verify actual WebView interaction or signing.';
    process.exitCode = ready ? 0 : 2;
  } catch (error) { report.result = 'PACKAGE_FAILED'; report.error = String(error); process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
} else {
  let temporary;
  try {
    const plist = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')]);
    if (plist.status !== 0 || !plist.stdout || basename(plist.stdout) !== plist.stdout) throw new Error(`Invalid bundle executable: ${plist.stderr}`);
    const executable = join(app, 'Contents/MacOS', plist.stdout);
    accessSync(executable, constants.X_OK);
    report.packageValid = true;
    const signature = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    report.signatureValid = signature.status === 0;
    report.signature = signature.stderr;
    temporary = mkdtempSync(join(tmpdir(), 'free-code-desktop-check-'));
    const binary = join(temporary, 'probe');
    const compile = run('/usr/bin/swiftc', ['-module-cache-path', join(temporary, 'modules'), fileURLToPath(new URL('./desktop-probe.swift', import.meta.url)), '-o', binary], 60000);
    if (compile.status !== 0) throw new Error(`Desktop probe could not compile: ${compile.stderr}`);
    const probe = run(binary, []);
    if (probe.status !== 0) throw new Error(`Desktop probe failed: ${probe.stderr || probe.error || probe.signal}`);
    report.desktop = JSON.parse(probe.stdout);
    if (process.argv.includes('--launch')) {
      report.launch = report.signatureValid && report.desktop.graphicalSessionAvailable
        ? run('/usr/bin/open', ['-n', app]) : { skipped: 'A valid signature and accessible graphical session are required.' };
    }
    const desktopReady = report.desktop.graphicalSessionAvailable && report.desktop.windowListAvailable && report.desktop.accessibilityTrusted;
    report.result = !report.signatureValid ? 'PACKAGE_FAILED' : !desktopReady ? 'DESKTOP_BLOCKED' : 'PREFLIGHT_READY';
    report.note = 'PREFLIGHT_READY does not verify opening, editing, saving, Markdown or LSP interactions.';
    process.exitCode = !report.signatureValid ? 1 : !desktopReady ? 2 : 0;
  } catch (error) {
    report.result = report.packageValid && report.signatureValid ? 'DESKTOP_BLOCKED' : 'PACKAGE_FAILED';
    report.error = String(error); process.exitCode = report.result === 'DESKTOP_BLOCKED' ? 2 : 1;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}
