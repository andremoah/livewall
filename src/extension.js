const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const patcher = require('./patcher');
const gallery = require('./gallery');
const { buildScript } = require('./runtime');
const { kindOf, expandHome, scanLibrary, stage, toWorkbenchUrl } = require('./media');

/**
 * Settings are `application` scope, so a workspace cannot set them - but they are still
 * hand-edited JSON, and a string where a number belongs used to flow straight into the
 * generated CSS. Everything numeric is coerced and clamped here, once.
 */
function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readConfig() {
  const c = vscode.workspace.getConfiguration('livewall');
  return {
    enabled: c.get('enabled') !== false,
    // `video` is the pre-0.1 name, still honoured so existing settings keep working.
    media: String(c.get('media') || c.get('video') || '').trim(),
    library: String(c.get('library') || '').trim(),
    shuffle: !!c.get('shuffle'),
    rotateMinutes: num(c.get('rotateMinutes'), 0, 0, 60 * 24),
    opacity: num(c.get('opacity'), 0.35, 0, 1),
    scrim: num(c.get('scrim'), 0.55, 0, 1),
    playbackRate: num(c.get('playbackRate'), 1, 0.1, 4),
    pauseOnBlur: c.get('pauseOnBlur') !== false,
    respectReducedMotion: c.get('respectReducedMotion') !== false,
  };
}

async function offerReload(message) {
  const pick = await vscode.window.showInformationMessage(message, 'Reload window');
  if (pick === 'Reload window') {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * With shuffle on, the whole library becomes the playlist and the renderer rotates through
 * it. Otherwise it is the single chosen file.
 *
 * Every entry goes through stage(): formats VS Code refuses to serve from an arbitrary
 * folder are linked into the app root first, which is the only reason a `.webm` or `.mov`
 * wallpaper works at all.
 */
function buildPlaylist(cfg, stageDir) {
  const items = [];
  const unreachable = [];

  const add = (abs, kind) => {
    const servable = stage(abs, stageDir);
    if (servable) items.push({ src: toWorkbenchUrl(servable), kind });
    else unreachable.push(path.basename(abs));
  };

  if (cfg.shuffle && cfg.library) {
    for (const f of scanLibrary(cfg.library)) add(f.path, f.kind);
    if (items.length) return { items, unreachable };
  }

  const abs = expandHome(cfg.media);
  if (!abs) return { error: 'LiveWall: pick a wallpaper first (LiveWall: Choose wallpaper...).' };
  if (!fs.existsSync(abs)) return { error: `LiveWall: file not found - ${abs}` };

  const kind = kindOf(abs);
  if (!kind) return { error: `LiveWall: unsupported file type - ${path.extname(abs)}` };

  add(abs, kind);
  if (!items.length) return { error: `LiveWall: could not prepare ${path.basename(abs)} for display.` };
  return { items, unreachable };
}

/** Lets the renderer skip work when nothing it cares about actually moved. */
function stampOf(state) {
  return crypto.createHash('sha1').update(JSON.stringify(state)).digest('hex').slice(0, 16);
}

/**
 * Writes the live state, then patches workbench.html only if this build's script is not
 * already in there. Settings changes take the first path alone, which is why they no longer
 * cost a window reload.
 *
 * @returns {Promise<{ok: boolean, patched: boolean, reason?: string, unreachable?: string[]}>}
 */
async function apply(context) {
  const appRoot = vscode.env.appRoot;
  const p = patcher.paths(appRoot);
  if (!p) return { ok: false, patched: false, reason: 'could not locate workbench.html' };

  const cfg = readConfig();

  // A VS Code update overwrites workbench.html; an extension update leaves the *old* script
  // patched in. Both show up as a stamp that is not ours, and both are fixed the same way.
  const stamp = `${vscode.version}/${context.extension.packageJSON.version}`;
  const patched = patcher.isPatched(appRoot, stamp);

  // Turned off and not installed is a state with nothing to do - and it is the state the
  // remove command leaves behind, so touching anything here would undo it.
  if (!cfg.enabled && !patched) return { ok: true, patched: false };

  const built = buildPlaylist(cfg, p.stage);

  const body = {
    enabled: cfg.enabled && !built.error,
    playlist: built.items || [],
    shuffle: cfg.shuffle,
    rotateMs: cfg.rotateMinutes * 60 * 1000,
    rate: cfg.playbackRate,
    pauseOnBlur: cfg.pauseOnBlur,
    respectReducedMotion: cfg.respectReducedMotion,
    opacity: cfg.opacity,
    scrim: cfg.scrim,
  };

  // Written even when the playlist is empty: clearing the wallpaper setting has to clear the
  // wallpaper, and the renderer only ever learns that from this file.
  const wrote = patcher.writeState(appRoot, { ...body, stamp: stampOf(body) });
  if (!wrote.ok) return { ok: false, patched: false, reason: wrote.reason };
  if (built.error) return { ok: false, patched: false, reason: built.error };

  // Never install the patch while switched off - the toggle would fight the remove command.
  if (patched || !cfg.enabled) {
    return { ok: true, patched: false, unreachable: built.unreachable };
  }

  const res = patcher.apply(appRoot, buildScript({ stateUrl: toWorkbenchUrl(p.state) }), stamp);
  if (!res.ok) return { ok: false, patched: false, reason: res.reason };
  return { ok: true, patched: true, unreachable: built.unreachable };
}

/**
 * Reports whatever apply() could not do. `verbose` is for the explicit command only: the
 * configuration listener runs on every slider tick, and per-file complaints there would be
 * a stream of toasts.
 */
async function report(result, { silent, verbose, appliedMessage }) {
  if (!result.ok) {
    if (!silent) vscode.window.showWarningMessage(result.reason);
    return false;
  }
  if (verbose && result.unreachable && result.unreachable.length) {
    vscode.window.showWarningMessage(
      `LiveWall: could not prepare ${result.unreachable.length} file(s): ${result.unreachable.slice(0, 3).join(', ')}`
    );
  }
  if (result.patched) await offerReload('LiveWall applied. Reload to see it.');
  else if (!silent && appliedMessage) vscode.window.showInformationMessage(appliedMessage);
  return true;
}

async function remove(context) {
  const res = patcher.remove(vscode.env.appRoot, `${vscode.version}/${context.extension.packageJSON.version}`);
  if (!res.ok) {
    vscode.window.showErrorMessage('LiveWall: ' + res.reason);
    return;
  }
  // Otherwise the next launch would helpfully patch everything straight back.
  await vscode.workspace
    .getConfiguration('livewall')
    .update('enabled', false, vscode.ConfigurationTarget.Global);
  await offerReload('LiveWall removed. Reload to restore VS Code.');
}

/* ---------------------------------------------------------------- status bar */

let status = null;

function updateStatus() {
  if (!status) return;
  const cfg = readConfig();
  const name = cfg.shuffle && cfg.library
    ? `${scanLibrary(cfg.library).length} wallpapers`
    : (cfg.media ? path.basename(expandHome(cfg.media)) : 'no wallpaper set');

  status.text = cfg.enabled ? '$(sparkle)' : '$(circle-slash)';
  status.tooltip = cfg.enabled
    ? `LiveWall: ${name}\nClick to turn off`
    : 'LiveWall: off\nClick to turn on';
}

/* ---------------------------------------------------------------- library watch */

let watcher = null;
let watchTimer = null;
let signature = '';

/** Name, size and mtime of every file: a replaced wallpaper counts as a change, a count does not. */
function librarySignature(dir) {
  return scanLibrary(dir)
    .map((f) => `${f.name}:${f.bytes}:${Math.round(f.mtimeMs)}`)
    .join('|');
}

function stopWatch() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  clearTimeout(watchTimer);
}

/**
 * Watches the library folder so a file dropped in it (a download, a copy) shows up without
 * touching any setting. Debounced: a download writes many times before it is done.
 */
function watchLibrary(context) {
  stopWatch();

  const cfg = readConfig();
  if (!cfg.library || !cfg.shuffle) return;

  const dir = expandHome(cfg.library);
  if (!fs.existsSync(dir)) return;

  signature = librarySignature(dir);
  let known = scanLibrary(dir).length;

  try {
    watcher = fs.watch(dir, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => {
        const next = librarySignature(dir);
        if (next === signature) return;
        signature = next;

        const now = scanLibrary(dir).length;
        const added = now - known;
        known = now;

        const result = await apply(context);
        if (!result.ok) return;
        updateStatus();

        // The wallpaper is already live; only a fresh patch would need a reload.
        if (result.patched) {
          await offerReload('LiveWall: library changed, wallpaper re-applied. Reload to see it.');
        } else if (added > 0) {
          vscode.window.showInformationMessage(
            `LiveWall: ${added} new wallpaper${added > 1 ? 's' : ''} in your library.`
          );
        }
      }, 2000);
    });
  } catch {
    // Watching is a convenience; a platform that refuses it must not break the extension.
  }
}

