const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

app.name = 'Termly';

function isPrivateNetworkHost(hostname = '') {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// A standard Termly desktop build can be pointed at a school's LAN server
// without rebuilding the installer. The optional file lives in Electron's
// per-user application data directory and contains no credentials.
function resolveSchoolServerUrl() {
  let config = {};
  try {
    const configPath = path.join(app.getPath('userData'), 'termly-desktop.json');
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (error) {
    console.warn('[TERMly] Could not read desktop server configuration:', error.message);
  }

  const rawUrl = process.env.TERMLY_SERVER_URL || config.serverUrl || '';
  const allowInsecureLan = process.env.TERMLY_ALLOW_INSECURE_LAN === 'true' || config.allowInsecureLan === true;
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('URL credentials, query strings and fragments are not allowed.');
    if (parsed.protocol === 'https:') return parsed.toString();
    if (parsed.protocol === 'http:' && allowInsecureLan && isPrivateNetworkHost(parsed.hostname)) {
      console.warn('[TERMly] Using HTTP on a private LAN. HTTPS is strongly recommended.');
      return parsed.toString();
    }
    throw new Error('Use HTTPS. HTTP is allowed only when explicitly enabled for a private school LAN host.');
  } catch (error) {
    console.warn('[TERMly] Ignoring invalid school server URL:', error.message);
    return null;
  }
}

// Prevent multiple instances from conflicting on cache/database locks
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  let mainWindow;

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1366,
      height: 868,
      minWidth: 1024,
      minHeight: 700,
      title: 'Termly - School Management System',
      icon: path.join(__dirname, '../public/assets/pwa-512x512.png'),
      backgroundColor: '#0C0E0D',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    mainWindow.setMenuBarVisibility(false);

    const isDev = process.env.NODE_ENV === 'development';
    const schoolServerUrl = resolveSchoolServerUrl();
    if (schoolServerUrl) {
      mainWindow.loadURL(schoolServerUrl);
    } else if (isDev) {
      mainWindow.loadURL('http://localhost:5173');
    } else {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http:') || url.startsWith('https:')) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  const { autoUpdater } = require('electron-updater');

  app.whenReady().then(() => {
    createWindow();

    // Auto-updates remain available for the ordinary packaged cloud client.
    // School-hosted customers should coordinate client/server version upgrades.
    if (app.isPackaged && !resolveSchoolServerUrl()) {
      try {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
        autoUpdater.on('update-available', () => console.log('Update available.'));
        autoUpdater.on('update-downloaded', () => {
          console.log('Update downloaded. Quitting and installing...');
          autoUpdater.quitAndInstall();
        });
        autoUpdater.on('error', (err) => console.warn('Auto updater initialization error:', err?.message));
      } catch (err) {
        console.warn('Auto updater initialization error:', err);
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
