export type TongueRoiCrop = Readonly<{ x: number; y: number; width: number; height: number }>;

export type TongueRoiImageData = Readonly<{ data: Uint8ClampedArray; width: number; height: number }>;

export type TongueRoiDetection = Readonly<{
  x: number;
  y: number;
  w: number;
  h: number;
  /** Relative heuristic score in (0, 1]; 0 when the conservative center fallback is used. */
  confidence: number;
  method: "detected" | "fallback-center";
}>;

/**
 * Conservative capture-guide ROI for the centered tongue workflow.
 *
 * The UI instructs the clinician to center the fully extended tongue. Removing the outer face and
 * room background before upload reduces incidental identifiers and gives the vision model more
 * tongue pixels, while retaining generous margins so tip/edges are not clipped. Image quality
 * validation remains responsible for rejecting a non-centered or incomplete capture.
 */
export function computeTongueRoiCrop(imageWidth: number, imageHeight: number): TongueRoiCrop {
  const width = Math.max(1, Math.round(imageWidth));
  const height = Math.max(1, Math.round(imageHeight));
  const marginX = width < 480 ? 0.06 : 0.11;
  const topMargin = height < 480 ? 0.06 : 0.12;
  const bottomMargin = height < 480 ? 0.04 : 0.07;
  const x = Math.round(width * marginX);
  const y = Math.round(height * topMargin);
  return {
    x,
    y,
    width: Math.max(1, width - x - Math.round(width * marginX)),
    height: Math.max(1, height - y - Math.round(height * bottomMargin)),
  };
}

// ─── Content-aware tongue ROI detection (classic CV heuristic) ────────────────
//
// This is a hand-tuned classical computer-vision heuristic — HSV reddish/pink tissue
// segmentation + largest connected component — NOT machine-learned segmentation. It is
// advisory only: the resulting crop is always shown to the doctor in the upload preview,
// and the doctor must visually confirm that tongue tip/edges/root are complete before the
// image is submitted. Whenever the heuristic cannot localize tissue with reasonable
// confidence (too little / too much candidate tissue, degenerate bbox, invalid input), it
// returns method "fallback-center" with the conservative computeTongueRoiCrop result.

/** Detection runs on a downscaled grid (max long side) to stay cheap on 12MP phone photos. */
const ROI_ANALYSIS_MAX_DIM = 256;
/**
 * Guided search region matching the on-screen capture guidance ("建议画面只保留口唇与舌体"):
 * the clinician centers the tongue and it extends downward, so we search the central,
 * slightly-lower band of the frame and ignore tissue-colored clutter near the borders.
 */
const ROI_GUIDED_REGION = { x0: 0.15, x1: 0.85, y0: 0.25, y1: 0.95 } as const;
/** Component area must be within [25%, 90%] of the guided region to be trusted. */
const ROI_MIN_AREA_RATIO = 0.25;
const ROI_MAX_AREA_RATIO = 0.9;
/** Degenerate-component guards on the downscaled grid. */
const ROI_MIN_COMPONENT_DIM = 6;
const ROI_MIN_ASPECT = 0.2;
const ROI_MAX_ASPECT = 5;
/** The detected bbox is expanded by this fraction on each side (≈30% total) before clamping. */
const ROI_EXPAND_RATIO = 0.15;
/** Reddish/pink tissue test (HSV): exclude dark pixels, neutral grays, and non-red hues. */
const ROI_MIN_VALUE = 0.25;
const ROI_MIN_SATURATION = 0.12;
/** Hue band in degrees, wrapping through 0 (red/pink). Skin tones (~20-35°) fall outside. */
const ROI_HUE_MIN = 330;
const ROI_HUE_MAX = 18;

function isProbableTongueTissue(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (max < 255 * ROI_MIN_VALUE || delta === 0) return false;
  if (delta / max < ROI_MIN_SATURATION) return false;
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  return hue >= ROI_HUE_MIN || hue <= ROI_HUE_MAX;
}

function downscaleRgbaForAnalysis(image: TongueRoiImageData): { pixels: Uint8ClampedArray; width: number; height: number; scale: number } {
  const { data, width, height } = image;
  const scale = Math.min(1, ROI_ANALYSIS_MAX_DIM / Math.max(width, height));
  if (scale === 1) return { pixels: data as Uint8ClampedArray, width, height, scale };
  const sw = Math.max(1, Math.round(width * scale));
  const sh = Math.max(1, Math.round(height * scale));
  const pixels = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < sw; x++) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const src = (srcY * width + srcX) * 4;
      const dst = (y * sw + x) * 4;
      pixels[dst] = data[src];
      pixels[dst + 1] = data[src + 1];
      pixels[dst + 2] = data[src + 2];
      pixels[dst + 3] = data[src + 3];
    }
  }
  return { pixels, width: sw, height: sh, scale };
}

function fallbackTongueRoiDetection(width: number, height: number): TongueRoiDetection {
  const crop = computeTongueRoiCrop(width, height);
  return { x: crop.x, y: crop.y, w: crop.width, h: crop.height, confidence: 0, method: "fallback-center" };
}

