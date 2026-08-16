/**
 * Runs the patcher against a throwaway copy of the real installed workbench.html.
 * No VS Code process involved, nothing written outside a temp dir.
 *
 *   node test/smoke.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const patcher = require('../src/patcher');
const { buildScript } = require('../src/runtime');

const APP_ROOT =
  process.env.LIVEWALL_APP_ROOT ||
  '/Applications/Visual Studio Code.app/Contents/Resources/app';
const REL = 'out/vs/code/electron-browser/workbench/workbench.html';
const VERSION = '0.0.0-test';

let fails = 0;
const check = (name, cond) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name);
  if (!cond) fails++;
};

// extension.js and gallery.js require('vscode'), which only exists inside the extension
// host, so they cannot be require()d here. Syntax-check them instead - a parse error is
// what breaks activation, and that is precisely how the last one shipped.
const { execFileSync } = require('node:child_process');
for (const f of fs.readdirSync(path.join(__dirname, '..', 'src'))) {
  if (!f.endsWith('.js')) continue;
  let err = null;
  try {
    execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'src', f)], {
      stdio: 'pipe',
    });
  } catch (e) {
    err = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ');
  }
  check(`src/${f} parses` + (err ? ': ' + err : ''), !err);
}

// Fixtures shaped like the real upstream responses. The Pixabay thumbnail lives on each
// size variant - there is no top-level thumb field, which is exactly what I got wrong by
// assuming one instead of checking.
{
  const { parse } = require('../src/sources');

  const pixabay = parse('pixabay', {
    hits: [{
      id: 145578,
      duration: 8,
      user: 'LiveWallpapers4K',
      pageURL: 'https://pixabay.com/videos/x-145578/',
      videos: {
        large: { url: 'https://cdn.pixabay.com/video/a_large.mp4', width: 1920, height: 1080, size: 100, thumbnail: 'https://cdn.pixabay.com/video/a_large.jpg' },
        small: { url: 'https://cdn.pixabay.com/video/a_small.mp4', width: 640, height: 360, size: 10, thumbnail: 'https://cdn.pixabay.com/video/a_small.jpg' },
      },
    }],
  });

  check('pixabay parses one item', pixabay.length === 1);
  check('pixabay thumb is a real https url',
    /^https:\/\//.test(pixabay[0].thumb) && !pixabay[0].thumb.includes('undefined'));
  check('pixabay thumb does not use the dead vimeo guess',
    !pixabay[0].thumb.includes('vimeocdn'));
  check('pixabay picks the <=1920 variant', pixabay[0].url.endsWith('a_large.mp4'));
  check('pixabay keeps author for attribution', pixabay[0].author === 'LiveWallpapers4K');
  check('pixabay keeps a credit link', /^https:\/\//.test(pixabay[0].credit));

  const pexels = parse('pexels', {
    videos: [{
      id: 7,
      duration: 12,
      url: 'https://www.pexels.com/video/7/',
      image: 'https://images.pexels.com/v/7.jpg',
      user: { name: 'Someone' },
      video_files: [
        { link: 'https://player.vimeo.com/x-4k.mp4', file_type: 'video/mp4', width: 3840, height: 2160 },
        { link: 'https://player.vimeo.com/x-hd.mp4', file_type: 'video/mp4', width: 1920, height: 1080 },
      ],
    }],
  });
  check('pexels thumb present', /^https:\/\//.test(pexels[0].thumb));
  check('pexels skips the 4k variant', pexels[0].url.endsWith('x-hd.mp4'));
  check('pexels keeps author and credit link',
    pexels[0].author === 'Someone' && /^https:\/\//.test(pexels[0].credit));

  const wallhaven = parse('wallhaven', {
    data: [{ id: 'abc', path: 'https://w.wallhaven.cc/full/ab/x.jpg', file_type: 'image/jpeg', resolution: '1920x1080', file_size: 500, thumbs: { small: 'https://th.wallhaven.cc/small/ab/x.jpg' } }],
  });
  check('wallhaven parses as image', wallhaven[0].kind === 'image' && wallhaven[0].ext === '.jpg');
}

const baseCfg = {
  opacity: 0.35,
  scrim: 0.55,
  playbackRate: 1,
  pauseOnBlur: true,
  respectReducedMotion: false,
};

/**
 * Minimal DOM good enough to run the injected script. Executing it is a far stronger check
 * than grepping for guards: on the image path `video` is null, so any unguarded video.*
 * call throws here instead of in someone's editor.
 */
