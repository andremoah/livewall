/**
 * Builds the script injected into workbench.html.
 *
 * The wallpaper is a real element - <video> for video files, <img> for animated images -
 * promoted to its own compositor layer. That is the whole point over CSS-background
 * approaches: decoding stays off the main thread and editor repaints never rerasterize it.
 *
 * The script carries no configuration. Everything it needs it fetches from a small JSON
 * file the extension rewrites on every settings change, and re-polls a couple of times a
 * second. That indirection is what makes opacity, scrim, speed, the on/off toggle and even
 * the wallpaper itself change live - patching workbench.html per change would mean a window
 * reload every time, which is why those settings used to be untunable in practice.
 *
 * The two media kinds are not equivalent. A <video> can be paused, throttled and rate
 * limited; an animated gif/webp is driven by the browser and exposes no playback API, so
 * `video` is null for those and every playback call has to be guarded.
 *
 * CSP notes for VS Code 1.13x:
 *   - `require-trusted-types-for 'script'` is active, so no innerHTML anywhere below.
 *   - `media-src 'self'` means media must be same-origin: vscode-file://vscode-app/<abs path>.
 *   - `connect-src 'self'` already covers fetching the state file from that same origin,
 *     so the live channel costs no extra CSP relaxation.
 */

/**
 * Static, so nothing user-controlled is ever interpolated into the injected markup. The two
 * values that do change ride in as custom properties the extension updates at runtime.
 */
const CSS = `
html, body { background: transparent !important; }

#livewall-media {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 0;
  pointer-events: none;
  opacity: var(--livewall-opacity, 0.35);
  /* own compositor layer - keeps editor repaints off the wallpaper */
  will-change: transform;
  transform: translateZ(0);
}

#livewall-scrim {
  position: fixed;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: rgba(0, 0, 0, var(--livewall-scrim, 0.55));
}

.monaco-workbench {
  position: relative;
  z-index: 2;
  background: transparent !important;
  /* subpixel AA over a transparent bg makes text look thin and fringed */
  -webkit-font-smoothing: antialiased;
}

.monaco-workbench .part,
.monaco-workbench .part > .content,
.monaco-workbench .editor-group-container,
.monaco-workbench .editor-container,
.monaco-workbench .split-view-view,
.monaco-workbench .pane-body,
.monaco-workbench .title.tabs,
.monaco-workbench .tabs-container,
.monaco-workbench .monaco-editor,
.monaco-workbench .monaco-editor .margin,
.monaco-workbench .monaco-editor-background,
.monaco-workbench .terminal-wrapper,
.monaco-workbench .xterm-screen,
.monaco-workbench .composite,
.monaco-workbench .monaco-pane-view,
.monaco-workbench .monaco-pane-view .pane,
.monaco-workbench .monaco-pane-view .pane > .pane-header,
.monaco-workbench .monaco-list,
.monaco-workbench .monaco-list .monaco-list-rows,
.monaco-workbench .monaco-tl-contents,
.monaco-workbench .webview,
.monaco-workbench .webview-overlay-content,
.monaco-workbench .webview-container,
.monaco-workbench .part.auxiliarybar iframe,
.monaco-workbench .part.panel iframe,
.monaco-workbench .part.sidebar iframe {
  background-color: transparent !important;
}

/* The empty-editor VS Code logo is designed to sit invisibly against a flat editor
   background. Over a wallpaper it reads as a stray watermark. */
.monaco-workbench .editor-group-watermark .letterpress {
  display: none !important;
}

/* Floating widgets must stay opaque or they become unreadable over motion. */
.monaco-workbench .suggest-widget,
.monaco-workbench .monaco-hover,
.monaco-workbench .quick-input-widget,
.monaco-workbench .monaco-menu,
.monaco-workbench .notifications-toasts,
.monaco-workbench .notification-toast,
.monaco-workbench .sticky-widget,
.monaco-workbench .editor-widget.find-widget {
  background-color: var(--vscode-editorWidget-background) !important;
}
`.trim();

const DEFAULT_POLL_MS = 1500;

/**
 * @param {{stateUrl: string, pollMs?: number}} opts
 */
