'use strict';

// How many bytes a run will write, from each image's dimensions and the
// settings. Pure, so it can be tested without Electron. The figures are
// deliberately on the high side: a false "may not fit" costs one click, a
// missed one costs the run.

// Bytes per pixel, about twice what upscayl-bin and caesiumclt produced on
// sample photos (real, noisier photos run heavier). upscayl's WebP is
// near-lossless, hence its size.
const UPSCALED_BPP = { png: 1.8, jpg: 0.8, webp: 1.3 };
// A lossy re-encode by caesium at `quality` (0–100).
const lossyBpp = (format, quality) => {
  const q = Math.max(0, Math.min(100, quality)) / 100;
  if (format === 'png') return 0.15 + 0.4 * q * q; // quantised PNG
  const jpeg = 0.02 + 0.15 * q * q * q;
  return format === 'webp' ? jpeg * 0.75 : jpeg;
};
// Only when a header can't be read: guess the pixels from the file size,
// erring towards more pixels.
const guessPixels = (size, ext) => size / (/bmp|tiff?/i.test(ext) ? 2.5 : /png/i.test(ext) ? 0.8 : 0.1);

const extFormat = (ext) => {
  const e = String(ext || '').replace(/^\./, '').toLowerCase();
  return e === 'jpeg' ? 'jpg' : e === 'tif' ? 'tiff' : e;
};

// items: [{ size, ext, width?, height? }] → estimated bytes written per stage.
function estimateOutput(items, s) {
  const mode = ['both', 'upscale', 'compress'].includes(s.pipelineMode) ? s.pipelineMode : 'both';
  const scale = Number(s.upscaylScale) || 4;
  const upFormat = UPSCALED_BPP[s.upscaylFormat] ? s.upscaylFormat : 'png';
  const quality = Number.isFinite(Number(s.caesiumQuality)) ? Number(s.caesiumQuality) : 82;
  let upscaled = 0, compressed = 0;

  for (const it of items) {
    const pixels = it.width && it.height ? it.width * it.height : guessPixels(it.size || 0, it.ext);
    let px = pixels, source = it.size || 0, format = extFormat(it.ext);

    if (mode !== 'compress') {
      px = pixels * scale * scale;
      source = px * UPSCALED_BPP[upFormat];
      format = upFormat;
      upscaled += source;
    }
    if (mode !== 'upscale') {
      const target = s.caesiumFormat && s.caesiumFormat !== 'same' ? extFormat(s.caesiumFormat) : format;
      if (s.caesiumLossless) {
        // Lossless keeps the size in the same format; into PNG it's a full-size PNG.
        compressed += target === format ? source : px * (target === 'png' ? UPSCALED_BPP.png : 1);
      } else {
        // Caesium rarely grows a file, so the source size is a ceiling.
        compressed += Math.min(source || Infinity, px * lossyBpp(target, quality));
      }
    }
  }
  return { upscaled: Math.round(upscaled), compressed: Math.round(compressed) };
}

module.exports = { estimateOutput };