/**
 * Detect the probable tongue/lip region in an RGBA pixel buffer (e.g. canvas ImageData) and
 * return a crop rectangle in the INPUT image's coordinate space. Pure and dependency-free;
 * never throws — any problem yields the conservative "fallback-center" crop instead.
 */
export function detectTongueRoi(imageData: TongueRoiImageData): TongueRoiDetection {
  const inputWidth = Math.round(imageData?.width ?? 0);
  const inputHeight = Math.round(imageData?.height ?? 0);
  const fallback = () => fallbackTongueRoiDetection(inputWidth || 1, inputHeight || 1);
  try {
    if (!imageData || !(imageData.data instanceof Uint8ClampedArray)) return fallback();
    if (inputWidth < 8 || inputHeight < 8) return fallback();
    if (imageData.data.length < inputWidth * inputHeight * 4) return fallback();

    const { pixels, width, height, scale } = downscaleRgbaForAnalysis(imageData);
    const gx0 = Math.max(0, Math.floor(width * ROI_GUIDED_REGION.x0));
    const gx1 = Math.min(width, Math.ceil(width * ROI_GUIDED_REGION.x1));
    const gy0 = Math.max(0, Math.floor(height * ROI_GUIDED_REGION.y0));
    const gy1 = Math.min(height, Math.ceil(height * ROI_GUIDED_REGION.y1));
    const guidedArea = (gx1 - gx0) * (gy1 - gy0);
    if (guidedArea <= 0) return fallback();

    // Segment candidate tissue pixels inside the guided region only.
    const mask = new Uint8Array(width * height);
    for (let y = gy0; y < gy1; y++) {
      for (let x = gx0; x < gx1; x++) {
        const i = (y * width + x) * 4;
        if (isProbableTongueTissue(pixels[i], pixels[i + 1], pixels[i + 2])) mask[y * width + x] = 1;
      }
    }

    // Largest 4-connected component via iterative flood fill.
    const visited = new Uint8Array(width * height);
    const stack = new Int32Array(width * height);
    let bestArea = 0;
    let bestMinX = 0;
    let bestMinY = 0;
    let bestMaxX = -1;
    let bestMaxY = -1;
    for (let sy = gy0; sy < gy1; sy++) {
      for (let sx = gx0; sx < gx1; sx++) {
        const start = sy * width + sx;
        if (!mask[start] || visited[start]) continue;
        let sp = 0;
        stack[sp++] = start;
        visited[start] = 1;
        let area = 0;
        let minX = sx;
        let minY = sy;
        let maxX = sx;
        let maxY = sy;
        while (sp > 0) {
          const idx = stack[--sp];
          const x = idx % width;
          const y = (idx - x) / width;
          area++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (x + 1 < width && mask[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; stack[sp++] = idx + 1; }
          if (x - 1 >= 0 && mask[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; stack[sp++] = idx - 1; }
          if (y + 1 < height && mask[idx + width] && !visited[idx + width]) { visited[idx + width] = 1; stack[sp++] = idx + width; }
          if (y - 1 >= 0 && mask[idx - width] && !visited[idx - width]) { visited[idx - width] = 1; stack[sp++] = idx - width; }
        }
        if (area > bestArea) {
          bestArea = area;
          bestMinX = minX;
          bestMinY = minY;
          bestMaxX = maxX;
          bestMaxY = maxY;
        }
      }
    }

    if (bestArea === 0) return fallback();
    const areaRatio = bestArea / guidedArea;
    if (areaRatio < ROI_MIN_AREA_RATIO || areaRatio > ROI_MAX_AREA_RATIO) return fallback();
    const bboxW = bestMaxX - bestMinX + 1;
    const bboxH = bestMaxY - bestMinY + 1;
    if (bboxW < ROI_MIN_COMPONENT_DIM || bboxH < ROI_MIN_COMPONENT_DIM) return fallback();
    const aspect = bboxW / bboxH;
    if (aspect < ROI_MIN_ASPECT || aspect > ROI_MAX_ASPECT) return fallback();

    // Expand ~30% total (15% per side) so tongue tip/edges keep context, then clamp.
    const padX = Math.round(bboxW * ROI_EXPAND_RATIO);
    const padY = Math.round(bboxH * ROI_EXPAND_RATIO);
    const cropX0 = Math.max(0, bestMinX - padX);
    const cropY0 = Math.max(0, bestMinY - padY);
    const cropW = Math.min(width, bestMaxX + padX + 1) - cropX0;
    const cropH = Math.min(height, bestMaxY + padY + 1) - cropY0;

    // Map back to the input image's coordinate space.
    const inv = 1 / scale;
    const x = Math.min(Math.max(0, Math.round(cropX0 * inv)), inputWidth - 1);
    const y = Math.min(Math.max(0, Math.round(cropY0 * inv)), inputHeight - 1);
    const w = Math.min(Math.max(1, Math.round(cropW * inv)), inputWidth - x);
    const h = Math.min(Math.max(1, Math.round(cropH * inv)), inputHeight - y);
    // Heuristic score: peaks when the component fills about half of the guided region.
    const confidence = Math.round((1 - Math.min(1, Math.abs(areaRatio - 0.5) * 2)) * 1000) / 1000;
    return { x, y, w, h, confidence, method: "detected" };
  } catch {
    return fallback();
  }
}
