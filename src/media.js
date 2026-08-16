const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];
const IMAGE_EXT = ['.gif', '.webp', '.apng', '.png', '.jpg', '.jpeg', '.avif'];

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return null;
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
      try { bytes = fs.statSync(full).size; } catch {}
      return { path: full, name: e.name, kind: kindOf(e.name), bytes };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { VIDEO_EXT, IMAGE_EXT, kindOf, scanLibrary, expandHome };
