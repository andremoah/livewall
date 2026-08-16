# LiveWall

**[⬇︎ Install](https://marketplace.visualstudio.com/items?itemName=andremota.livewall)**
 · [🐛 Report an issue](https://github.com/andremoah/livewall/issues)
 · [MIT](LICENSE)

Animated video wallpapers behind your code.

Unlike CSS-background approaches, the wallpaper is a real `<video>` element promoted to its
own compositor layer. Decoding runs off the main thread and editor repaints never
rerasterize it, so typing latency is unaffected.

![Choosing a wallpaper and seeing it applied](https://raw.githubusercontent.com/andremoah/livewall/main/media/screenshots/demo.gif)

## Features

- **Video and animated images** — `.mp4`, `.webm`, `.mov`, `.gif`, `.webp`, `.apng`. Still images work too.
- **Built-in search** — browse Wallhaven, Pixabay and Pexels from inside the editor and apply with one click.
- **Your own folder** — point LiveWall at a directory, drop files in, they appear automatically.
- **Shuffle and rotation** — use the whole folder as a playlist and change wallpaper on a timer.
- **Readability first** — a scrim layer guarantees a contrast floor no matter how bright the video gets.
- **Battery aware** — pauses when the window loses focus or is hidden, and honours the OS reduced-motion setting.

## Getting started

Install from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=andremota.livewall),
or search for `LiveWall` in the Extensions view.

1. Run **LiveWall: Choose wallpaper…** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Search, or pick a local file.
3. Reload the window when prompted.

Image search works immediately with no account. Video search needs a free API key — see below.

![The wallpaper gallery](https://raw.githubusercontent.com/andremoah/livewall/main/media/screenshots/gallery.png)

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `livewall.media` | `""` | Path to the current wallpaper. `~` is supported. |
| `livewall.library` | `""` | Folder used by the gallery and watched for new files. |
| `livewall.shuffle` | `false` | Use the whole library as a playlist. |
| `livewall.rotateMinutes` | `0` | Minutes between wallpapers. `0` keeps one per session. |
| `livewall.opacity` | `0.35` | Opacity of the wallpaper layer. |
| `livewall.scrim` | `0.55` | Darkening between wallpaper and UI. Raise it if text is hard to read. |
| `livewall.playbackRate` | `1` | Video speed. Below `1` is calmer and cheaper. |
| `livewall.pauseOnBlur` | `true` | Pause when the window loses focus. |
| `livewall.respectReducedMotion` | `true` | Do not animate when the OS asks for reduced motion. |
| `livewall.downloadSites` | *(4 sites)* | Sites opened by **Browse online…**. |

`livewall.scrim` is the readability dial. Opacity fades the wallpaper toward whatever is
behind it, which shifts with your theme; the scrim is a fixed sheet, so bright frames can
never blow out your text.

## Video search keys

Image search (Wallhaven) needs nothing. Video search uses your own free key, stored in your
settings and sent only to the provider:

- **Pixabay** — [pixabay.com/api/docs](https://pixabay.com/api/docs/), instant, 100 req/min, no monthly cap
- **Pexels** — [pexels.com/api](https://www.pexels.com/api/), 200 req/h, 20 000 req/month

Search results are cached on disk for 24 hours, so repeated searches cost no requests at all.

## Performance

Keeping this cheap comes down to the source file:

- **h264 `.mp4`, 1080p or less** — hardware decoded on every platform
- **Short loops** — frame count drives memory more than resolution does
- **Pre-bake any blur or darkening** into the file rather than applying filters at runtime

A fullscreen animated `.gif` or `.webp` is the most expensive option, because the browser
repaints the whole layer on the main thread. Video on its own layer is far cheaper.

Convert a clip with `ffmpeg`:

```bash
ffmpeg -i in.mp4 -t 6 -vf "fps=24,scale=1600:-2:flags=lanczos,format=yuv420p" \
  -c:v libx264 -crf 26 -an out.mp4
```

## What it changes

VS Code has no API for putting anything behind the editor, so LiveWall modifies one file
inside your VS Code installation and injects a small script into the workbench.

> ### Run **LiveWall: Remove wallpaper** before you uninstall
>
> VS Code does not run extension code on uninstall, so removing LiveWall from the
> Extensions view leaves the modified file in place and the wallpaper still showing, with
> nothing left to undo it.
>
> Run the command first and the file goes back exactly as it was. If you have already
> uninstalled, reinstall LiveWall, run the command, then uninstall again.

Worth knowing before you install:

- **A "Your Code installation appears to be corrupt" warning** appears once after installing.
  Modifying the application bundle changes its checksum. Dismiss it with *Don't Show Again*.
- **VS Code updates wipe the patch.** LiveWall detects the version change on next launch and
  re-applies automatically.
- **Do not run alongside other workbench-patching extensions** such as `shalldie.background`
  or `custom-ui-style`. They edit the same file and will fight over it. If one of them left
  a patch behind, LiveWall does not touch it — removing LiveWall reverts only its own
  changes, so a wallpaper from another extension will still be there afterwards.
- **Webview panels stay opaque.** Panels like Copilot Chat run in separate renderer
  processes; no stylesheet in the workbench document can reach inside them.

## Troubleshooting

Open **Help → Toggle Developer Tools** and check:

```js
window.__livewall.state
```

| Value | Meaning |
| --- | --- |
| `playing` | Working. |
| `paused: window blurred` | Expected while DevTools has focus. |
| `blocked: prefers-reduced-motion` | Your OS asks for reduced motion. Set `livewall.respectReducedMotion` to `false`. |
| `image: always animating` | Current wallpaper is an image; pause controls do not apply. |
| `paused: unknown` | A bug. Please open an issue. |

`window.__livewall.lastError` and `.playRejected` hold the last media failure.

## Privacy

LiveWall has no telemetry and no backend. API keys stay in your settings and are sent only
to the provider you searched. Downloads go directly from the source CDN to your machine.

## Credits

Wallpapers come from [Wallhaven](https://wallhaven.cc), [Pixabay](https://pixabay.com) and
[Pexels](https://www.pexels.com). Each remains the property of its author, credited in the
gallery.

## Support

If LiveWall makes your editor nicer to look at:

[<img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="48">](https://buymeacoffee.com/andremota)

## License

MIT
