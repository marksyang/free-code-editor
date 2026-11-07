import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// This is a prerequisite check, not a GUI test. It never requests OS permissions.
const app = resolve(process.env.EDITOR_APP_PATH ?? 'src-tauri/target/release/bundle/macos/Free Code Editor.app');
const report = { app, platform: process.platform, packageValid: false, signatureValid: false, desktop: null, launch: null };
function run(command, args, timeout = 15000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  return { status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' };
}
if (process.platform !== 'darwin') {
  console.error('Real desktop preflight currently requires macOS.'); process.exitCode = 2;
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
