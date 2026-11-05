export const SVG_FONT = "ui-sans-serif,system-ui,sans-serif";
export type MeasureText = (
  text: string,
  size: number,
  weight: number,
) => number;
// Deterministic conservative metrics for non-browser rendering and injected test metrics.
export const fallbackMeasure: MeasureText = (text, size) =>
  Array.from(text).length * size * 0.7;
export function browserMeasure(): MeasureText {
  if (typeof CanvasRenderingContext2D === "undefined") return fallbackMeasure;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return fallbackMeasure;
  return (text, size, weight) => {
    context.font = `${weight} ${size}px ${SVG_FONT}`;
    return context.measureText(text).width;
  };
}
export function wrapText(
  text: string,
  width: number,
  measure: MeasureText,
  size = 13,
  weight = 650,
): string[] {
  const lines: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.match(/\S+/gu) || []) {
      if (line && measure(`${line} ${word}`, size, weight) <= width) {
        line += ` ${word}`;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      for (const { segment } of segmenter.segment(word)) {
        if (line && measure(line + segment, size, weight) > width) {
          lines.push(line);
          line = "";
        }
        line += segment;
      }
    }
    lines.push(line);
  }
  return lines;
}
