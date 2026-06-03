#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner with a plugin-based provider layer.
 *
 * Providers live in providers/*.mjs and are loaded at startup. Each provider
 * exports a default object with:
 *   - id: string — matched against `provider:` in portals.yml
 *   - detect(entry): {url}|null — optional auto-detection from careers_url
 *   - fetch(entry, ctx): [{title,url,company,location}] — required
 *
 * Files prefixed with _ are shared helpers (e.g. _http.mjs) and are never
 * loaded as providers. Adding a new HTTP/API source = drop a *.mjs into
 * providers/. Local executable parsers use `providers/local-parser.mjs` when
 * `parser.command` + `parser.script` are set in portals.yml.
 *
 * A tracked_companies entry can set `provider:` explicitly to bypass
 * URL-based auto-detection. The `transport:` field is reserved for future
 * transports — Phase A only ships the http transport.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --verify         # Playwright-check each new URL; drop expired postings
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import yaml from 'js-yaml';

import { makeHttpCtx } from './providers/_http.mjs';

const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const PROVIDERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'providers');

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;

// ── Provider loading ────────────────────────────────────────────────

async function loadProviders(dir) {
  const providers = new Map();
  if (!existsSync(dir)) return providers;
  // Alphabetical order so detect() priority is deterministic across machines.
  const entries = readdirSync(dir)
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  for (const file of entries) {
    const full = path.join(dir, file);
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (err) {
      console.error(`⚠️  ${file}: failed to load — ${err.message}`);
      continue;
    }
    const p = mod.default;
    if (!p || typeof p.fetch !== 'function' || !p.id) {
      console.error(`⚠️  ${file}: skipping — default export must be { id, fetch }`);
      continue;
    }
    if (providers.has(p.id)) {
      console.error(`⚠️  ${file}: duplicate provider id "${p.id}" — keeping first`);
      continue;
    }
    providers.set(p.id, p);
  }
  return providers;
}

// Resolve which provider handles a tracked_companies entry.
// 1. Explicit `provider:` field wins (skips detect()).
// 2. local-parser when parser.command + script are configured (before API detect).
// 3. Otherwise each provider's detect() runs in load order; first hit wins.
function resolveProvider(entry, providers, { skipIds = [] } = {}) {
  if (entry.provider) {
    const p = providers.get(entry.provider);
    if (!p) return { error: `unknown provider: ${entry.provider}` };
    return { provider: p };
  }

  const localParser = providers.get('local-parser');
  if (localParser && !skipIds.includes('local-parser')) {
    try {
      const hit = localParser.detect?.(entry);
      if (hit) return { provider: localParser };
    } catch (err) {
      console.error(`⚠️  local-parser: detect() threw for "${entry.name}" — ${err.message}`);
    }
  }

  for (const p of providers.values()) {
    if (skipIds.includes(p.id)) continue;
    let hit;
    try {
      hit = p.detect?.(entry);
    } catch (err) {
      console.error(`⚠️  ${p.id}: detect() threw for "${entry.name}" — ${err.message}`);
      continue;
    }
    if (hit) return { provider: p };
  }
  return null;
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ─────────────────────────────────────────────────
// Optional. If `location_filter` is absent from portals.yml, all locations pass.
// Semantics (case-insensitive substring, in this order):
//   - Empty / whitespace-only / non-string location → pass (don't penalize
//     missing or malformed provider data)
//   - `always_allow` matches → pass (takes precedence over `block` — lets a
//     multi-location string like "Remote, Belgium or France" through because
//     the home region is an option, even though "france" is blocked)
//   - `block` matches → reject
//   - `allow` empty → pass (already cleared block)
//   - `allow` non-empty → must match at least one keyword

// Normalize a keyword list from portals.yml: tolerates a bare string
// (wrapped to a 1-item array), null/undefined (→ []), and non-string
// entries (filtered out). Survivors are lowercased, trimmed, and any
// resulting empty strings are dropped — an empty keyword would otherwise
// match every location via String.includes(''), silently bypassing the
// other tiers.
function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.length > 0 && alwaysAllow.some(k => lower.includes(k))) return true;
    if (block.length > 0 && block.some(k => lower.includes(k))) return false;
    if (allow.length === 0) return true;
    return allow.some(k => lower.includes(k));
  };
}

// ── Freshness filter ────────────────────────────────────────────────
// Optional. If `freshness_filter` is absent from portals.yml, all jobs pass.
// Jobs older than max_days (from today) are rejected.
// Jobs with missing publishedAt dates are accepted (don't penalize missing data).

export function buildFreshnessFilter(freshnessFilter) {
  if (!freshnessFilter || !freshnessFilter.max_days) return () => true;
  const maxDays = freshnessFilter.max_days;
  const now = Date.now();

  return (publishedAt) => {
    if (!publishedAt || typeof publishedAt !== 'string') return true;
    try {
      const jobDate = new Date(publishedAt);
      const ageMs = now - jobDate.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      return ageDays <= maxDays;
    } catch {
      return true; // Unparseable dates pass (don't penalize malformed data)
    }
  };
}

// ── Salary filter ──────────────────────────────────────────────────
// Optional. If `salary_filter` is absent from portals.yml, all jobs pass.
// Jobs with salary < min_salary are rejected.
// Jobs with missing salary data are accepted (don't penalize missing data).

export function buildSalaryFilter(salaryFilter) {
  if (!salaryFilter || !salaryFilter.min_salary) return () => true;
  const minSalary = salaryFilter.min_salary;

  return (salary) => {
    if (salary == null) return true; // Missing salary always passes
    const num = typeof salary === 'string' ? parseFloat(salary) : salary;
    if (isNaN(num)) return true; // Unparseable salaries pass
    return num >= minSalary;
  };
}

// ── Workplace filter ────────────────────────────────────────────────
// Optional. If `workplace_filter` is absent from portals.yml, all jobs pass.
// Jobs with unrecognized workplace types are accepted (don't penalize missing data).
// Matches case-insensitively against workplaceType (OnSite, Remote, Hybrid).

export function buildWorkplaceFilter(workplaceFilter) {
  if (!workplaceFilter || !Array.isArray(workplaceFilter.allow) || workplaceFilter.allow.length === 0) {
    return () => true;
  }
  const allowed = new Set(workplaceFilter.allow.map(w => w.toLowerCase()));

  return (workplaceType) => {
    if (!workplaceType || typeof workplaceType !== 'string') return true;
    return allowed.has(workplaceType.toLowerCase());
  };
}

// ── Employment filter ──────────────────────────────────────────────
// Optional. If `employment_filter` is absent from portals.yml, all jobs pass.
// Jobs with unrecognized employment types are accepted (don't penalize missing data).
// Matches case-insensitively against employmentType (FullTime, PartTime, Contract, etc.).

export function buildEmploymentFilter(employmentFilter) {
  if (!employmentFilter || !Array.isArray(employmentFilter.allow) || employmentFilter.allow.length === 0) {
    return () => true;
  }
  const allowed = new Set(employmentFilter.allow.map(e => e.toLowerCase()));

  return (employmentType) => {
    if (!employmentType || typeof employmentType !== 'string') return true;
    return allowed.has(employmentType.toLowerCase());
  };
}

// ── Seniority filter ────────────────────────────────────────────────
// Optional. If `seniority_filter` is absent from portals.yml, all jobs pass.
// Minimum seniority level required: intern < entry < associate < mid_senior < director < executive.
// Infers level from title keywords if explicit field is unavailable.

function getSeniorityLevel(title) {
  const lower = (title || '').toLowerCase();
  if (lower.includes('executive') || lower.includes('c-level') || lower.includes('ceo') || lower.includes('cto') || lower.includes('cfo')) return 5;
  if (lower.includes('director') || lower.includes('vp ')) return 4;
  if (lower.includes('staff') || lower.includes('senior') || lower.includes('lead')) return 3;
  if (lower.includes('mid') || lower.includes('intermediate')) return 3;
  if (lower.includes('associate')) return 2;
  if (lower.includes('entry') || lower.includes('junior')) return 1;
  if (lower.includes('intern')) return 0;
  return 2; // default to associate for unclassified titles
}

export function buildSeniorityFilter(seniorityFilter) {
  if (!seniorityFilter || !seniorityFilter.min_level) return () => true;

  const levelMap = {
    'intern': 0,
    'entry': 1,
    'associate': 2,
    'mid_senior': 3,
    'director': 4,
    'executive': 5,
  };

  const minLevel = levelMap[seniorityFilter.min_level];
  if (minLevel === undefined) return () => true; // Invalid min_level → accept all

  return (title) => {
    const level = getSeniorityLevel(title);
    return level >= minLevel;
  };
}

// ── Description filter ──────────────────────────────────────────────
// Optional. If `description_filter` is absent from portals.yml, all jobs pass.
// require_any: job must match at least one keyword (case-insensitive substring).
// exclude_any: if job matches any keyword, reject it.

export function buildDescriptionFilter(descriptionFilter) {
  if (!descriptionFilter) return () => true;

  const requireAny = (descriptionFilter.require_any || []).map(k => k.toLowerCase());
  const excludeAny = (descriptionFilter.exclude_any || []).map(k => k.toLowerCase());

  if (requireAny.length === 0 && excludeAny.length === 0) return () => true;

  return (description) => {
    if (!description || typeof description !== 'string' || description.length < 50) {
      // Missing or truncated description: always pass (don't penalize missing data)
      return true;
    }

    const lower = description.toLowerCase();

    // Check exclude_any first (hard reject)
    if (excludeAny.length > 0 && excludeAny.some(k => lower.includes(k))) {
      return false;
    }

    // Check require_any (soft accept if empty)
    if (requireAny.length > 0) {
      return requireAny.some(k => lower.includes(k));
    }

    return true;
  };
}

// ── Early applicant filter ──────────────────────────────────────────
// Optional. If `early_applicant_only` is true in portals.yml, only jobs
// with earlyApplicant=true pass. Jobs without the field pass (don't penalize).

export function buildEarlyApplicantFilter(flag) {
  if (!flag) return () => true;
  return (earlyApplicant) => {
    if (earlyApplicant === undefined || earlyApplicant === null) return true;
    return earlyApplicant === true;
  };
}

// ── Company blocklist ──────────────────────────────────────────────
// Optional. If `company_filter` is absent, all companies pass.
// block: list of company name substrings to reject (case-insensitive).
// allow: if non-empty, company must match at least one (allowlist mode).

export function buildCompanyFilter(companyFilter) {
  if (!companyFilter) return () => true;
  const block = normalizeKeywordList(companyFilter.block);
  const allow = normalizeKeywordList(companyFilter.allow);
  if (block.length === 0 && allow.length === 0) return () => true;

  return (company) => {
    if (!company || typeof company !== 'string') return true;
    const lower = company.toLowerCase();
    if (block.length > 0 && block.some(k => lower.includes(k))) return false;
    if (allow.length > 0) return allow.some(k => lower.includes(k));
    return true;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  // From applications tracker
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  // From pipeline (catches reposts of unprocessed jobs)
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/\|\s*([^|]+)\s*\|\s*([^|]+)\s*$/gm)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role) seen.add(`${company}::${role}`);
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  // Ensure file exists on fresh setup
  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date, status = 'added') {
  // Ensure file + header exist. Location appended as 7th column for non-breaking
  // backward compat — older scan-history.tsv files with 6 columns still parse fine
  // since loadSeenUrls only reads column 0. `status` is parameterized so callers
  // can record verify outcomes (`skipped_expired`, etc.) without the legacy
  // `(expired)` suffix in `source`.
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\t${status}\t${o.location || ''}`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function verifyOffers(offers) {
  // Dynamic imports keep the default zero-token path free of Playwright startup
  let chromium;
  let checkUrlLiveness;
  try {
    ({ chromium } = await import('playwright'));
    ({ checkUrlLiveness } = await import('./liveness-browser.mjs'));
  } catch (err) {
    throw new Error(
      `--verify requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
      { cause: err },
    );
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `--verify could not launch Chromium (run "npx playwright install chromium" or re-run without --verify): ${err.message}`,
      { cause: err },
    );
  }

  // Three permanent buckets + one transient passthrough:
  //   verified  → active pages and transient nav errors (retry next scan)
  //   expired   → classifier-confirmed dead postings (HTTP 4xx, redirect markers,
  //               body patterns, listing pages, insufficient content)
  //   dropped   → page loaded but classifier saw no Apply control. --verify is an
  //               opt-in stricter filter; keeping these defeats the purpose.
  //   invalid   → up-front URL guard rejections (malformed / non-http / private)
  const verified = [];
  const expired = [];
  const dropped = [];
  const invalid = [];

  try {
    const page = await browser.newPage();
    // Sequential — project rule: never Playwright in parallel
    for (const offer of offers) {
      const { result, code, reason } = await checkUrlLiveness(page, offer.url);
      if (result === 'expired') {
        expired.push({ ...offer, reason });
        console.log(`  ❌ expired   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && GUARD_CODES.has(code)) {
        // Guard failures are permanent (not transient like a timeout) — record them
        // separately so they don't end up in pipeline.md but DO appear in scan-history
        // with a precise status, dedup-blocking them on subsequent scans.
        invalid.push({ ...offer, code, reason });
        console.log(`  ⛔ invalid   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && code === 'no_apply_control') {
        // Page loaded but classifier could not find an Apply control. Treat like
        // expired for routing — drop from pipeline AND record in scan-history so
        // we don't burn a verify cycle on the same URL next scan.
        dropped.push({ ...offer, reason });
        console.log(`  ⚠️ no-apply  ${offer.company} | ${offer.title} (${reason})`);
      } else {
        // 'active' or 'uncertain' due to navigation_error (transient — retry next scan)
        verified.push(offer);
        const icon = result === 'active' ? '✅' : '⚠️';
        console.log(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}`);
      }
    }
  } finally {
    await browser.close();
  }

  return { verified, expired, dropped, invalid };
}

// Stable codes from liveness-browser's up-front URL guard. Routing dispatches
// on these codes (not on regex over reason strings) so wording can change
// without breaking the pipeline.
const GUARD_CODES = new Set(['invalid_url', 'unsupported_protocol', 'blocked_host']);

// guardStatusFor maps a guard code to the canonical scan-history status string.
function guardStatusFor(code) {
  if (code === 'blocked_host') return 'skipped_blocked_host';
  // invalid_url and unsupported_protocol both surface as malformed input
  return 'skipped_invalid_url';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');
  const linkedinOnly = args.includes('--linkedin-only');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Load providers
  const providers = await loadProviders(PROVIDERS_DIR);
  if (providers.size === 0) {
    console.error('Error: no providers loaded from providers/');
    process.exit(1);
  }

  // 2. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const freshnessFilter = buildFreshnessFilter(config.freshness_filter);
  const salaryFilter = buildSalaryFilter(config.salary_filter);
  const workplaceFilter = buildWorkplaceFilter(config.workplace_filter);
  const employmentFilter = buildEmploymentFilter(config.employment_filter);
  const seniorityFilter = buildSeniorityFilter(config.seniority_filter);
  const descriptionFilter = buildDescriptionFilter(config.description_filter);
  const earlyApplicantFilter = buildEarlyApplicantFilter(config.early_applicant_only);
  const companyFilter = buildCompanyFilter(config.company_filter);

  // 3. Resolve a provider for each enabled company
  const targets = [];
  let skippedCount = 0;
  const resolveErrors = [];
  for (const company of (linkedinOnly ? [] : companies)) {
    if (!company || typeof company !== 'object') continue;
    if (company.enabled === false) continue;
    if (typeof company.name !== 'string' || !company.name.trim()) {
      console.error(`⚠️  Skipping entry — missing or non-string 'name' field: ${JSON.stringify(company)}`);
      continue;
    }
    if (filterCompany && !company.name.toLowerCase().includes(filterCompany)) continue;
    const resolved = resolveProvider(company, providers);
    if (!resolved) { skippedCount++; continue; }
    if (resolved.error) { resolveErrors.push({ company: company.name, error: resolved.error }); continue; }
    targets.push({ ...company, _provider: resolved.provider });
  }

  const localParserCount = targets.filter(t => t._provider.id === 'local-parser').length;

  // 3b. Add linkedin_searches as targets (using linkedin provider)
  const linkedinSearches = config.linkedin_searches || [];
  const linkedinProvider = providers.get('linkedin');
  if (linkedinProvider && linkedinSearches.length > 0) {
    for (const search of linkedinSearches) {
      if (!search || typeof search !== 'object') continue;
      if (search.enabled === false) continue;
      if (typeof search.name !== 'string' || !search.name.trim()) {
        console.error(`Warning: Skipping linkedin_search entry — missing or non-string 'name' field: ${JSON.stringify(search)}`);
        continue;
      }
      targets.push({ ...search, _provider: linkedinProvider, _isSearch: true });
    }
  }

  console.log(`Scanning ${targets.length} companies via providers (${localParserCount} local parser; ${skippedCount} skipped, ${linkedinSearches.filter(s => s.enabled !== false).length} linkedin searches)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 4. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 5. Fetch from each target
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFilteredTitle = 0;
  let totalFilteredLocation = 0;
  let totalFilteredFreshness = 0;
  let totalFilteredSalary = 0;
  let totalFilteredWorkplace = 0;
  let totalFilteredEmployment = 0;
  let totalFilteredSeniority = 0;
  let totalFilteredDescription = 0;
  let totalFilteredEarlyApplicant = 0;
  let totalFilteredCompany = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [...resolveErrors];

  const tasks = targets.map(target => async () => {
    let provider = target._provider;
    const ctx = makeHttpCtx();
    const isSearch = target._isSearch;
    let sourceName = isSearch ? 'linkedin-search' : (provider.id === 'local-parser' ? 'local-parser' : `${provider.id}-api`);
    try {
      let jobs;
      try {
        // For linkedin searches, pass the search object directly
        // For companies, pass the company object
        jobs = await provider.fetch(target, ctx);
      } catch (parserErr) {
        if (provider.id !== 'local-parser') throw parserErr;
        const fallback = resolveProvider(target, providers, { skipIds: ['local-parser'] });
        if (!fallback || fallback.error) throw parserErr;
        provider = fallback.provider;
        sourceName = `${provider.id}-api`;
        jobs = await provider.fetch(target, ctx);
        errors.push({
          company: target.name,
          error: `local parser failed, used API fallback: ${parserErr.message}`,
        });
      }
      if (!Array.isArray(jobs)) {
        throw new Error(`${provider.id}: fetch() did not return an array`);
      }
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFilteredTitle++;
          continue;
        }
        if (!locationFilter(job.location)) {
          totalFilteredLocation++;
          continue;
        }
        if (!freshnessFilter(job.publishedAt)) {
          totalFilteredFreshness++;
          continue;
        }
        if (!salaryFilter(job.salary)) {
          totalFilteredSalary++;
          continue;
        }
        if (!workplaceFilter(job.workplaceType)) {
          totalFilteredWorkplace++;
          continue;
        }
        if (!employmentFilter(job.employmentType)) {
          totalFilteredEmployment++;
          continue;
        }
        if (!seniorityFilter(job.title)) {
          totalFilteredSeniority++;
          continue;
        }
        if (!descriptionFilter(job.description)) {
          totalFilteredDescription++;
          continue;
        }
        if (!companyFilter(job.company)) {
          totalFilteredCompany++;
          continue;
        }
        if (!earlyApplicantFilter(job.earlyApplicant)) {
          totalFilteredEarlyApplicant++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: sourceName });
      }
    } catch (err) {
      errors.push({ company: target.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5.5. Optional liveness verification — drop expired and guard-rejected postings
  let verifiedOffers = newOffers;
  let expiredOffers = [];
  let droppedOffers = [];
  let invalidOffers = [];
  if (verify && newOffers.length > 0) {
    console.log(`\nVerifying liveness of ${newOffers.length} new offer(s) with Playwright (sequential)...`);
    const result = await verifyOffers(newOffers);
    verifiedOffers = result.verified;
    expiredOffers = result.expired;
    droppedOffers = result.dropped;
    invalidOffers = result.invalid;
  }

  // 6. Write results
  if (!dryRun && verifiedOffers.length > 0) {
    appendToPipeline(verifiedOffers);
    appendToScanHistory(verifiedOffers, date);
  }
  if (!dryRun && expiredOffers.length > 0) {
    appendToScanHistory(expiredOffers, date, 'skipped_expired');
  }
  // Pages that loaded but had no Apply control: record so we don't re-verify
  // them next scan, but never let them reach pipeline.md.
  if (!dryRun && droppedOffers.length > 0) {
    appendToScanHistory(droppedOffers, date, 'skipped_no_apply_control');
  }
  // Guard-rejected URLs (invalid / unsupported protocol / blocked host) are
  // recorded with a precise status so subsequent scans dedup-skip them via
  // loadSeenUrls, but they never reach pipeline.md.
  if (!dryRun && invalidOffers.length > 0) {
    // Group by code so the TSV reflects the actual reason category.
    const byStatus = new Map();
    for (const o of invalidOffers) {
      const status = guardStatusFor(o.code);
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(o);
    }
    for (const [status, group] of byStatus) {
      appendToScanHistory(group, date, status);
    }
  }

  // 7. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan - ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFilteredTitle} removed`);
  console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  console.log(`Filtered by freshness: ${totalFilteredFreshness} removed`);
  console.log(`Filtered by salary:    ${totalFilteredSalary} removed`);
  console.log(`Filtered by workplace: ${totalFilteredWorkplace} removed`);
  console.log(`Filtered by employment: ${totalFilteredEmployment} removed`);
  console.log(`Filtered by seniority: ${totalFilteredSeniority} removed`);
  console.log(`Filtered by description: ${totalFilteredDescription} removed`);
  console.log(`Filtered by company:   ${totalFilteredCompany} removed`);
  console.log(`Filtered by early app: ${totalFilteredEarlyApplicant} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  if (verify) {
    console.log(`Expired (verified):    ${expiredOffers.length} dropped`);
    console.log(`No apply control:      ${droppedOffers.length} dropped`);
    console.log(`Invalid (guarded):     ${invalidOffers.length} dropped`);
  }
  console.log(`New offers added:      ${verifiedOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (verifiedOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of verifiedOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// Only run main() when invoked directly (`node scan.mjs`), not when imported by tests.
// `|| ''` guards the case where Node is invoked without a script arg (e.g. `node -e`).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
