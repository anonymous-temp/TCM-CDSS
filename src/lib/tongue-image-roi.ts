export type TongueRoiCrop = Readonly<{ x: number; y: number; width: number; height: number }>;

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
