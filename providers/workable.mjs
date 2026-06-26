// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workable provider — hits the public markdown feed at /<slug>/jobs.md.
// Workable's documented JSON API requires an auth token; the markdown feed
// is the only no-auth public surface. Auto-detects from careers_url pattern
// `https://apply.workable.com/<slug>`. A tracked_companies entry can also
// set `provider: workable` explicitly to bypass detection.

const ALLOWED_WORKABLE_HOSTS = new Set(['apply.workable.com']);

function assertWorkableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`workable: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`workable: URL must use HTTPS: ${url}`);
  if (!ALLOWED_WORKABLE_HOSTS.has(parsed.hostname)) {
    throw new Error(`workable: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_WORKABLE_HOSTS].join(', ')}`);
  }
  return url;
}

function resolveFeedUrl(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'apply.workable.com') return null;
  const slug = parsed.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  return `https://apply.workable.com/${slug}/jobs.md`;
}

/** @type {Provider} */
export default {
  id: 'workable',

  detect(entry) {
    const feedUrl = resolveFeedUrl(entry);
    return feedUrl ? { url: feedUrl } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = resolveFeedUrl(entry);
    if (!feedUrl) throw new Error(`workable: cannot derive feed URL for ${entry.name}`);
    assertWorkableUrl(feedUrl);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertWorkableUrl above it guarantees the final hostname stays in the allowlist.
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    return parseWorkableMarkdown(text, entry.name);
  },
};

/**
 * Parse Workable's public markdown feed. Exported as a named export for unit
 * tests. The feed exposes a table:
 *   | Title | Department | Location | Type | Salary | Posted | Details |
 * where `Details` holds a markdown link
 *   [View](https://apply.workable.com/<slug>/jobs/view/<id>.md)
 * URLs are validated against `https://apply.workable.com/` — off-domain or
 * non-HTTPS [View] links are skipped (not emitted).
 *
 * @param {string} text — markdown body
 * @param {string} companyName — value to write into job.company
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseWorkableMarkdown(text, companyName) {
  if (typeof text !== 'string') return [];
  const jobs = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || !line.includes('[View]')) continue;
    const cols = line.split('|').map(c => c.trim());
    // Cols: ['', title, dept, location, type, salary, posted, '[View](url.md)', '']
    if (cols.length < 8) continue;
    const title = cols[1];
    if (!title || title === 'Title') continue;
    const location = cols[3] || '';
    const salaryStr = cols[5] || '';
    const postedStr = cols[6] || '';
    const urlMatch = line.match(/\[View\]\(([^)]+)\)/);
    let url = urlMatch ? urlMatch[1] : '';
    if (url.endsWith('.md')) url = url.slice(0, -3);
    if (!url) continue;  // skip rows with no resolvable URL (e.g., malformed [View] link)

    // Validate the extracted URL: must parse as https://apply.workable.com/...
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'apply.workable.com') continue;
      url = parsedUrl.href;
    } catch {
      continue;
    }

    jobs.push({
      title,
      url,
      location,
      company: companyName,
      salary: extractWorkableSalary(salaryStr),
      publishedAt: parseWorkableDate(postedStr),
    });
  }
  return jobs;
}

// Extract minimum salary from Workable's salary string (e.g. "$50k - $100k").
// Returns undefined if the salary string cannot be parsed.
function extractWorkableSalary(salaryStr) {
  if (!salaryStr || typeof salaryStr !== 'string') return undefined;
  const match = salaryStr.match(/[\$£€]?((?:\d[\d,]*)(?:\.\d+)?)(?:[kK])?/);
  if (!match) return undefined;
  // Strip thousands separators (commas) but keep the decimal point so that
  // "$50,000" -> 50000 and "$50,000.50" -> 50000.50.
  let num = parseFloat(match[1].replace(/,/g, ''));
  // Convert from thousands if the original had a 'k' suffix
  if (salaryStr.match(/[\$£€]?\d+[kK]/)) num *= 1000;
  return isNaN(num) ? undefined : num;
}

// Parse Workable's date string (e.g. "15 Jun 2025") to ISO format.
// Returns undefined if the date cannot be parsed.
function parseWorkableDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return undefined;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return undefined;
    return date.toISOString().split('T')[0]; // Return YYYY-MM-DD
  } catch {
    return undefined;
  }
}
