const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const { scanLibrary, expandHome, VIDEO_EXT, IMAGE_EXT } = require('./media');
const sources = require('./sources');

// Attribution required by the providers' terms: the author is credited on each card, the
// provider under the grid.
const PROVIDERS = {
  pixabay: { url: 'https://pixabay.com', credit: 'Video from Pixabay' },
  pexels: { url: 'https://www.pexels.com', credit: 'Video from Pexels' },
  wallhaven: { url: 'https://wallhaven.cc', credit: 'Images from Wallhaven' },
  'wallhaven-anime': { url: 'https://wallhaven.cc', credit: 'Images from Wallhaven' },
};

function humanSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  // A 500-byte file used to read as "0 KB".
  return bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B';
}

/** Providers that report no size would otherwise leave a dangling " · " on the card. */
function subOf(kind, bytes) {
  const size = humanSize(bytes);
  return size ? `${kind} · ${size}` : kind;
}

function renderHtml(webview) {
  // A nonce rather than blanket 'unsafe-inline': the page has exactly one script and it is
  // ours, so there is no reason to allow any other.
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `media-src ${webview.cspSource} https:`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 16px; margin: 0; }
  header { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  input, select, button { font: inherit; padding: 6px 10px; border-radius: 3px;
    border: 1px solid var(--vscode-input-border, transparent); }
  input { flex: 1; min-width: 200px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  button { cursor: pointer; border: none; color: var(--vscode-button-foreground);
    background: var(--vscode-button-background); }
  button.secondary { background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); }
  .status { font-size: 12px; opacity: .7; margin: 8px 0 12px; min-height: 16px; }
  .grid { display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  .card { padding: 0; overflow: hidden; border-radius: 6px; cursor: pointer;
    background: var(--vscode-editorWidget-background);
    border: 2px solid transparent; color: inherit; text-align: left; }
  .card:hover { border-color: var(--vscode-focusBorder); }
  .card.selected { border-color: var(--vscode-button-background); }
  .thumb { aspect-ratio: 16/9; background: #0008; }
  .thumb img, .thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .meta { padding: 8px 10px; }
  .name { font-size: 12px; display: block; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: 11px; opacity: .6; display: block; }
  a, .link { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  a:hover, .link:hover { text-decoration: underline; }
  footer { margin-top: 20px; font-size: 11px; opacity: .6; }
</style></head>
<body>
  <header>
    <select id="source">
      <option value="pixabay">Pixabay — video</option>
      <option value="pexels">Pexels — video</option>
      <option value="wallhaven-anime">Wallhaven — anime</option>
      <option value="wallhaven">Wallhaven — everything</option>
      <option value="local">My library</option>
    </select>
    <input id="q" type="search" placeholder="Search… (e.g. neon, rain, lofi)">
    <button id="go">Search</button>
    <button id="browse" class="secondary">Choose file…</button>
    <button id="sites" class="secondary">Browse online…</button>
    <button id="folder" class="secondary">My library</button>
  </header>
  <div class="status" id="status"></div>
  <div class="grid" id="grid"></div>
  <footer id="credits"></footer>

<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const statusEl = document.getElementById('status');
  const qEl = document.getElementById('q');
  const sourceEl = document.getElementById('source');

  function search() {
    statusEl.textContent = 'Searching…';
    grid.replaceChildren();
    api.postMessage({ type: 'search', source: sourceEl.value, query: qEl.value });
  }

  document.getElementById('go').addEventListener('click', search);
  sourceEl.addEventListener('change', search);
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  document.getElementById('browse').addEventListener('click',
    () => api.postMessage({ type: 'browse' }));
  document.getElementById('sites').addEventListener('click',
    () => api.postMessage({ type: 'sites' }));
  document.getElementById('folder').addEventListener('click',
    () => api.postMessage({ type: 'folder' }));

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'status') { statusEl.textContent = msg.text; return; }
    if (msg.type !== 'results') return;

    statusEl.textContent = msg.items.length
      ? msg.items.length + ' results · ' + msg.note
      : 'No results. ' + msg.note;

    const credits = document.getElementById('credits');
    credits.textContent = msg.credit || '';

    grid.replaceChildren();
    for (const item of msg.items) {
      // A div rather than a button: the credit link lives inside, and an anchor nested in a
      // button is invalid and swallows its own clicks.
      const card = document.createElement('div');
      card.className = 'card' + (item.current ? ' selected' : '');
      card.tabIndex = 0;
      card.setAttribute('role', 'button');

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (item.preview && item.kind === 'video' && item.local) {
        // Plays on hover only. Autoplaying every tile meant a 60-file library decoded 60
        // videos at once, in the extension whose whole pitch is decode cost.
        const v = document.createElement('video');
        v.src = item.preview; v.muted = true; v.loop = true;
        v.preload = 'metadata'; v.setAttribute('playsinline', '');
        card.addEventListener('mouseenter', () => { v.play().catch(() => {}); });
        card.addEventListener('mouseleave', () => { v.pause(); });
        thumb.appendChild(v);
      } else if (item.preview) {
        const img = document.createElement('img');
        img.src = item.preview; img.loading = 'lazy';
        thumb.appendChild(img);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';

      // Pixabay and Pexels both require a visible credit linking back to the source page.
      function creditLink(text, url, cls) {
        const a = document.createElement('a');
        a.className = cls;
        a.href = url;
        a.textContent = text;
        a.title = url;
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();   // do not apply the wallpaper when following the credit
          api.postMessage({ type: 'open', url });
        });
        return a;
      }

      if (item.credit) {
        meta.appendChild(creditLink(item.name, item.credit, 'name link'));
      } else {
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = item.name;
        meta.appendChild(name);
      }

      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = item.sub;
      meta.appendChild(sub);

      if (item.source && item.sourceUrl) {
        const via = document.createElement('span');
        via.className = 'sub';
        via.append('via ', creditLink(item.source, item.sourceUrl, 'link'));
        meta.appendChild(via);
      }

      card.append(thumb, meta);

      const pick = () => {
        statusEl.textContent = item.local ? 'Applying…' : 'Downloading…';
        api.postMessage({ type: 'pick', item });
      };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); }
      });

      grid.appendChild(card);
    }
  });

  search();
