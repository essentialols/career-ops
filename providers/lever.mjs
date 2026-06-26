// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Lever provider — hits the public postings endpoint.
// Auto-detects from careers_url pattern `https://jobs.lever.co/<slug>`.

function resolveApiUrl(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.lever.co/v0/postings/${match[1]}`;
}

// Extract minimum salary from Lever's salary object.
// Lever returns {start, mid, end, currency}; we extract the minimum.
// Returns undefined if no salary data is available.
function extractLeverSalary(salary) {
  if (!salary || typeof salary !== 'object') return undefined;
  if (salary.start && typeof salary.start === 'number') return salary.start;
  return undefined;
}

/** @type {Provider} */
export default {
  id: 'lever',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    const json = await ctx.fetchJson(apiUrl);
    if (!Array.isArray(json)) return [];
    return json.map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: entry.name,
      location: j.categories?.location || '',
      publishedAt: typeof j.createdAt === 'number' ? new Date(j.createdAt).toISOString() : undefined,
      salary: extractLeverSalary(j.salary),
      workplaceType: j.categories?.workplaceType || j.workplaceType || undefined,
      employmentType: j.categories?.employmentType || j.employmentType || undefined,
      description: j.description || undefined,
    }));
  },
};
