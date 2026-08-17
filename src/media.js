const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];
const IMAGE_EXT = ['.gif', '.webp', '.apng', '.png', '.jpg', '.jpeg', '.avif'];

/**
 * VS Code's `vscode-file:` handler serves any file under its own roots (the app root, the
 * extensions folder, global and workspace storage), but for a path outside them it consults
 * a fixed extension whitelist and refuses everything else with no visible error.
 *
 * These are the extensions we support that survive that check anywhere on disk. The rest -
 * `.webm`, `.mov`, `.m4v`, `.ogv`, `.apng`, `.avif` - have to be staged into a directory
 * that *is* a valid root, or they silently never load.
 */
const DIRECTLY_SERVED = new Set(['.mp4', '.gif', '.webp', '.png', '.jpg', '.jpeg']);

// `~\` as well as `~/`: a Windows user typing a home-relative path uses the separator their
// shell and file explorer use, and the tilde was silently left literal.
function expandHome(p) {
  return /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * The workbench page origin is vscode-file://vscode-app, so this keeps media same-origin.
 *
 * The leading slash is not decoration. A POSIX path already starts with one, but a Windows
 * path starts with the drive letter, and joining that straight onto the origin produced
 * `vscode-file://vscode-appC%3A/...` - a different host, and a wallpaper that never loaded
 * on Windows at all.
 *
 * @param {string} absPath
 * @param {string} [sep] path separator, injectable so the Windows shape stays testable
 */
function toWorkbenchUrl(absPath, sep = path.sep) {
  const parts = absPath.split(sep).map(encodeURIComponent);
  if (parts[0] !== '') parts.unshift('');
  return 'vscode-file://vscode-app' + parts.join('/');
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return null;
}

function needsStaging(file) {
  return !DIRECTLY_SERVED.has(path.extname(file).toLowerCase());
}

function stagedName(abs) {
  return crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16)
    + path.extname(abs).toLowerCase();
}

/**
 * Makes `abs` reachable from the renderer, returning the path it should actually load.
 *
 * A symlink is preferred over a copy: it costs nothing, and edits to the original are
 * picked up without restaging. Windows refuses symlinks without developer mode, so a copy
 * is the fallback, refreshed only when the source has actually moved on.
 *
 * @returns {string|null} the servable path, or null if staging failed
 */
function stage(abs, stageDir) {
  if (!needsStaging(abs)) return abs;
  if (!stageDir) return null;

  const dest = path.join(stageDir, stagedName(abs));
  try {
    const src = fs.statSync(abs);

    let existing = null;
    try { existing = fs.lstatSync(dest); } catch {}
    if (existing) {
      if (existing.isSymbolicLink()) {
        if (fs.readlinkSync(dest) === abs) return dest;
      } else if (existing.size === src.size && existing.mtimeMs >= src.mtimeMs) {
        return dest;
      }
      fs.rmSync(dest, { force: true });
    }

    fs.mkdirSync(stageDir, { recursive: true });
    try {
      fs.symlinkSync(abs, dest);
    } catch {
      fs.copyFileSync(abs, dest);
    }
    return dest;
  } catch {
    return null;
  }
}

/** Flat scan - a wallpaper folder is not a tree worth recursing. */
function scanLibrary(dir) {
  const root = expandHome(dir || '');
  if (!root || !fs.existsSync(root)) return [];

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isFile() && kindOf(e.name))
    .map((e) => {
      const full = path.join(root, e.name);
      let bytes = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(full);
        bytes = st.size;
        mtimeMs = st.mtimeMs;
      } catch {}
      return { path: full, name: e.name, kind: kindOf(e.name), bytes, mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  VIDEO_EXT, IMAGE_EXT, DIRECTLY_SERVED,
  kindOf, scanLibrary, expandHome, needsStaging, stage, toWorkbenchUrl,
};