/* ---------------------------------------------------------------- activation */

const LIVE_KEYS = [
  'enabled', 'media', 'video', 'library', 'shuffle', 'rotateMinutes',
  'opacity', 'scrim', 'playbackRate', 'pauseOnBlur', 'respectReducedMotion',
];

function activate(context) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'livewall.toggle';
  status.show();
  updateStatus();
  context.subscriptions.push(status, { dispose: stopWatch });

  context.subscriptions.push(
    vscode.commands.registerCommand('livewall.apply', async () => {
      const r = await apply(context);
      await report(r, { verbose: true, appliedMessage: 'LiveWall: wallpaper updated.' });
      updateStatus();
    }),

    vscode.commands.registerCommand('livewall.remove', () => remove(context)),

    vscode.commands.registerCommand('livewall.toggle', async () => {
      const next = !readConfig().enabled;
      await vscode.workspace
        .getConfiguration('livewall')
        .update('enabled', next, vscode.ConfigurationTarget.Global);
      // The configuration listener re-applies; this only keeps the pill honest immediately.
      updateStatus();
    }),

    vscode.commands.registerCommand('livewall.choose', () =>
      gallery.open(context, async (absPath) => {
        // The config listener below picks this up and re-applies.
        await vscode.workspace
          .getConfiguration('livewall')
          .update('media', absPath, vscode.ConfigurationTarget.Global);
      })
    )
  );

  let pending = null;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!LIVE_KEYS.some((k) => e.affectsConfiguration('livewall.' + k))) return;
      if (e.affectsConfiguration('livewall.library') || e.affectsConfiguration('livewall.shuffle')) {
        watchLibrary(context);
      }
      // Dragging a slider in the settings UI fires per keystroke; one write per burst is plenty.
      clearTimeout(pending);
      pending = setTimeout(async () => {
        const r = await apply(context);
        await report(r, {});
        updateStatus();
      }, 150);
    })
  );

  // Writes the state file and, if a VS Code or extension update invalidated the injected
  // script, puts it back. Quiet when there is simply no wallpaper configured yet.
  apply(context).then((r) => {
    updateStatus();
    if (r.ok && r.patched) offerReload('LiveWall re-applied after an update. Reload to see it.');
  });

  watchLibrary(context);
}

function deactivate() {
  stopWatch();
}

module.exports = { activate, deactivate };