function fakeDom() {
  const created = [];
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      listeners: {},
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      removeEventListener() {},
      setAttribute() {},
      appendChild() {},
      pause() { this.paused = true; },
      play() { this.paused = false; return Promise.resolve(); },
      paused: true,
    };
    created.push(el);
    return el;
  };
  const body = { ...make('body'), firstChild: null, insertBefore() {} };
  return {
    created,
    window: {
      addEventListener() {},
      matchMedia: () => ({ matches: false }),
      __livewall: null,
    },
    document: {
      body,
      head: make('head'),
      hidden: false,
      activeElement: null,
      getElementById: () => null,
      createElement: make,
      addEventListener() {},
      removeEventListener() {},
      hasFocus: () => true,
    },
  };
}

for (const [kind, file] of [['video', '/tmp/a.mp4'], ['image', '/tmp/a.webp']]) {
  const s = buildScript({ ...baseCfg, kind, src: 'vscode-file://vscode-app' + file });

  let parse = null;
  try { new Function(s); } catch (err) { parse = err.message; }
  check(`${kind} script parses` + (parse ? ': ' + parse : ''), !parse);

  const dom = fakeDom();
  let runErr = null;
  try {
    new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', s)(
      dom.window, dom.document, { warn() {} }, () => 0, () => {}
    );
  } catch (err) {
    runErr = err.message;
  }
  check(`${kind} script runs without throwing` + (runErr ? ': ' + runErr : ''), !runErr);

  const tags = dom.created.map((e) => e.tagName);
  check(`${kind} script creates a ${kind === 'video' ? 'VIDEO' : 'IMG'} element`,
    tags.includes(kind === 'video' ? 'VIDEO' : 'IMG'));
  check(`${kind} script does not create the other element`,
    !tags.includes(kind === 'video' ? 'IMG' : 'VIDEO'));
}

// Playlist: mixing kinds is the risky path, because rotating from video to image swaps the
// element type and leaves `video` null for every video-only call downstream.
{
  const mixed = buildScript({
    ...baseCfg,
    shuffle: false,
    rotateMinutes: 0,
    playlist: [
      { src: 'vscode-file://vscode-app/tmp/a.mp4', kind: 'video' },
      { src: 'vscode-file://vscode-app/tmp/b.webp', kind: 'image' },
      { src: 'vscode-file://vscode-app/tmp/c.gif', kind: 'image' },
    ],
  });

  const dom = fakeDom();
  let err = null;
  try {
    new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'setInterval', mixed)(
      dom.window, dom.document, { warn() {} }, () => 0, () => {}, () => 0
    );
  } catch (e) {
    err = e.message;
  }
  check('playlist script runs' + (err ? ': ' + err : ''), !err);

  const diag = dom.window.__livewall;
  check('playlist size exposed', diag && diag.playlist === 3);
  check('starts on first item', diag && diag.index === 0 && diag.kind === 'video');

  // Rotating video -> image is where an unguarded video.* call would throw.
  let rotErr = null;
  try {
    diag.rotate();
  } catch (e) {
    rotErr = e.message;
  }
  check('rotate video->image does not throw' + (rotErr ? ': ' + rotErr : ''), !rotErr);
  check('rotated to second item', diag && diag.index === 1 && diag.kind === 'image');
  check('video handle cleared on image', diag && diag.video === null);
}

const script = buildScript({
  ...baseCfg,
  kind: 'video',
  src: 'vscode-file://vscode-app/tmp/sample.mp4',
});

// The runtime is assembled inside a template literal, so a stray backtick anywhere in it
// silently truncates the script and the extension fails to activate. Parse it first.
let parseErr = null;
try {
  new Function(script);
} catch (e) {
  parseErr = e.message;
}
check('generated script parses' + (parseErr ? ': ' + parseErr : ''), !parseErr);
check('script is not truncated', script.trim().endsWith('})();'));
check('no stray backtick in generated script', !script.includes('`'));

