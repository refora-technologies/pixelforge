# PixelForge

> AI-powered batch image upscaling and compression for Windows — free, offline, private.

![Windows](https://img.shields.io/badge/Windows-10%2F11-blue?logo=windows)
![License](https://img.shields.io/badge/license-MIT-green)
[![Release](https://img.shields.io/github/v/release/refora-technologies/pixelforge)](https://github.com/refora-technologies/pixelforge/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/refora-technologies/pixelforge/total)](https://github.com/refora-technologies/pixelforge/releases)

**[🌐 Website](https://pixelforge.reforatech.com)** &nbsp;·&nbsp; **[⬇️ Download](https://github.com/refora-technologies/pixelforge/releases/latest)**

---

## What is PixelForge?

PixelForge is a Windows desktop app that automates a two-stage image enhancement pipeline:

1. **AI Upscaling** — Upscale images up to 4× using 7 bundled AI models, powered by [upscayl-ncnn](https://github.com/upscayl/upscayl-ncnn)
2. **Smart Compression** — Compress the upscaled output using [caesium-clt](https://github.com/Lymphatus/caesium-clt) without visible quality loss

All processing is 100% local — no cloud, no accounts, no internet required after installation.

---

## ✨ Features

- **7 bundled AI models** — no internet download needed, all included in the installer
- **GPU-accelerated** — Vulkan-powered inference via upscayl-ncnn (NVIDIA, AMD, Intel)
- **Real-time per-image progress** — exact counters ("Upscaled 34 of 104")
- **Batch processing** — process hundreds of images in one run
- **Smart compression** — reduces file size after upscaling via caesium-clt
- **Clean cancellation** — stop mid-batch safely between images
- **100% offline & private** — zero telemetry, zero cloud, zero accounts

## 📥 Download

👉 **[Download PixelForge-Setup-1.0.0.exe](https://github.com/refora-technologies/pixelforge/releases/latest)**

- Windows 10 / 11 (64-bit)
- ~230 MB (includes all 7 AI models)
- No Upscayl installation required

---

## 🤖 AI Models Included

| Model | Optimized For |
|---|---|
| Upscayl Standard 4× | General photography |
| Upscayl Lite 4× | Fast processing, lower VRAM |
| Ultra Sharp 4× | Maximum sharpness |
| Remacri 4× | Real-world photos |
| UltraMix Balanced 4× | Balanced output |
| Digital Art 4× | Illustrations & art |
| High Fidelity 4× | High-detail preservation |

---

## 🧱 Open Source Stack

PixelForge is a smart automation layer built on outstanding open-source tools:

| Tool | License | Purpose |
|---|---|---|
| [upscayl-ncnn](https://github.com/upscayl/upscayl-ncnn) | AGPL-3.0 | AI upscaling engine (Vulkan/NCNN) |
| [upscayl-custom-models](https://github.com/upscayl/upscayl-custom-models) | MIT | 7 trained AI model weights |
| [caesium-clt](https://github.com/Lymphatus/caesium-clt) | GPL-3.0 | Image compression CLI |
| [Electron](https://github.com/electron/electron) | MIT | Desktop application framework |
| [electron-store](https://github.com/sindresorhus/electron-store) | MIT | Persistent settings storage |
| [extract-zip](https://github.com/maxogden/extract-zip) | BSD-2 | ZIP extraction for dependency setup |

Full attribution and license texts are included in every installation via the EULA screen.

---

## 🔧 Building from Source

```bash
git clone https://github.com/refora-technologies/pixelforge.git
cd pixelforge
npm install
```

> ⚠️ **Note:** `src/models/` is not included in the repo (files are ~180 MB, too large for GitHub).
> To run in development, copy your AI model files (`.param` + `.bin`) into `src/models/`.
> Models can be found at [upscayl-custom-models](https://github.com/upscayl/upscayl-custom-models/tree/main/models).

```bash
# Run in development mode
npm start

# Build Windows installer (requires model files in src/models/)
npm run build
```

---

## 📄 License

MIT © 2026 [Refora Technologies](https://reforatech.com)

This project is MIT licensed. Third-party binaries (upscayl-ncnn, caesium-clt) are distributed
under their respective licenses (AGPL-3.0 and GPL-3.0). See [LICENSE](LICENSE) and the
[EULA](build/license.txt) for full attribution.

---

<div align="center">
  <sub>A product of <a href="https://reforatech.com">Refora Technologies</a> &nbsp;·&nbsp; <a href="https://pixelforge.reforatech.com">pixelforge.reforatech.com</a></sub>
</div>
