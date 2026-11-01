export interface MiniBookmark {
  url: string;
  title: string;
}

const key = (botId: string) => `ronic-mini-bookmarks-${botId}`;

/** Bookmarks live in localStorage keyed per bot, so the mini computer's own
 * window and the chat dock's embedded panel always see the same list. */
export function loadBookmarks(botId: string): MiniBookmark[] {
  try {
    const raw = localStorage.getItem(key(botId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.url === "string").slice(0, 100) : [];
  } catch {
    return [];
  }
}

function save(botId: string, list: MiniBookmark[]) {
  try {
    localStorage.setItem(key(botId), JSON.stringify(list.slice(0, 100)));
  } catch {
    /* storage full or unavailable */
  }
}

export function isBookmarked(botId: string, url: string): boolean {
  return loadBookmarks(botId).some((item) => item.url === url);
}

export function addBookmark(botId: string, entry: MiniBookmark): MiniBookmark[] {
  const list = loadBookmarks(botId).filter((item) => item.url !== entry.url);
  const next = [{ url: entry.url, title: entry.title || entry.url }, ...list];
  save(botId, next);
  return next;
}

export function removeBookmark(botId: string, url: string): MiniBookmark[] {
  const next = loadBookmarks(botId).filter((item) => item.url !== url);
  save(botId, next);
  return next;
}
