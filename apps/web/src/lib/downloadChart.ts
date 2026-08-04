/**
 * Save a chart as a PNG, with nothing but the DOM: find the chart's inline SVG,
 * serialize it, paint it onto a canvas at 2× the device pixel ratio over the
 * app's background, and hand the blob to an anchor.
 *
 * The pieces are separated so the parts that can be tested (finding the SVG,
 * serializing it, naming the file) are pure DOM work, and the part that cannot
 * (canvas rasterizing, which jsdom has no implementation for) sits behind a
 * capability check that simply reports failure instead of throwing.
 */

import { FALLBACK_CHART_COLORS, readToken } from "./chartColors.js";
import { saveBlob } from "./files.js";

/** The page ground of the theme on screen; the exported PNG should look like
 *  the app it came from, not like a transparent cut-out that turns black in a
 *  chat client. Read per export, so a light-theme chart exports light. */
const appBackground = (): string => readToken("--ground", FALLBACK_CHART_COLORS.ground);
/** Retina-ish export regardless of the screen it was rendered on. */
const PIXEL_SCALE = 2;
const FALLBACK_SIZE = { width: 900, height: 420 };
const FONT_STACK =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

/** The chart's SVG inside a container, or null when nothing has rendered yet
 *  (a lazy chunk still loading, an empty-state message in its place). */
export function findChartSvg(container: Element | null | undefined): SVGSVGElement | null {
  if (!container) return null;
  return container.querySelector("svg");
}

/** On-screen size of a chart SVG, from its attributes or its box. Charts are
 *  laid out by a ResponsiveContainer, so the attributes are usually set. */
export function chartSize(svg: SVGSVGElement): { width: number; height: number } {
  const attrWidth = Number(svg.getAttribute("width"));
  const attrHeight = Number(svg.getAttribute("height"));
  if (attrWidth > 0 && attrHeight > 0) return { width: attrWidth, height: attrHeight };
  const box = svg.getBoundingClientRect?.();
  if (box && box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  return FALLBACK_SIZE;
}

/**
 * A standalone SVG document string. The clone gets the namespace, an explicit
 * size and a viewBox (a serialized fragment has none of them by default), plus
 * the app's font stack — the copy has no stylesheet to inherit from, so without
 * it every label would fall back to the browser's default serif.
 */
export function serializeChartSvg(svg: SVGSVGElement): string {
  const { width, height } = chartSize(svg);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.setAttribute("font-family", FONT_STACK);
  return new XMLSerializer().serializeToString(clone);
}

/** "money flow" → "money-flow.png". Never trusts the caller's spacing/casing. */
export function chartFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "chart"}.png`;
}

/** Whether this environment can rasterize at all. jsdom cannot, so tests (and
 *  any browser without canvas) get a quiet "no" rather than an exception. */
export function canExportChart(): boolean {
  try {
    if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") return false;
    if (typeof Image === "undefined" || typeof XMLSerializer === "undefined") return false;
    const canvas = document.createElement("canvas");
    return typeof canvas.toBlob === "function";
  } catch {
    return false;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("could not rasterize the chart"));
    image.src = src;
  });
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

/**
 * Download the chart inside `container` as "<name>.png". Resolves false when
 * there is nothing to export or the environment can't rasterize — callers use
 * it to stay quiet rather than to report an error.
 */
export async function downloadChartPng(
  container: Element | null | undefined,
  name: string,
  background = appBackground(),
): Promise<boolean> {
  const svg = findChartSvg(container);
  if (!svg || !canExportChart()) return false;

  const { width, height } = chartSize(svg);
  const markup = serializeChartSvg(svg);
  const svgUrl = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await loadImage(svgUrl);
    const scale = (window.devicePixelRatio || 1) * PIXEL_SCALE;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.scale(scale, scale);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await toBlob(canvas);
    if (!blob) return false;
    saveBlob(blob, chartFileName(name));
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
