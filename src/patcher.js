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
 * Where the renderer reads its live configuration from, and where media whose extension
 * VS Code refuses to serve gets staged.
 *
 * It lives beside workbench.html on purpose. The `vscode-file:` protocol handler serves any
 * file under the app root, but outside its own roots it only serves a fixed extension
 * whitelist - so `.json` state and `.webm` media are only loadable from here. A VS Code
 * update wipes this folder and the patch together, which is the correct coupling: both are
 * rebuilt by the same re-apply.
 */
function paths(appRoot) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return null;
  const dir = path.join(path.dirname(target), MARKER);
  return { target, dir, state: path.join(dir, 'state.json'), stage: path.join(dir, 'media') };
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
function startTag(stamp, cspAdded = []) {
  return `<!-- ${MARKER}-start ${stamp} csp=${cspAdded.join('+') || 'none'} -->`;
}

const END_TAG = `<!-- ${MARKER}-end -->`;
const START_RE = new RegExp(`<!-- ${MARKER}-start (\\S+) csp=(\\S+) -->`);

/** Reads back what a previous apply() recorded, so we never guess. */
function readPatchInfo(html) {
  const m = html.match(START_RE);
  if (!m) return null;
  return { stamp: m[1], cspAdded: m[2] === 'none' ? [] : m[2].split('+') };
}

/** Removes the injected block only. CSP is handled separately, from the recorded list. */
function stripBlock(html) {
  return html.replace(
    new RegExp(`\\n?<!-- ${MARKER}-start [^>]*-->[\\s\\S]*?<!-- ${MARKER}-end -->`, 'g'),
    ''
  );
}

// Each directive is matched as a whole - name plus its value list up to the `;`. Testing
// document-wide while replacing the first match was subtly wrong: a second, already-relaxed
// directive elsewhere in the file made the test pass and left the one that mattered alone.
const SCRIPT_SRC = /script-src([^;]*)/;
const MEDIA_SRC = /media-src([^;]*)/;

/** Edits one directive in place, and reports whether the file actually changed. */
function editDirective(html, re, edit) {
  const m = html.match(re);
  if (!m) return { html, changed: false };
  const body = edit(m[1]);
  if (body === m[1]) return { html, changed: false };
  const out = html.slice(0, m.index) + m[0].slice(0, m[0].length - m[1].length) + body
    + html.slice(m.index + m[0].length);
  return { html: out, changed: true };
}

