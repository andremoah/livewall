/**
 * Runs the patcher and the injected runtime against a throwaway copy of the real installed
 * workbench.html. No VS Code process involved, nothing written outside a temp dir.
 *
 *   node test/smoke.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const patcher = require('../src/patcher');
const media = require('../src/media');
const { buildScript } = require('../src/runtime');

const APP_ROOT =
  process.env.LIVEWALL_APP_ROOT ||
  '/Applications/Visual Studio Code.app/Contents/Resources/app';
const REL = 'out/vs/code/electron-browser/workbench/workbench.html';
const STAMP = '1.99.0/0.0.0-test';
const STATE_URL = 'vscode-file://vscode-app/tmp/livewall/state.json';

let fails = 0;
const check = (name, cond) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name);
  if (!cond) fails++;
};

const tick = () => new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------------ syntax */

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

/* ------------------------------------------------------------------ media paths */

{
  const { toWorkbenchUrl, needsStaging } = media;

  check('posix path keeps its leading slash',
    toWorkbenchUrl('/Users/me/a.mp4', '/') === 'vscode-file://vscode-app/Users/me/a.mp4');

  // Regression: the drive letter used to be glued onto the origin, producing the host
  // `vscode-appc%3a` and a wallpaper that never loaded on Windows.
  const win = toWorkbenchUrl('C:\\Users\\me\\a.mp4', '\\');
  check('windows path is not glued onto the origin', win.startsWith('vscode-file://vscode-app/'));
  check('windows path keeps the drive letter', /vscode-app\/C(%3A|:)\/Users\/me\/a\.mp4$/.test(win));

  check('spaces are encoded',
    toWorkbenchUrl('/a b/c.mp4', '/') === 'vscode-file://vscode-app/a%20b/c.mp4');

  // VS Code's vscode-file: handler only serves this whitelist from outside its own roots.
  check('mp4 needs no staging', !needsStaging('/x/a.mp4'));
  check('webm needs staging', needsStaging('/x/a.webm'));
  check('mov needs staging', needsStaging('/x/a.mov'));
  check('gif needs no staging', !needsStaging('/x/a.gif'));

  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'livewall-stage-'));
  const src = path.join(box, 'clip.webm');
  fs.writeFileSync(src, 'not really a video');
  const stageDir = path.join(box, 'staged');

  const staged = media.stage(src, stageDir);
  check('webm is staged into a servable directory', !!staged && staged.startsWith(stageDir));
  check('staged file resolves to the original', staged && fs.readFileSync(staged, 'utf-8') === 'not really a video');
  check('staged name keeps the extension', staged && staged.endsWith('.webm'));
  check('staging twice reuses the same path', media.stage(src, stageDir) === staged);
  check('mp4 is passed through untouched', media.stage('/x/a.mp4', stageDir) === '/x/a.mp4');
  check('staging a missing file fails softly', media.stage(path.join(box, 'gone.webm'), stageDir) === null);
  fs.rmSync(box, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ sources */

// Fixtures shaped like the real upstream responses. The Pixabay thumbnail lives on each
// size variant - there is no top-level thumb field, which is exactly what I got wrong by
// assuming one instead of checking.
{
  const { parse, destinationFor } = require('../src/sources');

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

  // `id` is provider-controlled, so it must never be able to walk out of the download folder.
  const evil = destinationFor({ id: '../../../../etc/passwd', ext: '.mp4' }, '/downloads');
  check('download id cannot escape the destination', path.dirname(evil) === path.join('/downloads'));
  check('download id is reduced to safe characters', /^[A-Za-z0-9._-]+\.mp4$/.test(path.basename(evil)));
  check('unknown extension is not trusted',
    destinationFor({ id: 'a', ext: '.sh' }, '/d').endsWith('.bin'));
}

/* ------------------------------------------------------------------ runtime */

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
      style: { setProperty(k, v) { this[k] = v; } },
      listeners: {},
      children: [],
      parentNode: null,
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      insertBefore(c) { c.parentNode = this; this.children.unshift(c); return c; },
      replaceChild(next, old) {
        const i = this.children.indexOf(old);
        if (i >= 0) this.children[i] = next; else this.children.push(next);
        next.parentNode = this;
        old.parentNode = null;
        return old;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
      },
      fire(t) { for (const fn of (this.listeners[t] || []).slice()) fn(); },
      pause() { this.paused = true; },
      play() { this.paused = false; return Promise.resolve(); },
      paused: true,
    };
    created.push(el);
    return el;
  };

  const body = make('body');
  body.firstChild = null;
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
      documentElement: make('html'),
      hidden: false,
      activeElement: null,
      getElementById: (id) => body.children.concat(created).find((e) => e.id === id) || null,
      createElement: make,
      addEventListener() {},
      removeEventListener() {},
      hasFocus: () => true,
    },
  };
}

