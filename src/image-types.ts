/**
 * The raster images a checkout's file is shown and served as, by extension. Other files that browsers draw, such as
 * HTML or SVG, would run as a page of the API's own origin, which the dashboard shares.
 */
export const imageTypes: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** The content type of the image at `path`, by the extension it ends with in any case, or undefined for any other file. */
export function imageType(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? imageTypes[path.slice(dot).toLowerCase()] : undefined;
}

export const isImage = (path: string) => imageType(path) !== undefined;
