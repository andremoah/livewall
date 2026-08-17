# Changelog

## 1.2.1

Listing metadata only — no functional change, and no reason to update if you already have
1.2.0.

- Renamed to **LiveWall — Wallpapers & Backgrounds**. The old title matched nothing anyone
  searches for; this category is looked up as both "wallpaper" and "background".
- Search keywords expanded from 5 to 22.
- Description rewritten to lead with what the extension is rather than how it is built. The
  compositor-layer argument is still in the README, where there is room to make it.

## 1.2.0

### Added

- **Per-theme wallpapers.** `livewall.mediaLight` and `livewall.mediaDark` override
  `livewall.media` when a light or dark colour theme is active, and switch the moment you
  change theme.
- **Schedule.** `livewall.schedule` takes a list of `{ from, media }` entries and changes
  wallpaper by time of day, wrapping past midnight.
- **Blur and saturation.** `livewall.blur` softens detail that competes with text without
  darkening anything; `livewall.saturate` takes a loud wallpaper down, `0` for greyscale.
- **Fit.** `livewall.fit` chooses `cover`, `contain` or `fill`.
- **Pause on battery.** `livewall.pauseOnBattery` stops animating while unplugged and
  resumes when power comes back.

### Fixed

- **`workbench.html` was written non-atomically.** A crash or a full disk part-way through
  left a truncated file, and VS Code will not start without it. The new content now lands
  under a temp name and is renamed into place.
- **The patch was injected at the first `</html>`, not the last.**
- **A lost backup was silently replaced with a patched one.** The `.bak` was a copy of the
  file on disk, so if it went missing while the patch was live, the next re-patch snapshotted
  the patched file as the restore point. It is now written from the stripped content the
  patcher already computes, and is pristine by construction.
- **Reduced motion was read once, at boot.** Turning the OS setting on did nothing until the
  window was reloaded. It is now live, like every other setting.
- **Animated images could never be paused.** `pauseOnBlur`, reduced motion and the new
  battery setting had no effect on `.gif`/`.webp`/`.apng`, which are the most expensive
  wallpapers to run — they repaint on the main thread. They are now held on a captured frame,
  which stops the decode loop outright.
- **The same failure was reported once per settings change.** Dragging a slider with a
  missing wallpaper produced a stream of identical warnings; it is now said once.
- **One new file in the library raised one notification per open window.** Only the focused
  window announces it now.
- **The gallery's search box did nothing for *My library*.** It now filters by filename.
- **Opening the gallery leaked a disposable per open** into the extension's subscriptions.
- **A Wallhaven error was reported as a rejected API key**, for a source that takes no key.
- `~\` was not expanded to your home directory on Windows.
- Sizes under 1 KB displayed as `0 KB`, and providers reporting no size left a dangling `·`.
- `livewall.rotateMinutes` accepted values the extension then clamped.

### Changed

- **Declared as a UI extension.** Over Remote SSH, WSL or Codespaces the extension host runs
  on the remote machine, where there is no workbench to patch. It now always runs locally.
- **Minimum VS Code lowered from 1.120 to 1.82.** Nothing here needed a recent API, and the
  old floor excluded most forks and any installation that is not current.
- **The patcher is tested in CI.** It ran against your real installation or not at all, so on
  a runner it skipped entirely — the one piece of code that can stop VS Code from starting
  was the one piece with no coverage. It now runs against a committed fixture on Linux, macOS
  and Windows, and `extension.js` is exercised end to end through a stubbed `vscode`.

## 1.1.0

### Added

- **Live settings.** The injected script now reads its configuration from a file the
  extension rewrites, and polls it. Opacity, scrim, playback speed, shuffle, rotation and the wallpaper itself all change as you change them. The only remaining reload is the one after the initial patch.
- **Status bar toggle.** A ✨ item turns the wallpaper on and off instantly, backed by a new `livewall.enabled` setting. Turning it off hides the wallpaper without unpatching VS Code.

### Fixed

- **Wallpapers never loaded on Windows.** The drive letter was joined straight onto the page origin, producing `vscode-file://vscode-appC%3A/...` — a different host entirely.
- **`.webm`, `.mov`, `.m4v`, `.ogv`, `.apng` and `.avif` silently failed to load.** VS Code's file protocol only serves a fixed extension whitelist from outside its own directories. Those formats are now staged into a directory it does serve.
- **Settings could inject markup into `workbench.html`.** Numeric settings were interpolated into the generated CSS unescaped, so a value containing `</script>` closed the tag it was written into. Values are now coerced and clamped, the CSS is static, and the payload escapes `<`. All settings are `application` scope, so a workspace cannot set them.
- **A removed wallpaper came back after a VS Code update.** Removal now also turns LiveWall off, and whether the patch is current is read from the file rather than remembered.
- **A playlist of broken files spun forever.** Each load failure rotated to the next item, which failed, which rotated. It now gives up after one pass.
- **Enabling shuffle did not start the library watcher**, and the watcher only noticed files being *added* — replacing one went unseen. It now compares name, size and mtime.
- **Every `livewall.*` change re-patched `workbench.html` and offered a reload**, including entering an API key. Only settings that affect rendering do anything now, and none of them
  need a reload.
- **Downloads never reached your library.** The gallery saved into private extension storage while shuffle read `livewall.library`, so downloaded wallpapers were invisible to it.
- **Downloads were buffered whole in memory** before being written. They now stream to disk.
- **A provider response could write outside the download folder** — the remote `id` went straight into the file path. Filenames are now a single sanitised component and downloads
  are pinned to `https`.
- The gallery webview could read any file under your home directory; its resource roots are now limited to the library and extension storage, and its script runs under a nonce.
- Opening the gallery twice opened a second, competing panel.
- Local video thumbnails all autoplayed at once; they now play on hover.
- The search cache grew forever and could collide on long queries.
- CSP relaxation tested one directive while editing another.

## 1.0.0

Initial release.