function stateOf(over) {
  return Object.assign({
    enabled: true,
    playlist: [{ src: 'vscode-file://vscode-app/tmp/a.mp4', kind: 'video' }],
    shuffle: false,
    rotateMs: 0,
    rate: 1,
    pauseOnBlur: true,
    respectReducedMotion: false,
    opacity: 0.35,
    scrim: 0.55,
    stamp: 's1',
  }, over);
}

/** Serves whatever `box.state` currently holds, the way the real state file does. */
function run(script, box) {
  const dom = fakeDom();
  const fetchImpl = () => Promise.resolve({
    ok: box.state !== null,
    status: box.state === null ? 404 : 200,
    json: () => Promise.resolve(box.state),
  });
  let err = null;
  try {
    new Function(
      'window', 'document', 'console', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'fetch', script
    )(
      dom.window, dom.document, { warn() {} },
      () => 0, () => {}, () => 0, () => {}, fetchImpl
    );
  } catch (e) {
    err = e.message;
  }
  return { dom, err, diag: () => dom.window.__livewall };
}

async function runtimeTests() {
  const script = buildScript({ stateUrl: STATE_URL });

  // The runtime is assembled inside a template literal, so a stray backtick anywhere in it
  // silently truncates the script and the extension fails to activate. Parse it first.
  let parseErr = null;
  try { new Function(script); } catch (e) { parseErr = e.message; }
  check('generated script parses' + (parseErr ? ': ' + parseErr : ''), !parseErr);
  check('script is not truncated', script.trim().endsWith('})();'));
  check('no stray backtick in generated script', !script.includes('`'));
  check('script carries the state url', script.includes(STATE_URL));
  check('script carries no wallpaper configuration', !script.includes('opacity":'));

  // A `</script>` anywhere in the payload would close the tag we are writing into.
  const evil = buildScript({ stateUrl: 'x</script><script>alert(1)</script>' });
  check('payload cannot close the script tag', !evil.includes('</script>'));
  check('payload escapes < as \\u003c', evil.includes('\\u003c/script'));

  for (const [kind, file] of [['video', '/tmp/a.mp4'], ['image', '/tmp/a.webp']]) {
    const box = { state: stateOf({ playlist: [{ src: 'vscode-file://vscode-app' + file, kind }] }) };
    const r = run(script, box);
    check(`${kind} script runs without throwing` + (r.err ? ': ' + r.err : ''), !r.err);
    await tick();

    const tags = r.dom.created.map((e) => e.tagName);
    check(`${kind} script creates a ${kind === 'video' ? 'VIDEO' : 'IMG'} element`,
      tags.includes(kind === 'video' ? 'VIDEO' : 'IMG'));
    check(`${kind} script does not create the other element`,
      !tags.includes(kind === 'video' ? 'IMG' : 'VIDEO'));
    check(`${kind} diag reports the kind`, r.diag() && r.diag().kind === kind);
  }

  // Opacity and scrim ride in as custom properties, which is what makes them live.
  {
    const box = { state: stateOf({ opacity: 0.8, scrim: 0.1 }) };
    const r = run(script, box);
    await tick();
    const style = r.dom.document.documentElement.style;
    check('opacity applied as a custom property', style['--livewall-opacity'] === '0.8');
    check('scrim applied as a custom property', style['--livewall-scrim'] === '0.1');

    // A new state with the same wallpapers must not restart the video.
    const before = r.diag().media;
    box.state = stateOf({ opacity: 0.2, scrim: 0.9, stamp: 's2' });
    r.diag().poll();
    await tick();
    check('opacity change is picked up live',
      r.dom.document.documentElement.style['--livewall-opacity'] === '0.2');
    check('opacity change does not remount the wallpaper', r.diag().media === before);

    // An unchanged stamp is a no-op.
    r.diag().poll();
    await tick();
    check('unchanged stamp does not remount', r.diag().media === before);
  }

  // The on/off toggle has to take effect without a reload, and stop decoding when off.
  {
    const box = { state: stateOf({}) };
    const r = run(script, box);
    await tick();
    check('wallpaper mounted while enabled', !!r.diag().media);

    box.state = stateOf({ enabled: false, stamp: 's2' });
    r.diag().poll();
    await tick();
    check('disabling removes the media element', r.diag().media === null);
    check('diag reports the off state', r.diag().state === 'off: disabled');

    box.state = stateOf({ enabled: true, stamp: 's3' });
    r.diag().poll();
    await tick();
    check('re-enabling brings the wallpaper back', !!r.diag().media);
  }

  // Playlist: mixing kinds is the risky path, because rotating from video to image swaps the
  // element type and leaves `video` null for every video-only call downstream.
  {
    const box = { state: stateOf({
      playlist: [
        { src: 'vscode-file://vscode-app/tmp/a.mp4', kind: 'video' },
        { src: 'vscode-file://vscode-app/tmp/b.webp', kind: 'image' },
        { src: 'vscode-file://vscode-app/tmp/c.gif', kind: 'image' },
      ],
    }) };
    const r = run(script, box);
    await tick();

    const diag = r.diag();
    check('playlist size exposed', diag.playlist === 3);
    check('starts on first item', diag.index === 0 && diag.kind === 'video');

    // Rotating video -> image is where an unguarded video.* call would throw.
    let rotErr = null;
    try { diag.rotate(); } catch (e) { rotErr = e.message; }
    check('rotate video->image does not throw' + (rotErr ? ': ' + rotErr : ''), !rotErr);
    check('rotated to second item', diag.index === 1 && diag.kind === 'image');
    check('video handle cleared on image', diag.video === null);
  }

  // Regression: a playlist where every file is missing used to rotate on each error for ever.
  {
    const box = { state: stateOf({
      playlist: [
        { src: 'vscode-file://vscode-app/tmp/gone1.mp4', kind: 'video' },
        { src: 'vscode-file://vscode-app/tmp/gone2.mp4', kind: 'video' },
      ],
    }) };
    const r = run(script, box);
    await tick();

    const diag = r.diag();
    diag.media.fire('error');
    check('first failure rotates away from the broken item', diag.index === 1);
    diag.media.fire('error');
    const settled = diag.index;
    diag.media.fire('error');
    diag.media.fire('error');
    check('a fully broken playlist stops rotating', diag.index === settled);
    check('the failure is reported', !!diag.lastError);
  }

  // No state file yet (first launch before the extension has written one) must not throw.
  {
    const r = run(script, { state: null });
    check('missing state file does not throw' + (r.err ? ': ' + r.err : ''), !r.err);
    await tick();
    check('missing state file is reported', r.diag().state === 'waiting: no state file yet');
    check('missing state file is recorded', !!r.diag().lastStateError);
  }
}