function buildScript(opts) {
  // JSON.stringify does not escape `<`, so a value containing `</script>` would close the
  // tag we are writing into. Nothing user-controlled reaches this payload any more, but the
  // escape stays: it is the difference between "safe" and "safe as long as nobody adds a
  // field here later".
  const payload = JSON.stringify({
    stateUrl: opts.stateUrl,
    pollMs: opts.pollMs || DEFAULT_POLL_MS,
    css: CSS,
  }).replace(/</g, '\\u003c');

  // Kept deliberately dependency-free and defensive: this runs inside VS Code's own renderer.
  return `(function () {
  var CFG = ${payload};

  function boot() {
    if (document.getElementById('livewall-scrim')) return;

    var style = document.createElement('style');
    style.id = 'livewall-style';
    style.textContent = CFG.css;
    document.head.appendChild(style);

    var scrim = document.createElement('div');
    scrim.id = 'livewall-scrim';
    document.body.insertBefore(scrim, document.body.firstChild);

    var state = null;   // last configuration read from disk
    var video = null;   // null whenever the current item is an image
    var media = null;
    var index = 0;
    var rotTimer = null;
    var errors = 0;     // consecutive load failures, to stop a broken playlist spinning

    var reducedMotion = false;
    try {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}

    // Tracked from real blur/focus events rather than document.hasFocus(): during workbench
    // startup hasFocus() can be false while the window is genuinely focused, and no focus
    // event ever follows, which would strand a video paused on frame 1 forever.
    var blurred = false;

    function playlist() { return (state && state.playlist) || []; }
    function enabled() { return !!(state && state.enabled && playlist().length); }
    function reduced() { return reducedMotion && !!(state && state.respectReducedMotion); }

    var diag = {
      lastError: null,
      lastStateError: null,
      playRejected: null,
      lastBlurReason: null,
      media: null,
      video: null,
      get stamp() { return state && state.stamp; },
      get kind() { return (playlist()[index] || {}).kind; },
      get playlist() { return playlist().length; },
      get index() { return index; },
      get enabled() { return enabled(); },
      get reducedMotion() { return reduced(); },
      get blurred() { return blurred; },
      get hidden() { return document.hidden; },
      get state() {
        if (!state) return 'waiting: no state file yet';
        if (!state.enabled) return 'off: disabled';
        if (!playlist().length) return 'off: no wallpaper set';
        if (!video) return 'image: always animating';
        return reduced() ? 'blocked: prefers-reduced-motion'
          : document.hidden ? 'paused: window hidden'
          : (state.pauseOnBlur && blurred) ? 'paused: window blurred'
          : video.paused ? 'paused: unknown' : 'playing';
      },
    };
    window.__livewall = diag;

    function build(item) {
      var el;
      if (item.kind === 'video') {
        el = video = document.createElement('video');
        el.muted = true;
        el.defaultMuted = true;
        el.loop = true;
        el.autoplay = true;
        el.controls = false;
        el.setAttribute('playsinline', '');
        el.setAttribute('disablepictureinpicture', '');
      } else {
        // Animated gif/webp/apng: the browser drives the animation and exposes no playback
        // API, so rate and pause controls simply do not apply.
        video = null;
        el = document.createElement('img');
        el.decoding = 'async';
      }
      el.id = 'livewall-media';
      el.setAttribute('aria-hidden', 'true');
      el.src = item.src;
      return el;
    }

    function applyRate() {
      if (!video || !state) return;
      try { video.playbackRate = state.rate; } catch (e) {}
    }

    function onLoaded() {
      errors = 0;
      applyRate();
      sync();
    }

    function mount(item) {
      if (!item) return;
      var next = build(item);
      if (media && media.parentNode) media.parentNode.replaceChild(next, media);
      else document.body.insertBefore(next, document.body.firstChild);
      media = next;

      if (video) {
        video.addEventListener('loadedmetadata', applyRate);
        video.addEventListener('canplay', onLoaded);
        video.addEventListener('loadeddata', onLoaded);
      } else {
        media.addEventListener('load', onLoaded);
      }
      media.addEventListener('error', onMediaError);
      diag.media = media;
      diag.video = video;
      applyRate();
      sync();
    }

    function unmount() {
      if (media && media.parentNode) media.parentNode.removeChild(media);
      // Drop the source too, or a hidden <video> keeps its decoder alive.
      if (media) { try { media.removeAttribute('src'); } catch (e) {} }
      media = null;
      video = null;
      diag.media = null;
      diag.video = null;
    }

    function rotate() {
      var list = playlist();
      if (list.length < 2) return;
      index = state.shuffle
        // Re-roll on a repeat so the same wallpaper does not appear twice in a row.
        ? (function () {
            var n = Math.floor(Math.random() * list.length);
            return n === index ? (n + 1) % list.length : n;
          })()
        : (index + 1) % list.length;
      mount(list[index]);
    }

    function shouldPlay() {
      if (!enabled()) return false;
      if (reduced()) return false;
      if (document.hidden) return false;
      if (state.pauseOnBlur && blurred) return false;
      return true;
    }

    function sync() {
      if (!video) return;
      if (!shouldPlay()) {
        video.pause();
        return;
      }
      var p = video.play();
      if (p && p.catch) {
        p.catch(function (err) {
          diag.playRejected = String(err);
          console.warn('[livewall] play() rejected:', err);
        });
      }
    }

    function onMediaError() {
      var item = playlist()[index] || {};
      diag.lastError = (video && video.error)
        ? video.error.code + ' ' + video.error.message
        : 'failed to load';
      console.warn('[livewall] media error:', diag.lastError, item.src);

      // A deleted or corrupt file must not strand the wallpaper on a broken item - but a
      // whole playlist of broken items must not spin either, so give up after one pass.
      errors++;
      if (playlist().length > 1 && errors < playlist().length) rotate();
      else if (errors >= playlist().length) {
        console.warn('[livewall] every wallpaper failed to load, giving up until settings change');
      }
    }

    function restartRotation() {
      if (rotTimer) { clearInterval(rotTimer); rotTimer = null; }
      if (!state || !(state.rotateMs > 0) || playlist().length < 2) return;
      rotTimer = setInterval(function () {
        // Rotating while the window is hidden burns decode on frames nobody sees.
        if (!document.hidden && enabled()) rotate();
      }, state.rotateMs);
    }

    function srcsOf(s) {
      return ((s && s.playlist) || []).map(function (i) { return i.src; }).join('\\n');
    }

    function applyState(next) {
      var prev = state;
      state = next;

      var root = document.documentElement;
      if (root && root.style && root.style.setProperty) {
        root.style.setProperty('--livewall-opacity', String(next.opacity));
        root.style.setProperty('--livewall-scrim', String(next.scrim));
      }
      scrim.style.display = enabled() ? '' : 'none';

      if (!enabled()) {
        unmount();
        restartRotation();
        return;
      }

      // Only remount when the wallpapers themselves changed. Dragging the opacity slider
      // must not restart the video.
      if (!media || !prev || srcsOf(prev) !== srcsOf(next)) {
        index = next.shuffle ? Math.floor(Math.random() * next.playlist.length) : 0;
        errors = 0;
        mount(next.playlist[index]);
      } else {
        applyRate();
        sync();
      }
      restartRotation();
    }

    function poll() {
      if (typeof fetch !== 'function') return;
      fetch(CFG.stateUrl + '?t=' + Date.now(), { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('state ' + res.status);
          return res.json();
        })
        .then(function (next) {
          if (!next || (state && next.stamp === state.stamp)) return;
          diag.lastStateError = null;
          applyState(next);
        })
        .catch(function (err) { diag.lastStateError = String(err); });
    }

    // Webview panels (Copilot, chat, notebook renderers) are iframes, and VS Code runs them
    // as out-of-process frames. Focusing one fires a blur event on the top-level window AND
    // makes document.hasFocus() report false - the parent renderer genuinely lost focus to
    // another process - so hasFocus() cannot tell "switched app" from "clicked a panel".
    //
    // What does distinguish them: when focus moves into a child frame, document.activeElement
    // is that frame element. When the whole app is backgrounded, it is not.
    function focusIsInChildFrame() {
      var el = document.activeElement;
      if (!el || !el.tagName) return false;
      var tag = el.tagName.toUpperCase();
      return tag === 'IFRAME' || tag === 'WEBVIEW';
    }

    var blurTimer = null;
    window.addEventListener('blur', function () {
      clearTimeout(blurTimer);
      // Deferred: activeElement/hasFocus have not settled inside the blur handler.
      blurTimer = setTimeout(function () {
        if (focusIsInChildFrame()) {
          diag.lastBlurReason = 'ignored: focus in webview';
          return;
        }
        if (!document.hasFocus()) {
          diag.lastBlurReason = 'paused: app blurred';
          blurred = true;
          sync();
        }
      }, 200);
    });
    window.addEventListener('focus', function () {
      clearTimeout(blurTimer);
      blurred = false;
      sync();
      poll();   // catch up immediately on anything changed while we were away
    });
    document.addEventListener('visibilitychange', function () {
      sync();
      if (!document.hidden) poll();
    });

    // If autoplay is ever refused, the first real interaction is a valid gesture to retry on.
    document.addEventListener('pointerdown', function retry() {
      document.removeEventListener('pointerdown', retry);
      sync();
    });

    diag.rotate = rotate;
    diag.poll = poll;
    diag.apply = applyState;

    poll();
    setInterval(function () { if (!document.hidden) poll(); }, CFG.pollMs);
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();`;
}

module.exports = { buildScript, CSS, DEFAULT_POLL_MS };
