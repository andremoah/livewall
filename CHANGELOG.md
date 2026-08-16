# Changelog

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
