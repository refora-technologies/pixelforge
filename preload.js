'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pixelforge', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // Setup
  checkSetup: () => ipcRenderer.invoke('check-setup'),
  downloadDeps: (opts) => ipcRenderer.invoke('download-deps', opts),
  onDownloadProgress: (cb) => {
    ipcRenderer.on('download-progress', (event, data) => cb(data));
  },

  // Folder operations
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
  scanImages: (folderPath) => ipcRenderer.invoke('scan-images', folderPath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  // Pipeline
  startPipeline: (args) => ipcRenderer.invoke('start-pipeline', args),
  cancelPipeline: () => ipcRenderer.invoke('cancel-pipeline'),
  onPipelineProgress: (cb) => {
    ipcRenderer.on('pipeline-progress', (event, data) => cb(data));
  },
  onPipelineDone: (cb) => {
    ipcRenderer.on('pipeline-done', (event, data) => cb(data));
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Paths
  getAppPaths: () => ipcRenderer.invoke('get-app-paths'),

  // Models
  listModels: () => ipcRenderer.invoke('list-models'),
  listGpus:   () => ipcRenderer.invoke('list-gpus'),

  // Utils
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