const source = path.join(APP_ROOT, REL);
if (!fs.existsSync(source)) {
  console.log(`\nSKIP: no workbench.html at ${source}`);
  process.exit(fails === 0 ? 0 : 1);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'livewall-test-'));
const target = path.join(sandbox, REL);
fs.mkdirSync(path.dirname(target), { recursive: true });

// Strip any live patch so the fixture is pristine.
let original = fs.readFileSync(source, 'utf-8');
original = original.replace(/\n?<!-- livewall-start[\s\S]*?<!-- livewall-end -->/g, '');
original = original.replace(/\n?<!-- vscode-background-start[\s\S]*?<!-- vscode-background-end -->/g, '');
original = original.replace(/script-src 'unsafe-inline'/, 'script-src');
original = original.replace(/(media-src\s+'self')\s+vscode-file:/, '$1');
fs.writeFileSync(target, original, 'utf-8');

const r1 = patcher.apply(sandbox, script, VERSION);
check('apply() ok: ' + (r1.ok ? 'yes' : r1.reason), r1.ok);

let html = fs.readFileSync(target, 'utf-8');
check('start marker present', new RegExp(`<!-- livewall-start ${VERSION} csp=\\S+ -->`).test(html));
check('start marker records the CSP directives it relaxed',
  /csp=script\+media/.test(html));
check('end marker present', html.includes('<!-- livewall-end -->'));
check('closing </html> preserved', html.trimEnd().endsWith('</html>'));
check("script-src got 'unsafe-inline'", /script-src\s+'unsafe-inline'/.test(html));
check('media-src got vscode-file:', /media-src\s+'self'\s+vscode-file:/.test(html));
check('video src injected', html.includes('vscode-file://vscode-app/tmp/sample.mp4'));
check('no innerHTML (trusted-types safe)', !/innerHTML/.test(html.split('<!-- livewall-start')[1]));
check('backup created', fs.existsSync(`${target}.livewall-${VERSION}.bak`));
check('isPatched() true', patcher.isPatched(sandbox, VERSION));
check('isPatched() false for another version', !patcher.isPatched(sandbox, '9.9.9'));

// Applying twice must not stack blocks or double-edit the CSP.
patcher.apply(sandbox, script, VERSION);
html = fs.readFileSync(target, 'utf-8');
check('exactly 1 block after 2x apply', (html.match(/livewall-start/g) || []).length === 1);
check("exactly 1 'unsafe-inline'", (html.match(/script-src\s+'unsafe-inline'/g) || []).length === 1);
check('exactly 1 vscode-file:', (html.match(/media-src\s+'self'\s+vscode-file:/g) || []).length === 1);

const r2 = patcher.remove(sandbox, VERSION);
check('remove() ok: ' + (r2.ok ? 'yes' : r2.reason), r2.ok);
check('restored byte-for-byte', fs.readFileSync(target, 'utf-8') === original);

// Regression: another extension's patch, plus a CSP directive it already relaxed, must
// survive our whole apply/remove cycle untouched. Restoring a captured backup used to
// reinstate the foreign block after the user had removed it.
{
  const foreign = original
    .replace('script-src', "script-src 'unsafe-inline'")
    .replace('</html>', '<!-- other-ext-start -->\n<script>/*theirs*/</script>\n<!-- other-ext-end -->\n</html>');
  fs.writeFileSync(target, foreign, 'utf-8');

  patcher.apply(sandbox, script, VERSION);
  const patched = fs.readFileSync(target, 'utf-8');
  check('foreign block survives our apply', patched.includes('other-ext-start'));
  check("does not double up an already relaxed directive",
    (patched.match(/script-src 'unsafe-inline'/g) || []).length === 1);

  // Re-applying (picking a different wallpaper) must not change what removal will revert.
  patcher.apply(sandbox, script, VERSION);
  patcher.remove(sandbox, VERSION);

  const after = fs.readFileSync(target, 'utf-8');
  check('foreign block still there after our remove', after.includes('other-ext-start'));
  check("their CSP change is not reverted by us", /script-src 'unsafe-inline'/.test(after));
  check('no livewall trace left', !after.includes('livewall-start'));
  check('foreign file restored exactly', after === foreign);
}

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
