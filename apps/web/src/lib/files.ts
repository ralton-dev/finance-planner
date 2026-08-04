/**
 * Files in and out of the browser: hand bytes to the user as a download, read a
 * file they picked, and work out what to call the one being saved.
 *
 * `saveBlob` is deliberately the only place an object URL is minted and a
 * synthetic anchor is clicked. Neither is testable in jsdom, so keeping them
 * behind one function makes it the single seam a test stubs — while the parts
 * that *are* pure (parsing the server's filename) stay directly checkable.
 */

/** Hand `blob` to the browser as a download called `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * The filename out of a Content-Disposition header, or null when there is
 * nothing usable in it — callers fall back to a name of their own.
 *
 * Understands `filename="x.json"`, bare `filename=x.json`, and the RFC 5987
 * `filename*=UTF-8''x.json` form. Any directory part is stripped: a header is
 * server-controlled input, and it has no business steering where the file lands.
 */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;

  const extended = /filename\*\s*=\s*[\w-]+'[^']*'([^;]+)/i.exec(header);
  if (extended) return baseName(decodeSafely(extended[1].trim()));

  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header);
  if (quoted) return baseName(quoted[1]);

  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare) return baseName(bare[1].trim());

  return null;
}

/** A picked file's contents as text.
 *
 *  FileReader rather than `file.text()`: Blob#text is missing in jsdom, so the
 *  tidier promise API would make every import path untestable. */
export function readTextFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsText(file);
  });
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function baseName(name: string): string | null {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return base.length > 0 ? base : null;
}
