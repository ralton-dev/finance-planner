/**
 * Named diagram scopes, so a picture worth looking at twice does not have to be
 * assembled by hand every visit.
 *
 * A scope *is* its URL: which accounts, and which of them are hidden, both
 * travel in the query string, so any scope can be bookmarked, shared and
 * reopened without this file existing. What this adds is a name and a list —
 * "the flat", "everything but the joint account" — kept where the app already
 * keeps how it is being looked at (see `ThemeContext`, `PrivacyContext`).
 *
 * **Deliberately per browser, not per account.** A scope changes no figure: it
 * decides what is drawn and what is hidden, which is a way of looking rather
 * than a fact about anyone's money. It is stored beside the theme for the same
 * reason the theme is. The consequence is honest and worth stating: these do not
 * follow you to another device, and a scope you want to keep is one to bookmark.
 */

export const SCOPES_STORAGE_KEY = "fp:flow-scopes";
/** Enough for a working set. A list nobody can find their way down is not a
 *  shortcut, and this is a convenience, not an archive. */
export const MAX_SAVED_SCOPES = 20;

export interface SavedScope {
  /** What the user calls it. Unique among saved scopes — saving over a name
   *  replaces it, which is what "save" means when the name is the handle. */
  name: string;
  /** The accounts the diagram is computed over. */
  accountIds: string[];
  /** Of those, the ones left out of the picture. Presentation only, and stored
   *  because "hide the noisy one" is exactly the thing worth not redoing. */
  hiddenAccountIds: string[];
}

/** Whatever is stored, defensively: a hand-edited or half-written value must
 *  cost the page nothing more than an empty list. */
export function readScopes(): SavedScope[] {
  try {
    const raw = localStorage.getItem(SCOPES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isScope).slice(0, MAX_SAVED_SCOPES);
  } catch {
    // No storage (private-mode Safari), or nothing that parses. Either way the
    // diagram still works; it just has nothing saved.
    return [];
  }
}

function isScope(value: unknown): value is SavedScope {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<SavedScope>;
  return (
    typeof s.name === "string" &&
    s.name.length > 0 &&
    Array.isArray(s.accountIds) &&
    s.accountIds.every((id) => typeof id === "string") &&
    Array.isArray(s.hiddenAccountIds) &&
    s.hiddenAccountIds.every((id) => typeof id === "string")
  );
}

function write(scopes: SavedScope[]): SavedScope[] {
  try {
    localStorage.setItem(SCOPES_STORAGE_KEY, JSON.stringify(scopes));
  } catch {
    /* no persistence available — the list still works for this session */
  }
  return scopes;
}

/**
 * Save `scope`, replacing any scope of the same name, newest first. Answers with
 * the list as it now stands so a caller can render it without re-reading.
 */
export function saveScope(scope: SavedScope): SavedScope[] {
  const rest = readScopes().filter((s) => s.name !== scope.name);
  return write([scope, ...rest].slice(0, MAX_SAVED_SCOPES));
}

export function deleteScope(name: string): SavedScope[] {
  return write(readScopes().filter((s) => s.name !== name));
}
