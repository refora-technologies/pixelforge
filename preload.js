'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pixelforge', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizedChanged: (cb) => ipcRenderer.on('window-maximized-changed', (e, v) => cb(v)),

  // Setup
  checkSetup: () => ipcRenderer.invoke('check-setup'),
  downloadDeps: (opts) => ipcRenderer.invoke('download-deps', opts),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, data) => cb(data)),

  // Folder / file operations
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFolders: () => ipcRenderer.invoke('select-folders'),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
  selectImages: () => ipcRenderer.invoke('select-images'),
  scanInputs: (inputs, recursive) => ipcRenderer.invoke('scan-inputs', inputs, recursive),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  openLogs: () => ipcRenderer.invoke('open-logs'),

  // Pipeline
  startPipeline: (args) => ipcRenderer.invoke('start-pipeline', args),
  cancelPipeline: () => ipcRenderer.invoke('cancel-pipeline'),
  pausePipeline: () => ipcRenderer.invoke('pause-pipeline'),
  resumePipeline: () => ipcRenderer.invoke('resume-pipeline'),
  onPipelineProgress: (cb) => ipcRenderer.on('pipeline-progress', (e, data) => cb(data)),
  onPipelineDone: (cb) => ipcRenderer.on('pipeline-done', (e, data) => cb(data)),

  // Settings & paths
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getAppPaths: () => ipcRenderer.invoke('get-app-paths'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Models & GPUs
  listModels: () => ipcRenderer.invoke('list-models'),
  listGpus: () => ipcRenderer.invoke('list-gpus'),

  // Updates
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  downloadUpdate: (args) => ipcRenderer.invoke('download-update', args),
  runInstaller: (path) => ipcRenderer.invoke('run-installer', path),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, data) => cb(data)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (e, data) => cb(data)),

  // Utils
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
