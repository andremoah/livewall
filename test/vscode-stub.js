/**
 * A `vscode` module good enough to run extension.js outside the extension host.
 *
 * extension.js and gallery.js used to be syntax-checked and nothing more, because they
 * require('vscode') and that module only exists inside VS Code. Everything they hold -
 * activation, the settings pipeline, the debounce, the toggle, remove - was therefore
 * untested. This is the smallest stub that makes them require()-able and observable.
 */
const Module = require('node:module');

const state = {
  settings: {},
  appRoot: '',
  version: '1.99.0',
  themeKind: 2,        // Dark
  focused: true,
  info: [],            // showInformationMessage texts
  warn: [],            // showWarningMessage texts
  executed: [],        // executeCommand ids
  commands: {},        // id -> handler
  configListeners: [],
  themeListeners: [],
  statusBar: null,
};

function reset(over = {}) {
  state.settings = Object.assign({}, over.settings);
  state.appRoot = over.appRoot || '';
  state.themeKind = over.themeKind === undefined ? 2 : over.themeKind;
  state.focused = over.focused !== false;
  state.info = [];
  state.warn = [];
  state.executed = [];
  state.commands = {};
  state.configListeners = [];
  state.themeListeners = [];
  state.statusBar = null;
}

const disposable = () => ({ dispose() {} });

/** Fires onDidChangeConfiguration for the given short keys, e.g. ['opacity']. */
function fireConfig(keys) {
  const e = {
    affectsConfiguration: (section) =>
      keys.some((k) => section === 'livewall.' + k || section === 'livewall'),
  };
  for (const fn of state.configListeners.slice()) fn(e);
}

function fireTheme(kind) {
  state.themeKind = kind;
  for (const fn of state.themeListeners.slice()) fn({ kind });
}

const vscode = {
  get version() { return state.version; },

  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },

  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }),
    parse: (s) => ({ toString: () => s }),
  },

  env: {
    get appRoot() { return state.appRoot; },
    openExternal: () => Promise.resolve(true),
  },

  commands: {
    registerCommand(id, fn) {
      state.commands[id] = fn;
      return disposable();
    },
    executeCommand(id) {
      state.executed.push(id);
      return Promise.resolve();
    },
  },

  workspace: {
    getConfiguration() {
      return {
        get: (k) => state.settings[k],
        update: (k, v) => {
          state.settings[k] = v;
          // The real thing notifies asynchronously; doing it inline keeps tests linear.
          fireConfig([k]);
          return Promise.resolve();
        },
      };
    },
    onDidChangeConfiguration(fn) {
      state.configListeners.push(fn);
      return disposable();
    },
  },

  window: {
    get state() { return { focused: state.focused }; },
    get activeColorTheme() { return { kind: state.themeKind }; },
    onDidChangeActiveColorTheme(fn) {
      state.themeListeners.push(fn);
      return disposable();
    },
    createStatusBarItem() {
      state.statusBar = { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
      return state.statusBar;
    },
    showInformationMessage(text) {
      state.info.push(text);
      return Promise.resolve(undefined);
    },
    showWarningMessage(text) {
      state.warn.push(text);
      return Promise.resolve(undefined);
    },
    showErrorMessage(text) {
      state.warn.push(text);
      return Promise.resolve(undefined);
    },
    createWebviewPanel() {
      throw new Error('gallery is not exercised by the stub');
    },
  },
};

/** Must run before anything require()s a module that require()s vscode. */
function install() {
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return load.apply(this, arguments);
  };
}

module.exports = { install, reset, state, fireConfig, fireTheme, vscode };
