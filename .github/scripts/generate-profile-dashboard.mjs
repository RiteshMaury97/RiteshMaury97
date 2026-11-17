import { mkdir, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME ?? "RiteshMaury97";
const token = process.env.GITHUB_TOKEN;
const outDir = process.env.DASHBOARD_OUTPUT ?? "dist";
const now = new Date();
const yearAgo = new Date(now);
yearAgo.setUTCDate(yearAgo.getUTCDate() - 365);
const iso = (date) => date.toISOString();

if (!token) throw new Error("GITHUB_TOKEN is required to generate verified profile metrics.");

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "RiteshMaury97-profile-dashboard",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

async function graphql(query, variables) {
  const response = await github("/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
    headers: { "Content-Type": "application/json" },
  });
  if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).join("; "));
  return response.data.user;
}

async function allPublicRepositories() {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await github(`/users/${encodeURIComponent(username)}/repos?per_page=100&page=${page}&type=owner&sort=updated`);
    if (!Array.isArray(batch)) throw new Error("Expected a public repository list from GitHub.");
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

const [profile, repositories] = await Promise.all([
  github(`/users/${encodeURIComponent(username)}`),
  allPublicRepositories(),
]);

if (!Array.isArray(repositories)) throw new Error("Expected a public repository list from GitHub.");

const contributionQuery = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount date color } }
      }
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
    }
  }
}`;

// GitHub returns contribution collections in one-year windows. Query each UTC year
// since account creation, then sum public-only totals. The current window supplies
// the heatmap and streak values.
const createdAt = new Date(profile.created_at);
const windows = [];
for (let start = new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate())); start < now;) {
  const end = new Date(Math.min(start.getTime() + 364 * 24 * 60 * 60 * 1000 - 1000, now.getTime()));
  windows.push({ from: iso(start), to: iso(end) });
  start = new Date(end.getTime() + 1000);
}

const [yearlyContributions, currentWindowResult] = await Promise.all([
  Promise.all(windows.map(({ from, to }) => graphql(contributionQuery, { login: username, from, to }))),
  graphql(contributionQuery, { login: username, from: iso(yearAgo), to: iso(now) }),
]);
const currentWindow = currentWindowResult.contributionsCollection;
const allTimeContributions = yearlyContributions.reduce((sum, result) => sum + result.contributionsCollection.contributionCalendar.totalContributions, 0);
const publicContributionsLastYear = currentWindow.contributionCalendar.totalContributions;
const allDays = currentWindow.contributionCalendar.weeks.flatMap((week) => week.contributionDays)
  .filter((day) => day.date >= yearAgo.toISOString().slice(0, 10));

let currentStreak = 0;
for (let index = allDays.length - 1; index >= 0; index--) {
  if (allDays[index].contributionCount > 0) currentStreak++;
  else if (allDays[index].date === now.toISOString().slice(0, 10) && currentStreak === 0) continue;
  else break;
}
let bestStreak = 0;
let run = 0;
for (const day of allDays) {
  run = day.contributionCount > 0 ? run + 1 : 0;
  bestStreak = Math.max(bestStreak, run);
}

const languageMaps = await Promise.all(repositories.map(async (repo) => {
  if (repo.fork) return {};
  return github(`/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/languages`);
}));
const languageTotals = {};
for (const map of languageMaps) for (const [name, bytes] of Object.entries(map)) languageTotals[name] = (languageTotals[name] ?? 0) + bytes;
const languages = Object.entries(languageTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);
const languageBytes = languages.reduce((sum, [, bytes]) => sum + bytes, 0);

const stars = repositories.reduce((sum, repo) => sum + repo.stargazers_count, 0);
const forks = repositories.reduce((sum, repo) => sum + repo.forks_count, 0);
const yearsOnGitHub = Math.max(0, (now - createdAt) / (365.2425 * 24 * 60 * 60 * 1000));

// Custom activity score (not an official GitHub ranking):
// 100 XP/repository + 20/follower + 10/star + 5/fork + 2 public contribution
// in the last year + 25 public pull request contribution in the last year.
const currentPullRequests = currentWindow.totalPullRequestContributions;
const xp = repositories.length * 100 + profile.followers * 20 + stars * 10 + forks * 5
  + publicContributionsLastYear * 2 + currentPullRequests * 25;
const levels = [
  { name: "Explorer", threshold: 0 },
  { name: "Builder", threshold: 250 },
  { name: "Maker", threshold: 750 },
  { name: "Collaborator", threshold: 1800 },
  { name: "Maintainer", threshold: 3500 },
  { name: "Trailblazer", threshold: 6000 },
];
let levelIndex = 0;
for (let index = 0; index < levels.length; index++) if (xp >= levels[index].threshold) levelIndex = index;
const level = levels[levelIndex];
const nextLevel = levels[levelIndex + 1];
const progress = nextLevel ? Math.max(0, Math.min(1, (xp - level.threshold) / (nextLevel.threshold - level.threshold))) : 1;

const achievements = [
  { label: "Repository creator", unlocked: repositories.length > 0, evidence: `${repositories.length} public repositories` },
  { label: "First star", unlocked: stars > 0, evidence: `${stars} stars received` },
  { label: "First fork", unlocked: forks > 0, evidence: `${forks} forks received` },
  { label: "Pull request contributor", unlocked: currentPullRequests > 0, evidence: `${currentPullRequests} public PR contributions this year` },
  { label: "Code reviewer", unlocked: currentWindow.totalPullRequestReviewContributions > 0, evidence: `${currentWindow.totalPullRequestReviewContributions} public review contributions this year` },
  { label: "Seven-day streak", unlocked: currentStreak >= 7, evidence: `${currentStreak}-day current streak` },
];

const escapeXml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
const number = (value) => new Intl.NumberFormat("en-US").format(value);
const compact = (value) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const recent = [...repositories].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 3);
const statCards = [
  ["PUBLIC REPOSITORIES", repositories.length], ["FOLLOWERS", profile.followers],
  ["FOLLOWING", profile.following], ["PUBLIC CONTRIBUTIONS · ALL TIME", allTimeContributions],
  ["CONTRIBUTIONS · LAST 12 MONTHS", publicContributionsLastYear], ["STARS RECEIVED", stars],
  ["FORKS RECEIVED", forks], ["ACCOUNT AGE", `${yearsOnGitHub.toFixed(1)} years`],
];

const dashboard = [];
dashboard.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="890" viewBox="0 0 1100 890" role="img" aria-labelledby="title desc"><title id="title">${escapeXml(username)} GitHub analytics dashboard</title><desc id="desc">Live public GitHub metrics, custom activity level, language distribution, verified milestones, and recently updated repositories. Generated ${iso(now)}.</desc><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#0B1220"/><stop offset="1" stop-color="#101B2D"/></linearGradient><linearGradient id="accent" x2="1"><stop stop-color="#67E8F9"/><stop offset="1" stop-color="#A78BFA"/></linearGradient></defs><rect width="1100" height="890" rx="24" fill="url(#bg)" stroke="#29384D" stroke-width="2"/><g font-family="Inter,Segoe UI,Arial,sans-serif">`);
dashboard.push(`<text x="40" y="53" fill="#F1F5F9" font-size="25" font-weight="700">GitHub Activity Dashboard</text><text x="40" y="79" fill="#94A3B8" font-size="12">LIVE PUBLIC DATA · @${escapeXml(username)} · REFRESHED ${iso(now).slice(0, 10)}</text>`);
statCards.forEach(([label, value], index) => {
  const col = index % 4; const row = Math.floor(index / 4); const x = 36 + col * 263; const y = 105 + row * 100;
  const displayValue = typeof value === "number" ? number(value) : value;
  dashboard.push(`<rect x="${x}" y="${y}" width="248" height="84" rx="12" fill="#111C2D" stroke="#26364B"/><text x="${x + 16}" y="${y + 27}" fill="#94A3B8" font-size="10" letter-spacing=".8">${escapeXml(label)}</text><text x="${x + 16}" y="${y + 62}" fill="#E2E8F0" font-size="25" font-weight="700">${escapeXml(displayValue)}</text>`);
});

