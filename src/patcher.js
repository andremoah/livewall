const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'livewall';

// VS Code has moved this folder around across versions (electron-sandbox <-> electron-browser),
// so probe rather than hardcode.
const CANDIDATES = [
  'out/vs/code/electron-browser/workbench/workbench.html',
  'out/vs/code/electron-sandbox/workbench/workbench.html',
  'out/vs/code/electron-browser/workbench/workbench.esm.html',
  'out/vs/code/electron-sandbox/workbench/workbench.esm.html',
];

function findWorkbenchHtml(appRoot) {
  for (const rel of CANDIDATES) {
    const p = path.join(appRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * The start tag records which CSP directives this patch actually relaxed, so removal can
 * revert exactly those and nothing else.
 *
 * Restoring a whole backup file was the obvious approach and it was wrong: the backup
 * captures whatever the file happened to contain the first time we patched, which may
 * include another extension's patch. Removing LiveWall then reinstated a foreign
 * modification the user had already got rid of.
 */
function startTag(version, cspAdded = []) {
  return `<!-- ${MARKER}-start ${version} csp=${cspAdded.join('+') || 'none'} -->`;
}

const END_TAG = `<!-- ${MARKER}-end -->`;
const START_RE = new RegExp(`<!-- ${MARKER}-start (\\S+) csp=(\\S+) -->`);

/** Reads back what a previous apply() recorded, so we never guess. */
function readPatchInfo(html) {
  const m = html.match(START_RE);
  if (!m) return null;
  return { version: m[1], cspAdded: m[2] === 'none' ? [] : m[2].split('+') };
}

/** Removes the injected block only. CSP is handled separately, from the recorded list. */
function stripBlock(html) {
  return html.replace(
    new RegExp(`\\n?<!-- ${MARKER}-start [^>]*-->[\\s\\S]*?<!-- ${MARKER}-end -->`, 'g'),
    ''
  );
}

function revertCsp(html, cspAdded) {
  let out = html;
  if (cspAdded.includes('script')) {
    out = out.replace(/script-src 'unsafe-inline'/, 'script-src');
  }
  if (cspAdded.includes('media')) {
    out = out.replace(/(media-src\s+'self')\s+vscode-file:/, '$1');
  }
  return out;
}

/**
 * The workbench page origin is `vscode-file://vscode-app`, so a local file referenced
 * through that scheme is same-origin and already allowed by `media-src 'self'`. We add
 * the scheme explicitly anyway because it costs nothing and removes all doubt.
 *
 * `script-src` needs 'unsafe-inline' for our injected <script> to run at all.
 *
 * Returns which directives were genuinely changed - if something else already relaxed one,
 * we must not claim it, or removal would tighten a directive we never touched.
 */
function relaxCsp(html) {
  let out = html;
  const added = [];

  if (!/script-src[^;]*'unsafe-inline'/.test(out)) {
    out = out.replace(/script-src/, `script-src 'unsafe-inline'`);
    added.push('script');
  }
  if (!/media-src[^;]*vscode-file:/.test(out)) {
    out = out.replace(/(media-src\s+'self')/, `$1 vscode-file:`);
    added.push('media');
  }
  return { html: out, added };
}

// Keyed by VS Code version: an update rewrites workbench.html, which makes any older
// backup stale and dangerous to restore.
function backupPath(target, version) {
  return `${target}.${MARKER}-${version}.bak`;
}

function ensureBackup(target, version) {
  const bak = backupPath(target, version);
  if (!fs.existsSync(bak)) fs.copyFileSync(target, bak);

  // Drop backups left behind by previous VS Code versions.
  const dir = path.dirname(target);
  const base = path.basename(target);
  const keep = path.basename(bak);
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${base}.${MARKER}-`) && f.endsWith('.bak') && f !== keep) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  }
}

/** @returns {{ok: true, target: string} | {ok: false, reason: string}} */
function apply(appRoot, script, version) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return { ok: false, reason: 'could not locate workbench.html under ' + appRoot };

  let html;
  try {
    html = fs.readFileSync(target, 'utf-8');
  } catch (e) {
    return { ok: false, reason: `cannot read ${target}: ${e.message}` };
  }

  // Undo our own previous patch before re-reading the CSP state, so a re-apply does not
  // credit itself with directives it relaxed the first time round.
  const previous = readPatchInfo(html);
  const clean = revertCsp(stripBlock(html), previous ? previous.cspAdded : []);

  const { html: relaxed, added } = relaxCsp(clean);
  let out = relaxed;

  const block = [
    startTag(version, added),
    `<script>${script}</script>`,
    END_TAG,
    '</html>',
  ].join('\n');

  if (!out.includes('</html>')) return { ok: false, reason: 'no </html> in workbench.html' };
  out = out.replace('</html>', block);

  try {
    ensureBackup(target, version);
    fs.writeFileSync(target, out, 'utf-8');
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return { ok: false, reason: `no write permission on ${target}. Run: sudo chown -R $(whoami) "${appRoot}"` };
    }
    return { ok: false, reason: `write failed: ${e.message}` };
  }

  return { ok: true, target };
}

/** @returns {{ok: true, target: string|null} | {ok: false, reason: string}} */
function remove(appRoot, version) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return { ok: true, target: null };

  try {
    const html = fs.readFileSync(target, 'utf-8');
    const info = readPatchInfo(html);
    if (!info) return { ok: true, target };

    // Surgical, never a whole-file restore: strip our block and revert only the directives
    // this patch recorded. Anything else in the file was not ours to put back or take away.
    fs.writeFileSync(target, revertCsp(stripBlock(html), info.cspAdded), 'utf-8');

    const bak = backupPath(target, version);
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  } catch (e) {
    return { ok: false, reason: `restore failed: ${e.message}` };
  }
  return { ok: true, target };
}

function isPatched(appRoot, version) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return false;
  try {
    const info = readPatchInfo(fs.readFileSync(target, 'utf-8'));
    return !!info && info.version === version;
  } catch {
    return false;
  }
}

module.exports = { apply, remove, isPatched, findWorkbenchHtml, MARKER };
