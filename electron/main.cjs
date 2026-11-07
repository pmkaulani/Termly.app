const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

app.name = 'Termly';

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

    // Hide default menu bar for clean app UI
    mainWindow.setMenuBarVisibility(false);

    const isDev = process.env.NODE_ENV === 'development';
    if (isDev) {
      mainWindow.loadURL('http://localhost:5173');
    } else {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // Handle external link clicks
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http:') || url.startsWith('https:')) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
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

    if (app.isPackaged) {
      // Initialize auto updater only in packaged builds
      try {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
        autoUpdater.on('update-available', () => {
          console.log('Update available.');
        });
        autoUpdater.on('update-downloaded', () => {
          console.log('Update downloaded. Quitting and installing...');
          autoUpdater.quitAndInstall();
        });
        autoUpdater.on('error', (err) => {
          console.warn('Update check failed:', err?.message);
        });
      } catch (err) {
        console.warn('Auto updater initialization error:', err);
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
