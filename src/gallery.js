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
  return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderHtml(webview) {
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `media-src ${webview.cspSource} https:`,
    `style-src 'unsafe-inline'`,
    `script-src 'unsafe-inline'`,
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
      <option value="wallhaven">Wallhaven — tudo</option>
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

<script>
  const api = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const statusEl = document.getElementById('status');
  const qEl = document.getElementById('q');
  const sourceEl = document.getElementById('source');

  function search() {
    statusEl.textContent = 'A pesquisar…';
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
        const v = document.createElement('video');
        v.src = item.preview; v.muted = true; v.loop = true;
        v.autoplay = true; v.setAttribute('playsinline', '');
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
        statusEl.textContent = 'Downloading…';
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

function open(context, onPick) {
  const cfg = () => vscode.workspace.getConfiguration('livewall');
  const downloadDir = path.join(context.globalStorageUri.fsPath, 'wallpapers');

  const panel = vscode.window.createWebviewPanel(
    'livewall.gallery',
    'LiveWall',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.globalStorageUri, vscode.Uri.file(require('node:os').homedir())],
    }
  );
  context.subscriptions.push(panel);
  panel.webview.html = renderHtml(panel.webview);

  const post = (msg) => panel.webview.postMessage(msg);
  const currentPath = () => expandHome((cfg().get('media') || cfg().get('video') || '').trim());

  async function runSearch(source, query) {
    try {
      if (source === 'local') {
        const dir = (cfg().get('library') || '').trim();
        const items = scanLibrary(dir).map((f) => ({
          name: f.name,
          sub: `${f.kind} · ${humanSize(f.bytes)}`,
          kind: f.kind,
          local: true,
          localPath: f.path,
          preview: panel.webview.asWebviewUri(vscode.Uri.file(f.path)).toString(),
          current: f.path === currentPath(),
        }));
        post({ type: 'results', items, note: dir || 'set livewall.library to a folder' });
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
          : `${found[0] ? found[0].source : ''} — video, downloaded when you pick it`,
        credit: PROVIDERS[source] ? PROVIDERS[source].credit : '',
        items: found.map((r) => ({
          name: r.author || r.label,
          sub: r.author ? r.label : `${r.kind} · ${humanSize(r.bytes)}`,
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

  panel.webview.onDidReceiveMessage(async (msg) => {
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
      const dir = expandHome((cfg().get('library') || '').trim());
      if (!dir) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Use as library',
        });
        if (picked && picked[0]) {
          await cfg().update('library', picked[0].fsPath, vscode.ConfigurationTarget.Global);
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
          return sources.download(msg.item.remote, downloadDir, (ratio) => {
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
