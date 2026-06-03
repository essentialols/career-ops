// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

// Extract minimum salary from Greenhouse's salary_range object.
// Greenhouse returns {min, max, currency_code}; we extract the minimum.
// Returns undefined if no salary data is available.
function extractGreenhouseSalary(salaryRange) {
  if (!salaryRange || typeof salaryRange !== 'object') return undefined;
  if (salaryRange.min && typeof salaryRange.min === 'number') return salaryRange.min;
  return undefined;
}

/** @type {Provider} */
export default {
  id: 'greenhouse',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.filter(j => j.absolute_url).map(j => ({
      title: j.title || '',
      url: j.absolute_url,
      company: entry.name,
      location: j.location?.name || '',
      publishedAt: j.updated_at || j.created_at,
      salary: extractGreenhouseSalary(j.salary_range),
      workplaceType: j.workplace_type || undefined,
      employmentType: j.employment_type || undefined,
      description: j.description || j.content?.body || undefined,
    }));
  },
};
