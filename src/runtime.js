/**
 * Builds the script injected into workbench.html.
 *
 * The wallpaper is a real element - <video> for video files, <img> for animated images -
 * promoted to its own compositor layer. That is the whole point over CSS-background
 * approaches: decoding stays off the main thread and editor repaints never rerasterize it.
 *
 * The two media kinds are not equivalent. A <video> can be paused, throttled and rate
 * limited; an animated gif/webp is driven by the browser and exposes no playback API, so
 * `video` is null for those and every playback call has to be guarded.
 *
 * CSP notes for VS Code 1.13x:
 *   - `require-trusted-types-for 'script'` is active, so no innerHTML anywhere below.
 *   - `media-src 'self'` means media must be same-origin: vscode-file://vscode-app/<abs path>.
 */
function buildCss(cfg) {
  return `
html, body { background: transparent !important; }

#livewall-media {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 0;
  pointer-events: none;
  opacity: ${cfg.opacity};
  /* own compositor layer - keeps editor repaints off the wallpaper */
  will-change: transform;
  transform: translateZ(0);
}

#livewall-scrim {
  position: fixed;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: rgba(0, 0, 0, ${cfg.scrim});
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
}

function buildScript(cfg) {
  // A playlist rotates entirely inside the renderer. Re-patching workbench.html per change
  // would mean a window reload every rotation, which is unusable.
  const playlist = cfg.playlist && cfg.playlist.length
    ? cfg.playlist
    : [{ src: cfg.src, kind: cfg.kind }];

  const payload = JSON.stringify({
    playlist,
    shuffle: !!cfg.shuffle,
    rotateMs: Math.max(0, Number(cfg.rotateMinutes) || 0) * 60 * 1000,
    rate: cfg.playbackRate,
    pauseOnBlur: cfg.pauseOnBlur,
    respectReducedMotion: cfg.respectReducedMotion,
    css: buildCss(cfg),
  });

  // Kept deliberately dependency-free and defensive: this runs inside VS Code's own renderer.
  return `(function () {
  var CFG = ${payload};

  function boot() {
    if (document.getElementById('livewall-media')) return;

    var style = document.createElement('style');
    style.id = 'livewall-style';
    style.textContent = CFG.css;
    document.head.appendChild(style);

    var scrim = document.createElement('div');
    scrim.id = 'livewall-scrim';
    document.body.insertBefore(scrim, document.body.firstChild);

    var video = null;   // null whenever the current item is an image
    var media = null;
    var index = CFG.shuffle ? Math.floor(Math.random() * CFG.playlist.length) : 0;

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
      if (!video) return;
      try { video.playbackRate = CFG.rate; } catch (e) {}
    }

    function mount(item) {
      var next = build(item);
      if (media && media.parentNode) media.parentNode.replaceChild(next, media);
      else document.body.insertBefore(next, document.body.firstChild);
      media = next;

      if (video) {
        video.addEventListener('loadedmetadata', applyRate);
        video.addEventListener('canplay', sync);
        video.addEventListener('loadeddata', sync);
      }
      media.addEventListener('error', onMediaError);
      if (diag) { diag.media = media; diag.video = video; diag.kind = item.kind; }
      applyRate();
      sync();
    }

    function rotate() {
      if (CFG.playlist.length < 2) return;
      index = CFG.shuffle
        // Re-roll on a repeat so the same wallpaper does not appear twice in a row.
        ? (function () {
            var n = Math.floor(Math.random() * CFG.playlist.length);
            return n === index ? (n + 1) % CFG.playlist.length : n;
          })()
        : (index + 1) % CFG.playlist.length;
      mount(CFG.playlist[index]);
    }

    var reduced = false;
    if (CFG.respectReducedMotion) {
      try {
        reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (e) {}
    }

    // Tracked from real blur/focus events rather than document.hasFocus(): during workbench
    // startup hasFocus() can be false while the window is genuinely focused, and no focus
    // event ever follows, which would strand a video paused on frame 1 forever.
    var blurred = false;

    var diag = {
      lastError: null,
      playRejected: null,
      lastBlurReason: null,
      kind: CFG.playlist[index] && CFG.playlist[index].kind,
      media: media,
      video: video,
      playlist: CFG.playlist.length,
      get index() { return index; },
      reducedMotion: reduced,
      get blurred() { return blurred; },
      get hidden() { return document.hidden; },
      get state() {
        if (!video) return 'image: always animating';
        return reduced ? 'blocked: prefers-reduced-motion'
          : document.hidden ? 'paused: window hidden'
          : (CFG.pauseOnBlur && blurred) ? 'paused: window blurred'
          : video.paused ? 'paused: unknown' : 'playing';
      },
    };
    window.__livewall = diag;

    function shouldPlay() {
      if (reduced) return false;
      if (document.hidden) return false;
      if (CFG.pauseOnBlur && blurred) return false;
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
      var item = CFG.playlist[index] || {};
      diag.lastError = (video && video.error)
        ? video.error.code + ' ' + video.error.message
        : 'failed to load';
      console.warn('[livewall] media error:', diag.lastError, item.src);
      // A deleted or corrupt file must not strand the wallpaper on a broken item.
      if (CFG.playlist.length > 1) rotate();
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
    });
    document.addEventListener('visibilitychange', sync);

    // If autoplay is ever refused, the first real interaction is a valid gesture to retry on.
    document.addEventListener('pointerdown', function retry() {
      document.removeEventListener('pointerdown', retry);
      sync();
    });

    diag.rotate = rotate;
    mount(CFG.playlist[index]);

    if (CFG.rotateMs > 0 && CFG.playlist.length > 1) {
      setInterval(function () {
        // Rotating while the window is hidden burns decode on frames nobody sees.
        if (!document.hidden) rotate();
      }, CFG.rotateMs);
    }
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();`;
}

module.exports = { buildScript };
