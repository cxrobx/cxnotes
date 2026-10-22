'use strict';

/** Native login-item registration, with Electron and the store injected. */
class StartupLaunch {
  constructor({ app, store, platform = process.platform }) {
    this.app = app;
    this.store = store;
    // A development checkout would register Electron itself, not CXNotes.
    this.available = platform === 'darwin' && app.isPackaged;
  }

  getSettings() {
    if (!this.available) {
      return {
        launchAtStartup: false,
        launchAtStartupAvailable: false,
        launchAtStartupStatus: 'unavailable',
        launchAtStartupError: 'Launch on startup is available in the installed macOS app.'
      };
    }

    try {
      const item = this.app.getLoginItemSettings();
      return {
        // A checked switch with a pending message represents a registration
        // waiting for macOS approval, rather than claiming it will launch yet.
        launchAtStartup: item.openAtLogin === true || item.status === 'requires-approval',
        launchAtStartupAvailable: true,
        launchAtStartupStatus: item.status || (item.openAtLogin ? 'enabled' : 'not-registered'),
        launchAtStartupError: ''
      };
    } catch (err) {
      return {
        launchAtStartup: false,
        launchAtStartupAvailable: false,
        launchAtStartupStatus: 'error',
        launchAtStartupError: `Could not read startup settings: ${err.message}`
      };
    }
  }

  initialise() {
    const state = this.getSettings();
    if (state.launchAtStartupStatus === 'error') throw new Error(state.launchAtStartupError);
    if (!this.available || this.store.get('launchAtStartupInitialised') === true) return state;

    // Apply the default once. Subsequent launches read the OS state without
    // re-registering an item the user has disabled in System Settings.
    if (state.launchAtStartup) {
      this.remember(state.launchAtStartup);
      return state;
    }
    return this.setEnabled(this.store.get('launchAtStartup') === true);
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Launch on startup must be a boolean.');
    const current = this.getSettings();
    if (!current.launchAtStartupAvailable) throw new Error(current.launchAtStartupError);

    if (current.launchAtStartup !== enabled) {
      this.app.setLoginItemSettings({ openAtLogin: enabled });
    }
    const state = this.getSettings();
    if (!state.launchAtStartupAvailable) throw new Error(state.launchAtStartupError);
    if (state.launchAtStartup !== enabled) {
      throw new Error('macOS did not update launch on startup. Check System Settings > General > Login Items.');
    }

    // Only persist a preference after verifying the native registration.
    this.remember(enabled);
    return state;
  }

  remember(enabled) {
    this.store.set('launchAtStartup', enabled);
    this.store.set('launchAtStartupInitialised', true);
  }
}

module.exports = { StartupLaunch };
