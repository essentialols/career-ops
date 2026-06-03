// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchText } from './_http.mjs';

// LinkedIn search URL builder
function buildSearchUrl(query) {
  if (!query) return null;

  const params = new URLSearchParams();

  // Required: keywords
  if (query.keywords) {
    params.set('keywords', query.keywords);
  } else {
    return null; // keywords are mandatory
  }

  // Optional location + distance radius
  if (query.location) {
    params.set('location', query.location);
  }
  if (query.distance) {
    params.set('distance', String(query.distance));
  }

  // Optional filters
  if (query.experience) {
    params.set('f_E', query.experience);
  }
  if (query.job_type) {
    params.set('f_JT', query.job_type);
  }
  if (query.workplace) {
    params.set('f_WT', query.workplace);
  }
  if (query.salary_bucket) {
    params.set('f_SB2', query.salary_bucket);
  }
  if (query.time_posted) {
    params.set('f_TPR', query.time_posted);
  }

  // Sorting
  params.set('sortBy', 'DD'); // date desc
  params.set('start', '0'); // start from page 0

  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

// Parse job cards from LinkedIn HTML response.
// LinkedIn public search renders cards as <div class="... base-search-card ...">
// with data-entity-urn containing the job ID. Key fields live in:
//   - URL: <a class="base-card__full-link" href="...">
//   - Title: <h3 class="base-search-card__title">
//   - Company: <h4 class="base-search-card__subtitle"> (with nested <a>)
//   - Location: <span class="job-search-card__location">
//   - Date: <time datetime="...">
function parseJobCards(html) {
  const jobs = [];
  if (!html || typeof html !== 'string') return jobs;

  // Extract job URLs (most reliable anchor point)
  const linkPattern = /href="(https:\/\/www\.linkedin\.com\/jobs\/view\/[^"?]+)/g;
  const urls = [];
  let m;
  while ((m = linkPattern.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, '&');
    if (!urls.includes(url)) urls.push(url);
  }

  // Extract parallel arrays of titles, companies, locations, dates
  const titles = [...html.matchAll(/base-search-card__title[^>]*>\s*([^<]+)/g)].map(m => m[1].trim());
  const companies = [...html.matchAll(/base-search-card__subtitle[\s\S]*?<a[^>]*>\s*([^<]+)/g)].map(m => m[1].trim());
  const locations = [...html.matchAll(/job-search-card__location[^>]*>\s*([^<]+)/g)].map(m => m[1].trim());
  const dates = [...html.matchAll(/<time[^>]*datetime="([^"]+)"/g)].map(m => m[1]);

  // Check for "Be an early applicant" tags per card.
  // Split HTML by card boundaries and check each.
  const cardChunks = html.split(/base-search-card--link/).slice(1);

  // Zip them together (all arrays should be same length; use shortest)
  const count = Math.min(urls.length, titles.length);
  for (let i = 0; i < count; i++) {
    const earlyApplicant = cardChunks[i] ? /early applicant/i.test(cardChunks[i]) : false;
    jobs.push({
      title: titles[i] || '',
      url: urls[i],
      company: (companies[i] || '').replace(/\n/g, '').trim() || 'LinkedIn Job',
      location: (locations[i] || '').trim(),
      publishedAt: dates[i] || undefined,
      earlyApplicant,
    });
  }

  return jobs;
}

// Rate limiting: 2 second delay between requests
const LINKEDIN_DELAY_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {Provider} */
export default {
  id: 'linkedin',

  // LinkedIn doesn't have a company careers_url pattern to detect
  // This provider is used via search queries (linkedin_searches), not auto-detection
  detect() {
    return null;
  },

  // Fetch jobs from a LinkedIn search query
  async fetch(query, ctx) {
    if (!query || !query.keywords) {
      throw new Error('linkedin: query must have keywords field');
    }

    const url = buildSearchUrl(query);
    if (!url) {
      throw new Error('linkedin: could not build search URL');
    }

    try {
      // Add delay to respect rate limits
      await sleep(LINKEDIN_DELAY_MS);

      // Fetch the search results page.
      // Override User-Agent: LinkedIn blocks non-browser UAs.
      const html = await fetchText(url, {
        timeoutMs: 15000,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });

      // Parse job cards from the HTML
      const jobs = parseJobCards(html);

      return jobs;
    } catch (err) {
      // LinkedIn aggressively rate-limits. 429/999 are expected under load.
      // Just fail and let the scanner log it. No retry.
      if (err.status === 429 || err.status === 999) {
        throw new Error(`linkedin: rate limited (${err.status}), try again later`);
      }
      throw err;
    }
  },
};