const levelY = 325;
dashboard.push(`<rect x="36" y="${levelY}" width="506" height="184" rx="14" fill="#111C2D" stroke="#26364B"/><text x="56" y="${levelY + 30}" fill="#67E8F9" font-size="10" letter-spacing="1.2">CUSTOM ACTIVITY LEVEL · NOT A SKILL RATING OR GITHUB RANK</text><text x="56" y="${levelY + 68}" fill="#F1F5F9" font-size="23" font-weight="700">LVL ${String(levelIndex + 1).padStart(2, "0")}  /  ${escapeXml(level.name)}</text><text x="56" y="${levelY + 98}" fill="#CBD5E1" font-size="14">${number(xp)} XP</text><rect x="56" y="${levelY + 116}" width="460" height="12" rx="6" fill="#263449"/><rect x="56" y="${levelY + 116}" width="${460 * progress}" height="12" rx="6" fill="url(#accent)"/><text x="56" y="${levelY + 151}" fill="#94A3B8" font-size="11">${nextLevel ? `${number(xp)} / ${number(nextLevel.threshold)} XP to ${escapeXml(nextLevel.name)}` : "Maximum level reached"}</text><text x="56" y="${levelY + 170}" fill="#64748B" font-size="9">Formula: repos ×100 + followers ×20 + stars ×10 + forks ×5 + last-year contributions ×2 + PR contributions ×25</text>`);

