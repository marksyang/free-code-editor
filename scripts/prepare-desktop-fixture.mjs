import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'free-code-editor-desktop-fixture-'));
const markdown = [
  '# Desktop verification', '',
  '中文輸入測試 🦀', '',
  '| Name | Value |', '| --- | --- |', '| preview | visible |', '',
  '- [x] completed', '- [ ] continue this list', '',
  '```javascript', 'const answer = 42;', '```', '',
  '![Local icon](icon.png)', '',
  '<script>window.__desktopXss = true;</script>', '',
  '[External link](https://example.com/)', '',
].join('\n');
writeFileSync(join(root, 'README.md'), markdown);
writeFileSync(join(root, 'main.c'), 'int answer = 42;\nint main(void) { return answer; }\n');
writeFileSync(join(root, 'Makefile'), '.PHONY: demo\ndemo:\n\t@echo tab-preserved\n');
writeFileSync(join(root, 'example.js'), 'const answer = 42;\nconsole.log(answer);\n');
writeFileSync(join(root, 'example.py'), 'answer = 42\nprint(answer)\n');
writeFileSync(join(root, 'example.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "desktop verification"\n');
writeFileSync(join(root, 'example.css'), 'body { color: #f3b562; }\n');
writeFileSync(join(root, 'example.html'), '<!doctype html>\n<html lang="zh-Hant"><title>Verification</title><body>中文</body></html>\n');
writeFileSync(join(root, 'example.rs'), 'fn main() { let answer: u32 = 42; println!("{}", answer); }\n');
writeFileSync(join(root, 'example.json'), '{"answer":42,"message":"中文"}\n');
writeFileSync(join(root, 'example.ts'), 'const answer: number = 42;\nconsole.log(answer);\n');
writeFileSync(join(root, 'example.tsx'), 'const element = <div>TypeScript JSX</div>;\n');
writeFileSync(join(root, 'example.pl'), 'use strict;\nuse warnings;\nmy $answer = 42;\nprint "$answer\\n";\n');
writeFileSync(join(root, 'example.pp'), '$message = "Desktop verification"\nnotify { $message: }\n');
writeFileSync(join(root, 'example.pas'), "program Example;\nbegin\n  writeln('Desktop verification');\nend.\n");
writeFileSync(join(root, 'example.bb'), 'SUMMARY = "Desktop verification"\nLICENSE = "CLOSED"\nMESSAGE ?= "Hello ${PN}"\npython do_configure() {\n    bb.note("Desktop verification")\n}\ndo_install:append() {\n    echo "${MESSAGE}"\n}\n');
copyFileSync(new URL('../src-tauri/icons/icon.png' , import.meta.url), join(root, 'icon.png'));
console.log(root);
console.log('Open this directory in the real .app; follow docs/desktop-verification.md.');