/* ------------------------------------------------------------------ patcher */

async function patcherTests() {
  const script = buildScript({ stateUrl: STATE_URL });

  const source = path.join(APP_ROOT, REL);
  if (!fs.existsSync(source)) {
    console.log(`\nSKIP: no workbench.html at ${source}`);
    return;
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

  const r1 = patcher.apply(sandbox, script, STAMP);
  check('apply() ok: ' + (r1.ok ? 'yes' : r1.reason), r1.ok);

  let html = fs.readFileSync(target, 'utf-8');
  check('start marker present', new RegExp(`<!-- livewall-start ${STAMP} csp=\\S+ -->`).test(html));
  check('start marker records the CSP directives it relaxed', /csp=script\+media/.test(html));
  check('end marker present', html.includes('<!-- livewall-end -->'));
  check('closing </html> preserved', html.trimEnd().endsWith('</html>'));
  check("script-src got 'unsafe-inline'", /script-src\s+'unsafe-inline'/.test(html));
  check('media-src got vscode-file:', /media-src\s+'self'\s+vscode-file:/.test(html));
  check('state url injected', html.includes(STATE_URL));
  check('no innerHTML (trusted-types safe)', !/innerHTML/.test(html.split('<!-- livewall-start')[1]));
  check('backup created', fs.existsSync(`${target}.livewall-1.99.0.bak`));
  check('isPatched() true', patcher.isPatched(sandbox, STAMP));
  check('isPatched() false for another build', !patcher.isPatched(sandbox, '1.99.0/9.9.9'));

  // The live state channel: written beside workbench.html because that is the one directory
  // VS Code will serve a .json from.
  const p = patcher.paths(sandbox);
  check('state path sits beside workbench.html', path.dirname(p.dir) === path.dirname(target));
  const wrote = patcher.writeState(sandbox, { enabled: true, stamp: 'abc' });
  check('writeState ok: ' + (wrote.ok ? 'yes' : wrote.reason), wrote.ok);
  check('state file is valid json',
    JSON.parse(fs.readFileSync(p.state, 'utf-8')).stamp === 'abc');
  check('no half-written temp file left behind', !fs.existsSync(p.state + '.tmp'));

  // Applying twice must not stack blocks or double-edit the CSP.
  patcher.apply(sandbox, script, STAMP);
  html = fs.readFileSync(target, 'utf-8');
  check('exactly 1 block after 2x apply', (html.match(/livewall-start/g) || []).length === 1);
  check("exactly 1 'unsafe-inline'", (html.match(/script-src\s+'unsafe-inline'/g) || []).length === 1);
  check('exactly 1 vscode-file:', (html.match(/media-src\s+'self'\s+vscode-file:/g) || []).length === 1);

  const r2 = patcher.remove(sandbox, STAMP);
  check('remove() ok: ' + (r2.ok ? 'yes' : r2.reason), r2.ok);
  check('restored byte-for-byte', fs.readFileSync(target, 'utf-8') === original);
  check('state directory removed with the patch', !fs.existsSync(p.dir));
  check('backup removed with the patch', !fs.existsSync(`${target}.livewall-1.99.0.bak`));

  // Regression: another extension's patch, plus a CSP directive it already relaxed, must
  // survive our whole apply/remove cycle untouched. Restoring a captured backup used to
  // reinstate the foreign block after the user had removed it.
  {
    const foreign = original
      .replace('script-src', "script-src 'unsafe-inline'")
      .replace('</html>', '<!-- other-ext-start -->\n<script>/*theirs*/</script>\n<!-- other-ext-end -->\n</html>');
    fs.writeFileSync(target, foreign, 'utf-8');

    patcher.apply(sandbox, script, STAMP);
    const patched = fs.readFileSync(target, 'utf-8');
    check('foreign block survives our apply', patched.includes('other-ext-start'));
    check('does not double up an already relaxed directive',
      (patched.match(/script-src 'unsafe-inline'/g) || []).length === 1);
    check('only the directive we did relax is recorded', /csp=media -->/.test(patched));

    // Re-applying (picking a different wallpaper) must not change what removal will revert.
    patcher.apply(sandbox, script, STAMP);
    patcher.remove(sandbox, STAMP);

    const after = fs.readFileSync(target, 'utf-8');
    check('foreign block still there after our remove', after.includes('other-ext-start'));
    check('their CSP change is not reverted by us', /script-src 'unsafe-inline'/.test(after));
    check('no livewall trace left', !after.includes('livewall-start'));
    check('foreign file restored exactly', after === foreign);
  }

  fs.rmSync(sandbox, { recursive: true, force: true });
}

runtimeTests()
  .then(patcherTests)
  .then(() => {
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
    process.exit(fails === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