const langY = levelY;
dashboard.push(`<rect x="558" y="${langY}" width="506" height="184" rx="14" fill="#111C2D" stroke="#26364B"/><text x="580" y="${langY + 31}" fill="#E2E8F0" font-size="15" font-weight="700">Language mix</text><text x="580" y="${langY + 51}" fill="#94A3B8" font-size="10">BYTE SHARE OF TOP FIVE · ORIGINAL PUBLIC REPOSITORIES</text>`);
languages.forEach(([name, bytes], index) => {
  const y = langY + 76 + index * 20;
  dashboard.push(`<text x="580" y="${y + 8}" fill="#CBD5E1" font-size="10">${escapeXml(name)}</text><rect x="700" y="${y}" width="310" height="8" rx="4" fill="#263449"/><rect x="700" y="${y}" width="${310 * bytes / (languages[0]?.[1] ?? 1)}" height="8" rx="4" fill="url(#accent)"/><text x="1038" y="${y + 8}" text-anchor="end" fill="#94A3B8" font-size="9">${languageBytes ? (bytes * 100 / languages.reduce((sum, [, n]) => sum + n, 0)).toFixed(1) : "0"}%</text>`);
});

const achY = 529;
dashboard.push(`<rect x="36" y="${achY}" width="506" height="230" rx="14" fill="#111C2D" stroke="#26364B"/><text x="56" y="${achY + 31}" fill="#E2E8F0" font-size="15" font-weight="700">Verified milestones</text>`);
achievements.forEach((achievement, index) => {
  const y = achY + 61 + index * 31; const color = achievement.unlocked ? "#67E8F9" : "#64748B"; const marker = achievement.unlocked ? "UNLOCKED" : "LOCKED";
  dashboard.push(`<circle cx="66" cy="${y - 4}" r="7" fill="${achievement.unlocked ? "#164E63" : "#263449"}" stroke="${color}"/><text x="84" y="${y}" fill="${achievement.unlocked ? "#E2E8F0" : "#64748B"}" font-size="11">${escapeXml(achievement.label)}</text><text x="516" y="${y}" text-anchor="end" fill="${color}" font-size="8" letter-spacing=".7">${marker}</text>`);
});