function revertCsp(html, cspAdded) {
  let out = html;
  if (cspAdded.includes('script')) {
    out = editDirective(out, SCRIPT_SRC, (b) => b.replace(/ 'unsafe-inline'/, '')).html;
  }
  if (cspAdded.includes('media')) {
    out = editDirective(out, MEDIA_SRC, (b) => b.replace(/ vscode-file:/, '')).html;
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
 * `connect-src` needs nothing: the state file is fetched from the same origin, which
 * `connect-src 'self'` already covers.
 *
 * Returns which directives were genuinely changed - if something else already relaxed one,
 * we must not claim it, or removal would tighten a directive we never touched.
 */
function relaxCsp(html) {
  let out = html;
  const added = [];

  let r = editDirective(out, SCRIPT_SRC, (b) =>
    b.includes(`'unsafe-inline'`) ? b : ` 'unsafe-inline'` + b);
  out = r.html;
  if (r.changed) added.push('script');

  r = editDirective(out, MEDIA_SRC, (b) =>
    b.includes('vscode-file:') ? b : b.replace(/'self'/, `'self' vscode-file:`));
  out = r.html;
  if (r.changed) added.push('media');

  return { html: out, added };
}

// Keyed by VS Code version: an update rewrites workbench.html, which makes any older
// backup stale and dangerous to restore.
function backupPath(target, stamp) {
  return `${target}.${MARKER}-${String(stamp).split('/')[0]}.bak`;
}

/**
 * workbench.html *is* the application: a half-written one leaves VS Code unable to start at
 * all. Content lands under a temp name and is renamed into place, so the file on disk is
 * only ever the old one or the new one. writeState() already worked this way; the file that
 * matters more did not.
 */
function writeAtomic(file, content) {
  const tmp = `${file}.${MARKER}-tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * Kept as a manual escape hatch: nothing reads it automatically, but it is what stands
 * between a bad patch and reinstalling VS Code. Documented in the README so it is findable
 * when it is needed.
 *
 * `pristine` is the file with our patch already stripped, computed in memory by apply().
 * Copying the file off disk instead used to snapshot whatever was there - which is the
 * *old patch* in the one case the backup exists for: the backup had gone missing and an
 * extension update triggered a re-patch. A backup that restores a patch restores nothing.
 */
function ensureBackup(target, stamp, pristine) {
  const bak = backupPath(target, stamp);
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, pristine, 'utf-8');

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

function permissionError(e, appRoot, what) {
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    return `no write permission on ${what}. Run: sudo chown -R $(whoami) "${appRoot}"`;
  }
  return `${what}: ${e.message}`;
}

/**
 * Writes the live configuration the injected script polls. This is the hot path - every
 * settings change lands here - and it never touches workbench.html, which is why changing
 * a setting no longer costs a window reload.
 *
 * @returns {{ok: true, file: string} | {ok: false, reason: string}}
 */
function writeState(appRoot, state) {
  const p = paths(appRoot);
  if (!p) return { ok: false, reason: 'could not locate workbench.html under ' + appRoot };
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    // Rename into place so a poll can never read a half-written file.
    const tmp = p.state + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    fs.renameSync(tmp, p.state);
  } catch (e) {
    return { ok: false, reason: permissionError(e, appRoot, p.state) };
  }
  return { ok: true, file: p.state };
}

/** @returns {{ok: true, target: string} | {ok: false, reason: string}} */
function apply(appRoot, script, stamp) {
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
    startTag(stamp, added),
    `<script>${script}</script>`,
    END_TAG,
    '</html>',
  ].join('\n');

  // Sliced rather than String.replace, for two reasons: replace() takes the *first* closing
  // tag, and the document's real one is the last; and a string replacement expands `$&` and
  // friends, which is not something generated code should be scanned for.
  const at = out.lastIndexOf('</html>');
  if (at < 0) return { ok: false, reason: 'no </html> in workbench.html' };
  out = out.slice(0, at) + block + out.slice(at + '</html>'.length);

  try {
    ensureBackup(target, stamp, clean);
    writeAtomic(target, out);
  } catch (e) {
    return { ok: false, reason: permissionError(e, appRoot, target) };
  }

  return { ok: true, target };
}

/** @returns {{ok: true, target: string|null} | {ok: false, reason: string}} */
function remove(appRoot, stamp) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return { ok: true, target: null };

  try {
    const html = fs.readFileSync(target, 'utf-8');
    const info = readPatchInfo(html);

    if (info) {
      // Surgical, never a whole-file restore: strip our block and revert only the directives
      // this patch recorded. Anything else in the file was not ours to put back or take away.
      writeAtomic(target, revertCsp(stripBlock(html), info.cspAdded));
    }

    const bak = backupPath(target, info ? info.stamp : stamp);
    if (fs.existsSync(bak)) fs.unlinkSync(bak);

    // State and staged media are ours alone, and useless without the patch.
    const p = paths(appRoot);
    if (p) fs.rmSync(p.dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, reason: `restore failed: ${e.message}` };
  }
  return { ok: true, target };
}

/**
 * True only when the file carries *this* build's patch. Reading the answer out of the file
 * is why nothing has to remember it: a VS Code update (which overwrites workbench.html) and
 * an extension update (which leaves the old script behind) both fall out of the same check.
 */
function isPatched(appRoot, stamp) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return false;
  try {
    const info = readPatchInfo(fs.readFileSync(target, 'utf-8'));
    return !!info && info.stamp === stamp;
  } catch {
    return false;
  }
}

module.exports = {
  apply, remove, isPatched, writeState, paths, findWorkbenchHtml, backupPath, MARKER,
};