</script>
</body></html>`;
}

/** One gallery at a time - running the command twice used to open a second, competing panel. */
let panel = null;
let registered = false;

function open(context, onPick) {
  const cfg = () => vscode.workspace.getConfiguration('livewall');
  const libraryDir = () => expandHome((cfg().get('library') || '').trim());

  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  // Scoped to the folders the gallery actually previews. It used to include the whole home
  // directory, which let the webview read any file the user owns.
  const roots = [context.globalStorageUri];
  const lib = libraryDir();
  if (lib) roots.push(vscode.Uri.file(lib));

  panel = vscode.window.createWebviewPanel(
    'livewall.gallery',
    'LiveWall',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots }
  );
  const self = panel;
  self.onDidDispose(() => { if (panel === self) panel = null; });
  // One disposable for the life of the extension. Pushing the panel itself on every open
  // grew `subscriptions` without bound, because dispose() never takes an entry back out.
  if (!registered) {
    registered = true;
    context.subscriptions.push({ dispose: () => { if (panel) panel.dispose(); } });
  }
  self.webview.html = renderHtml(self.webview);

  const post = (msg) => self.webview.postMessage(msg);
  const currentPath = () => expandHome((cfg().get('media') || cfg().get('video') || '').trim());

  /** Downloads land in the library when there is one, so shuffle can actually see them. */
  const downloadDir = () => {
    const dir = libraryDir();
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      } catch {}
    }
    return path.join(context.globalStorageUri.fsPath, 'wallpapers');
  };

  async function runSearch(source, query) {
    try {
      if (source === 'local') {
        const dir = (cfg().get('library') || '').trim();
        // The search box was rendered and enabled for this source but silently ignored.
        const needle = String(query || '').trim().toLowerCase();
        const items = scanLibrary(dir)
          .filter((f) => !needle || f.name.toLowerCase().includes(needle))
          .map((f) => ({
            name: f.name,
            sub: subOf(f.kind, f.bytes),
            kind: f.kind,
            local: true,
            localPath: f.path,
            preview: self.webview.asWebviewUri(vscode.Uri.file(f.path)).toString(),
            current: f.path === currentPath(),
          }));
        post({
          type: 'results',
          items,
          note: needle ? `matching "${needle}" in ${dir}` : (dir || 'set livewall.library to a folder'),
        });
        return;
      }

      const found = await sources.search(source, query, {
        cacheDir: path.join(context.globalStorageUri.fsPath, 'cache'),
        keys: {
          pexels: (cfg().get('pexelsApiKey') || '').trim(),
          pixabay: (cfg().get('pixabayApiKey') || '').trim(),
        },
      });

      post({
        type: 'results',
        note: source.startsWith('wallhaven')
          ? 'Wallhaven — still images'
          : 'video, downloaded when you pick it',
        credit: PROVIDERS[source] ? PROVIDERS[source].credit : '',
        items: found.map((r) => ({
          name: r.author || r.label,
          sub: r.author ? r.label : subOf(r.kind, r.bytes),
          kind: r.kind,
          local: false,
          preview: r.thumb,
          // Pixabay and Pexels both require the author to be credited with a link back to
          // the source page. `credit` is that page; `sourceUrl` credits the provider.
          credit: r.credit || '',
          source: r.source || '',
          sourceUrl: PROVIDERS[source] ? PROVIDERS[source].url : '',
          remote: r,
        })),
      });
    } catch (err) {
      const msg = String(err.message);
      if (msg === 'NO_KEY') {
        const isPexels = source === 'pexels';
        const name = isPexels ? 'Pexels' : 'Pixabay';
        const url = isPexels ? 'https://www.pexels.com/api/' : 'https://pixabay.com/api/docs/';
        const setting = isPexels ? 'pexelsApiKey' : 'pixabayApiKey';

        post({ type: 'status', text: `${name} needs an API key. It is free.` });
        const picked = await vscode.window.showWarningMessage(
          `LiveWall: ${name} video search needs a free API key.`,
          'Open website',
          'Enter key'
        );
        if (picked === 'Open website') {
          vscode.env.openExternal(vscode.Uri.parse(url));
        } else if (picked === 'Enter key') {
          const key = await vscode.window.showInputBox({
            prompt: `${name} API key`,
            password: true,
            ignoreFocusOut: true,
          });
          if (key) {
            await cfg().update(setting, key.trim(), vscode.ConfigurationTarget.Global);
            runSearch(source, query);
          }
        }
        return;
      }
      post({
        type: 'status',
        text: msg === 'BAD_KEY' ? 'That API key was rejected.'
          : msg === 'RATE_LIMIT' ? 'Rate limit reached. Try again shortly.'
          : 'Error: ' + msg,
      });
    }
  }

  self.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'search') {
      runSearch(msg.source, msg.query);
      return;
    }

    if (msg.type === 'open') {
      // Only ever follow http(s): the webview posts these, but treat them as untrusted.
      const url = String(msg.url || '');
      if (/^https?:\/\//.test(url)) vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }

    if (msg.type === 'sites') {
      const sites = cfg().get('downloadSites') || [];
      const chosen = await vscode.window.showQuickPick(
        sites.filter((s) => s && s.name && s.url).map((s) => ({ label: s.name, detail: s.url })),
        { placeHolder: 'Opens in your browser. Save into your library and it shows up here.' }
      );
      // Opened externally on purpose: webviews are sandboxed and cannot receive downloads.
      if (chosen) vscode.env.openExternal(vscode.Uri.parse(chosen.detail));
      return;
    }

    if (msg.type === 'folder') {
      const dir = libraryDir();
      if (!dir) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Use as library',
        });
        if (picked && picked[0]) {
          await cfg().update('library', picked[0].fsPath, vscode.ConfigurationTarget.Global);
          // The panel's resource roots are fixed at creation, so it has to come back to
          // preview files from a library that did not exist when it opened.
          post({ type: 'status', text: 'Library set. Reopen the gallery to preview it.' });
          vscode.env.openExternal(picked[0]);
        }
        return;
      }
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      vscode.env.openExternal(vscode.Uri.file(dir));
      return;
    }

    if (msg.type === 'browse') {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use as wallpaper',
        filters: { 'Video and images': [...VIDEO_EXT, ...IMAGE_EXT].map((e) => e.slice(1)) },
      });
      if (picked && picked[0]) await onPick(picked[0].fsPath);
      return;
    }

    if (msg.type !== 'pick') return;

    if (msg.item.local) {
      await onPick(msg.item.localPath);
      post({ type: 'status', text: 'Applied.' });
      return;
    }

    try {
      const file = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'LiveWall: downloading…' },
        (progress) => {
          let last = 0;
          return sources.download(msg.item.remote, downloadDir(), (ratio) => {
            progress.report({ increment: (ratio - last) * 100 });
            last = ratio;
          });
        }
      );
      await onPick(file);
      post({ type: 'status', text: 'Applied: ' + path.basename(file) });
    } catch (err) {
      post({ type: 'status', text: 'Download failed: ' + err.message });
    }
  });
}

module.exports = { open };