dashboard.push(`<rect x="558" y="${achY}" width="506" height="230" rx="14" fill="#111C2D" stroke="#26364B"/><text x="580" y="${achY + 31}" fill="#E2E8F0" font-size="15" font-weight="700">Recently updated</text>`);
recent.forEach((repo, index) => {
  const y = achY + 67 + index * 48;
  dashboard.push(`<a href="${escapeXml(repo.html_url)}"><text x="580" y="${y}" fill="#67E8F9" font-size="13" font-weight="600">${escapeXml(repo.name)}</text><text x="580" y="${y + 18}" fill="#94A3B8" font-size="10">${escapeXml((repo.description ?? "Public repository").slice(0, 72))}</text><text x="1038" y="${y + 4}" text-anchor="end" fill="#64748B" font-size="9">${iso(new Date(repo.updated_at)).slice(0, 10)}</text></a>`);
});
if (!recent.length) dashboard.push(`<text x="580" y="${achY + 70}" fill="#94A3B8" font-size="12">No public repositories found.</text>`);
dashboard.push(`<text x="580" y="${achY + 205}" fill="#94A3B8" font-size="10">Contribution streak: ${currentStreak} days current · ${bestStreak} days best (last 12 months)</text>`);
dashboard.push(`<text x="40" y="790" fill="#64748B" font-size="10">Public data only. Account age is based on GitHub account creation date. Contributions exclude private activity.</text></g></svg>`);

const heat = [];
heat.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="190" viewBox="0 0 1100 190" role="img" aria-labelledby="heatTitle heatDesc"><title id="heatTitle">Public contribution heatmap, last 12 months</title><desc id="heatDesc">${number(publicContributionsLastYear)} public contributions in the last 12 months. Generated ${iso(now)}.</desc><rect width="1100" height="190" rx="20" fill="#0B1220" stroke="#263449"/><g font-family="Inter,Segoe UI,Arial,sans-serif"><text x="28" y="34" fill="#F1F5F9" font-size="17" font-weight="700">Contribution heatmap · ${number(publicContributionsLastYear)} public contributions</text><text x="28" y="53" fill="#94A3B8" font-size="10">LAST 12 MONTHS · PUBLIC ACTIVITY ONLY</text>`);
const days = currentWindow.contributionCalendar.weeks;
const box = 13; const gap = 4; const startX = 30; const startY = 76;
days.forEach((week, weekIndex) => week.contributionDays.forEach((day, dayIndex) => {
  if (new Date(day.date) < yearAgo) return;
  const intensity = day.contributionCount === 0 ? "#172334" : day.contributionCount < 3 ? "#164E63" : day.contributionCount < 6 ? "#0E7490" : day.contributionCount < 10 ? "#0891B2" : "#67E8F9";
  heat.push(`<rect x="${startX + weekIndex * (box + gap)}" y="${startY + dayIndex * (box + gap)}" width="${box}" height="${box}" rx="3" fill="${intensity}"><title>${day.date}: ${day.contributionCount} contributions</title></rect>`);
}));
heat.push(`<text x="30" y="174" fill="#64748B" font-size="9">LESS</text>`);
["#172334", "#164E63", "#0E7490", "#0891B2", "#67E8F9"].forEach((color, index) => heat.push(`<rect x="70" y="165" width="11" height="11" rx="2" fill="${color}"/><text x="${86 + index * 20}" y="174" fill="#64748B" font-size="9">${index === 4 ? "MORE" : ""}</text>`));
heat.push(`<text x="1045" y="174" text-anchor="end" fill="#64748B" font-size="9">Generated ${iso(now).slice(0, 10)}</text></g></svg>`);

await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(`${outDir}/profile-dashboard.svg`, dashboard.join("")),
  writeFile(`${outDir}/contribution-heatmap.svg`, heat.join("")),
]);
console.log(`Generated dashboard: ${repositories.length} repos, ${allTimeContributions} lifetime public contributions, ${publicContributionsLastYear} in the last year, ${number(xp)} XP.`);
