const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const patcher = require('./patcher');
const gallery = require('./gallery');
const { buildScript } = require('./runtime');
const { kindOf, expandHome, scanLibrary } = require('./media');

const STATE_VERSION = 'livewall.patchedFor';

/** The workbench page origin is vscode-file://vscode-app, so this keeps the video same-origin. */
function toWorkbenchUrl(absPath) {
  return 'vscode-file://vscode-app' + absPath.split(path.sep).map(encodeURIComponent).join('/');
}

function readConfig() {
  const c = vscode.workspace.getConfiguration('livewall');
  return {
    // `video` is the pre-0.1 name, still honoured so existing settings keep working.
    media: (c.get('media') || c.get('video') || '').trim(),
    opacity: c.get('opacity'),
    scrim: c.get('scrim'),
    library: (c.get('library') || '').trim(),
    shuffle: !!c.get('shuffle'),
    rotateMinutes: c.get('rotateMinutes'),
    playbackRate: c.get('playbackRate'),
    pauseOnBlur: c.get('pauseOnBlur'),
    respectReducedMotion: c.get('respectReducedMotion'),
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
 */
function buildPlaylist(cfg) {
  if (cfg.shuffle && cfg.library) {
    const files = scanLibrary(cfg.library);
    if (files.length) {
      return files.map((f) => ({ src: toWorkbenchUrl(f.path), kind: f.kind }));
    }
  }

  const abs = expandHome(cfg.media);
  if (!abs) return { error: 'LiveWall: pick a wallpaper first (LiveWall: Choose wallpaper...).' };
  if (!fs.existsSync(abs)) return { error: `LiveWall: file not found - ${abs}` };

  const kind = kindOf(abs);
  if (!kind) return { error: `LiveWall: unsupported file type - ${path.extname(abs)}` };

  return [{ src: toWorkbenchUrl(abs), kind }];
}

async function apply(silent) {
  const cfg = readConfig();

  const playlist = buildPlaylist(cfg);
  if (playlist.error) {
    if (!silent) vscode.window.showWarningMessage(playlist.error);
    return false;
  }

  const script = buildScript({
    playlist,
    shuffle: cfg.shuffle,
    rotateMinutes: cfg.rotateMinutes,
    opacity: cfg.opacity,
    scrim: cfg.scrim,
    playbackRate: cfg.playbackRate,
    pauseOnBlur: cfg.pauseOnBlur,
    respectReducedMotion: cfg.respectReducedMotion,
  });

  const res = patcher.apply(vscode.env.appRoot, script, vscode.version);
  if (!res.ok) {
    vscode.window.showErrorMessage('LiveWall: ' + res.reason);
    return false;
  }

  if (!silent) await offerReload('LiveWall applied. Reload to see it.');
  return true;
}

async function remove() {
  const res = patcher.remove(vscode.env.appRoot, vscode.version);
  if (!res.ok) {
    vscode.window.showErrorMessage('LiveWall: ' + res.reason);
    return;
  }
  await offerReload('LiveWall removed. Reload to restore VS Code.');
}

let watcher = null;
let watchTimer = null;

/**
 * Watches the library folder so a file dropped in it (a download, a copy) shows up without
 * touching any setting. Debounced: a download writes many times before it is done.
 */
function watchLibrary(context) {
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  const cfg = readConfig();
  if (!cfg.library || !cfg.shuffle) return;

  const dir = expandHome(cfg.library);
  if (!fs.existsSync(dir)) return;

  let known = scanLibrary(dir).length;

  try {
    watcher = fs.watch(dir, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => {
        const now = scanLibrary(dir).length;
        if (now === known) return;
        const added = now - known;
        known = now;
        if (added <= 0) return;

        if (await apply(true)) {
          const pick = await vscode.window.showInformationMessage(
            `LiveWall: ${added} new wallpaper${added > 1 ? 's' : ''} in your library.`,
            'Reload'
          );
          if (pick === 'Reload') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        }
      }, 2000);
    });
    context.subscriptions.push({ dispose: () => watcher && watcher.close() });
  } catch {
    // Watching is a convenience; a platform that refuses it must not break the extension.
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('livewall.apply', () => apply(false)),
    vscode.commands.registerCommand('livewall.remove', () => remove()),
    vscode.commands.registerCommand('livewall.choose', () =>
      gallery.open(context, async (absPath) => {
        // The config listener below picks this up and re-applies.
        await vscode.workspace
          .getConfiguration('livewall')
          .update('media', absPath, vscode.ConfigurationTarget.Global);
      })
    )
  );

  // Two things silently invalidate the injected script: a VS Code update (which overwrites
  // workbench.html outright) and an extension update (which leaves the *old* script patched
  // in). Stamp both and re-apply when either moves.
  const extVersion = context.extension.packageJSON.version;
  const stamp = `${vscode.version}/${extVersion}`;
  const seen = context.globalState.get(STATE_VERSION);

  if (seen && seen !== stamp && readConfig().media) {
    const vscodeChanged = seen.split('/')[0] !== vscode.version;
    apply(true).then((ok) => {
      if (!ok) return;
      offerReload(
        vscodeChanged
          ? `LiveWall: VS Code updated to ${vscode.version}, wallpaper re-applied.`
          : `LiveWall updated to ${extVersion}, wallpaper re-applied.`
      );
    });
  }
  context.globalState.update(STATE_VERSION, stamp);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('livewall')) {
        apply(false);
        if (e.affectsConfiguration('livewall.library')) watchLibrary(context);
      }
    })
  );

  watchLibrary(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
