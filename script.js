"use strict";

// ========================================
// FIRST ISSUE FINDER
// ========================================

const API_URL = "https://api.github.com/search/issues";
const PER_PAGE = 30;

const BEGINNER_LABELS = [
  "good first issue",
  "good-first-issue",
  "first-timers-only",
  "beginner-friendly",
  "beginner"
];

const STAGES = ["Interested", "Planning", "Working", "Completed"];

const STORAGE_KEYS = {
  saved: "fif_saved_issues_v1",
  checklist: "fif_checklist_v1",
  theme: "fif_theme_v1"
};

const $ = (selector) => document.querySelector(selector);

const searchForm = $("#searchForm");
const keywordInput = $("#keyword");
const languageInput = $("#language");
const difficultyInput = $("#difficulty");
const issueStateInput = $("#issueState");
const sortInput = $("#sortBy");
const repositoryInput = $("#repository");
const issuesContainer = $("#issuesContainer");
const resultSummary = $("#resultSummary");
const loadMoreArea = $("#loadMoreArea");
const loadMoreButton = $("#loadMore");
const toast = $("#toast");

let searchResults = [];
let currentPage = 1;
let currentQuery = "";
let currentSort = "best-match";
let hasMoreResults = false;
let isLoading = false;
let requestNumber = 0;
let toastTimeout;

// ========================================
// SAFE BROWSER STORAGE
// ========================================

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch (error) {
    console.warn("Could not read browser storage:", error);
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn("Could not save browser storage:", error);
    showToast("Could not save data. Check your browser storage settings.");
    return false;
  }
}

function getSavedIssues() {
  const data = readStorage(STORAGE_KEYS.saved, []);
  return Array.isArray(data) ? data : [];
}

function setSavedIssues(issues) {
  return writeStorage(STORAGE_KEYS.saved, issues);
}

function getChecklistState() {
  const data = readStorage(STORAGE_KEYS.checklist, {});
  return data && typeof data === "object" && !Array.isArray(data)
    ? data
    : {};
}

// ========================================
// GENERAL HELPERS
// ========================================

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character];
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove("visible");
  }, 2600);
}

function showEmpty(container, title, message, buttonText, viewName) {
  const button = buttonText && viewName
    ? `<button class="button secondary" data-view="${viewName}" type="button">${escapeHTML(buttonText)}</button>`
    : "";

  container.innerHTML = `
    <div class="empty-state">
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(message)}</p>
      ${button}
    </div>
  `;
}

function openExternalLink(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function getRepositoryName(issue) {
  if (issue.repository_url) {
    return issue.repository_url.replace(
      "https://api.github.com/repos/",
      ""
    );
  }

  return issue.html_url.split("/").slice(3, 5).join("/");
}

function getIssueKey(issue) {
  return String(issue.id || issue.html_url);
}

function isBeginnerLabel(issue) {
  return (issue.labels || []).some((label) =>
    BEGINNER_LABELS.includes(label.name.toLowerCase())
  );
}

function formatDate(dateString) {
  if (!dateString) return "Unknown date";

  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) return "Unknown date";

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function truncateText(text, maxLength = 180) {
  const cleanText = String(text || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleanText.length <= maxLength) return cleanText;

  return cleanText.slice(0, maxLength).trimEnd() + "...";
}

// ========================================
// SUITABILITY SCORE
// ========================================

// This is a transparent heuristic, not a true
// measurement of an issue's actual difficulty.

function calculateSuitability(issue) {
  let score = 0;
  const reasons = [];

  const labels = (issue.labels || []).map((label) =>
    label.name.toLowerCase()
  );

  if (labels.some((label) => BEGINNER_LABELS.includes(label))) {
    score += 40;
    reasons.push("Has a recognised beginner-friendly label.");
  } else {
    reasons.push("No recognised beginner label was found.");
  }

  const description = (issue.body || "").trim();

  if (description.length >= 150) {
    score += 20;
    reasons.push("Provides a reasonably detailed issue description.");
  } else if (description.length >= 50) {
    score += 12;
    reasons.push("Provides some context about the issue.");
  } else {
    reasons.push("The description is short; you may need more context.");
  }

  const updatedAt = new Date(issue.updated_at || issue.created_at);
  const daysSinceUpdate = (Date.now() - updatedAt.getTime()) / 86400000;

  if (Number.isFinite(daysSinceUpdate) && daysSinceUpdate <= 30) {
    score += 20;
    reasons.push("Updated within the last 30 days.");
  } else if (Number.isFinite(daysSinceUpdate) && daysSinceUpdate <= 90) {
    score += 10;
    reasons.push("Updated within the last 90 days.");
  } else {
    reasons.push("Check whether the issue is still active.");
  }

  const comments = Number(issue.comments || 0);

  if (comments > 0) {
    score += 20;
    reasons.push("Has discussion that may provide useful context.");
  } else {
    reasons.push("No comments yet; check the issue instructions carefully.");
  }

  return {
    score: Math.min(100, score),
    reasons
  };
}

// ========================================
// GITHUB SEARCH
// ========================================

function buildSearchQuery() {
  const keyword = keywordInput.value.trim();
  const language = languageInput.value;
  const difficulty = difficultyInput.value;
  const state = issueStateInput.value;
  const repository = repositoryInput.value.trim();

  const terms = ["is:issue"];

  if (state !== "all") {
    terms.push(`is:${state}`);
  }

  if (keyword) {
    // Quoted phrases are supported by GitHub search.
    terms.push(
      /\s/.test(keyword)
        ? `"${keyword.replace(/"/g, "")}"`
        : keyword.replace(/"/g, "")
    );
  }

  if (language) {
    terms.push(`language:${language}`);
  }

  if (repository) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
      throw new Error("Repository must use the format owner/repository.");
    }

    terms.push(`repo:${repository}`);
  }

  if (difficulty === "beginner") {
    terms.push('label:"good first issue"');
  } else if (difficulty === "good-first-issue") {
    terms.push('label:"good first issue"');
  } else if (difficulty === "help-wanted") {
    terms.push('label:"help wanted"');
  }

  return terms.join(" ");
}

function buildSearchURL(query, page) {
  const params = new URLSearchParams({
    q: query,
    per_page: String(PER_PAGE),
    page: String(page)
  });

  if (currentSort === "updated") {
    params.set("sort", "updated");
    params.set("order", "desc");
  } else if (currentSort === "comments") {
    params.set("sort", "comments");
    params.set("order", "desc");
  } else if (currentSort === "created") {
    params.set("sort", "created");
    params.set("order", "desc");
  }

  return `${API_URL}?${params.toString()}`;
}

async function fetchIssues(query, page, signal) {
  const response = await fetch(buildSearchURL(query, page), {
    headers: {
      Accept: "application/vnd.github+json"
    },
    signal
  });

  if (response.status === 403 || response.status === 429) {
    throw new Error(
      "GitHub API rate limit reached. Please wait a little before searching again."
    );
  }

  if (!response.ok) {
    if (response.status === 422) {
      throw new Error("GitHub rejected this search. Try simpler filters.");
    }

    throw new Error(`GitHub request failed (${response.status}).`);
  }

  const data = await response.json();

  return {
    issues: (data.items || []).filter((issue) => !issue.pull_request),
    totalCount: Number(data.total_count || 0),
    incomplete: Boolean(data.incomplete_results)
  };
}

function renderSearchState(message) {
  issuesContainer.innerHTML = `
    <div class="empty-state">
      <p>${escapeHTML(message)}</p>
    </div>
  `;
}

async function performSearch(append = false) {
  if (isLoading) return;

  let query;

  try {
    query = buildSearchQuery();
  } catch (error) {
    showToast(error.message);
    return;
  }

  const thisRequest = ++requestNumber;

  if (!append) {
    searchResults = [];
    currentPage = 1;
    currentQuery = query;
    currentSort = sortInput.value;
    hasMoreResults = false;
    renderSearchState("Searching GitHub...");
  }

  isLoading = true;
  loadMoreButton.disabled = true;
  loadMoreButton.textContent = "Loading...";
  resultSummary.textContent = "Contacting GitHub...";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const page = append ? currentPage + 1 : 1;
    const result = await fetchIssues(query, page, controller.signal);

    if (thisRequest !== requestNumber) return;

    const existingIds = new Set(searchResults.map(getIssueKey));
    const newIssues = result.issues.filter(
      (issue) => !existingIds.has(getIssueKey(issue))
    );

    searchResults.push(...newIssues);
    currentPage = page;

    // GitHub Search generally limits accessible results to
    // 1,000 per query, and API limits may be lower in practice.
    hasMoreResults =
      result.totalCount > currentPage * PER_PAGE &&
      currentPage * PER_PAGE < 1000 &&
      result.issues.length > 0;

    displaySearchResults();

    const incompleteText = result.incomplete
      ? " GitHub marked these results as incomplete."
      : "";

    resultSummary.textContent =
      `${searchResults.length} loaded · approximately ${result.totalCount.toLocaleString()} matching issues.` +
      incompleteText;

    if (newIssues.length === 0 && result.issues.length > 0 && append) {
      showToast("No new unique issues on this page. Try a different search.");
    }
  } catch (error) {
    if (thisRequest !== requestNumber) return;

    if (error.name === "AbortError") {
      resultSummary.textContent = "The request timed out.";
      renderSearchState("GitHub took too long to respond. Please try again.");
    } else {
      resultSummary.textContent = "Search failed.";
      renderSearchState(error.message);
    }
  } finally {
    clearTimeout(timeout);

    if (thisRequest === requestNumber) {
      isLoading = false;
      loadMoreButton.disabled = false;
      loadMoreButton.textContent = "Load more issues";
      loadMoreArea.classList.toggle(
        "hidden",
        !hasMoreResults || searchResults.length === 0
      );
    }
  }
}

// ========================================
// ISSUE CARD RENDERING
// ========================================

function makeIssueCard(issue, options = {}) {
  const savedIssues = getSavedIssues();
  const key = getIssueKey(issue);
  const saved = savedIssues.find((item) => getIssueKey(item) === key);
  const isSaved = Boolean(saved);
  const suitability = calculateSuitability(issue);
  const labels = (issue.labels || []).slice(0, 5);
  const repository = getRepositoryName(issue);
  const description = truncateText(issue.body, 180);
  const stage = saved?.stage || "Interested";

  const safeIssueUrl = /^https:\/\/github\.com\//.test(issue.html_url)
    ? issue.html_url
    : "#";

  const repositoryUrl = `https://github.com/${repository}`;
  const readmeUrl = `${repositoryUrl}#readme`;
  const contributingUrl = `${repositoryUrl}/blob/HEAD/CONTRIBUTING.md`;

  const labelHTML = labels.length
    ? labels.map((label) =>
        `<span class="label-chip">${escapeHTML(label.name)}</span>`
      ).join("")
    : '<span class="label-chip">No labels</span>';

  const reasonsHTML = suitability.reasons
    .map((reason) => `<li>${escapeHTML(reason)}</li>`)
    .join("");

  const showProgress = options.showProgress || isSaved;

  return `
    <article class="issue-card">
      <div class="score-row">
        <span class="score-badge">${suitability.score}/100 suitability</span>
        <span class="issue-meta">#${escapeHTML(issue.number)}</span>
      </div>

      <h3>
        <a href="${escapeHTML(safeIssueUrl)}"
           target="_blank" rel="noopener noreferrer">
          ${escapeHTML(issue.title)}
        </a>
      </h3>

      <p class="repository-name">${escapeHTML(repository)}</p>

      <p class="issue-description">
        ${escapeHTML(description || "No description provided. Read the issue carefully before choosing it.")}
      </p>

      <div class="score-row">
        <div class="score-track" aria-label="Suitability score">
          <div class="score-fill" style="width:${suitability.score}%"></div>
        </div>
      </div>

      <div class="suitability">
        <strong>Why this score?</strong>
        <ul>${reasonsHTML}</ul>
        <p class="issue-description">
          This is a rule-based guide, not a verified difficulty rating.
        </p>
      </div>

      <div class="label-list">${labelHTML}</div>

      <div class="issue-meta">
        <span>Updated ${escapeHTML(formatDate(issue.updated_at))}</span>
        <span>${Number(issue.comments || 0)} comments</span>
        <span>${issue.state === "closed" ? "Closed" : "Open"}</span>
      </div>

      <div class="repo-links">
        <a href="${escapeHTML(repositoryUrl)}" target="_blank" rel="noopener noreferrer">Repository</a>
        <a href="${escapeHTML(readmeUrl)}" target="_blank" rel="noopener noreferrer">README</a>
        <a href="${escapeHTML(contributingUrl)}" target="_blank" rel="noopener noreferrer">Contribution guide</a>
      </div>

      <div class="card-actions">
        <button class="button secondary" data-save="${escapeHTML(key)}" type="button">
          ${isSaved ? "Remove saved" : "Save issue"}
        </button>
        <a class="button primary" href="${escapeHTML(safeIssueUrl)}"
           target="_blank" rel="noopener noreferrer">View issue</a>
      </div>

      ${showProgress ? `
        <label for="stage-${escapeHTML(key)}">Contribution stage</label>
        <select class="stage-select" id="stage-${escapeHTML(key)}"
          data-stage="${escapeHTML(key)}">
          ${STAGES.map((item) =>
            `<option value="${item}" ${stage === item ? "selected" : ""}>${item}</option>`
          ).join("")}
        </select>
      ` : ""}
    </article>
  `;
}

function displaySearchResults() {
  if (!searchResults.length) {
    showEmpty(
      issuesContainer,
      "No issues found",
      "Try another keyword, remove a filter, or choose a different language.",
      "Clear filters",
      null
    );

    loadMoreArea.classList.add("hidden");
    return;
  }

  issuesContainer.innerHTML = searchResults
    .map((issue) => makeIssueCard(issue))
    .join("");

  loadMoreArea.classList.toggle("hidden", !hasMoreResults);
}

// ========================================
// SAVING AND PROGRESS TRACKING
// ========================================

function toggleSavedIssue(key) {
  const savedIssues = getSavedIssues();
  const index = savedIssues.findIndex((item) => getIssueKey(item) === key);

  if (index >= 0) {
    savedIssues.splice(index, 1);

    if (!setSavedIssues(savedIssues)) return;

    showToast("Issue removed from saved issues.");
  } else {
    const issue = searchResults.find((item) => getIssueKey(item) === key);

    if (!issue) {
      showToast("Search for this issue again before saving it.");
      return;
    }

    savedIssues.unshift({
      ...issue,
      stage: "Interested",
      savedAt: new Date().toISOString()
    });

    if (!setSavedIssues(savedIssues)) return;

    showToast("Issue saved.");
  }

  refreshPersonalViews();
  displaySearchResults();
}

function updateIssueStage(key, newStage) {
  if (!STAGES.includes(newStage)) return;

  const savedIssues = getSavedIssues();
  const issue = savedIssues.find((item) => getIssueKey(item) === key);

  if (!issue) {
    showToast("Save this issue before tracking its progress.");
    return;
  }

  issue.stage = newStage;

  if (!setSavedIssues(savedIssues)) return;

  refreshPersonalViews();
  showToast(`Progress updated: ${newStage}.`);
}

function renderSavedIssues() {
  const savedIssues = getSavedIssues();
  const container = $("#savedContainer");

  if (!savedIssues.length) {
    showEmpty(
      container,
      "No saved issues yet",
      "Explore GitHub and save an issue you'd like to work on.",
      "Explore issues",
      "explore"
    );
    return;
  }

  container.innerHTML = savedIssues
    .map((issue) => makeIssueCard(issue, { showProgress: true }))
    .join("");
}

function renderProgress() {
  const savedIssues = getSavedIssues();
  const container = $("#progressContainer");

  if (!savedIssues.length) {
    showEmpty(
      container,
      "Your progress starts here",
      "Save an issue first, then choose a stage to track your progress.",
      "Explore issues",
      "explore"
    );
    return;
  }

  const sorted = [...savedIssues].sort((a, b) =>
    STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage)
  );

  container.innerHTML = sorted
    .map((issue) => makeIssueCard(issue, { showProgress: true }))
    .join("");
}

// ========================================
// DASHBOARD
// ========================================

function renderDashboard() {
  const savedIssues = getSavedIssues();

  const count = (stage) =>
    savedIssues.filter((issue) => issue.stage === stage).length;

  $("#statSaved").textContent = savedIssues.length;
  $("#statPlanning").textContent =
    count("Interested") + count("Planning");
  $("#statWorking").textContent = count("Working");
  $("#statCompleted").textContent = count("Completed");

  const completed = count("Completed");
  const percentage = savedIssues.length
    ? Math.round((completed / savedIssues.length) * 100)
    : 0;

  $("#progressBar").style.width = `${percentage}%`;

  $("#progressSummary").textContent = savedIssues.length
    ? `${completed} of ${savedIssues.length} saved issues marked completed (${percentage}%).`
    : "Save an issue to begin tracking your journey.";
}

function refreshPersonalViews() {
  renderSavedIssues();
  renderDashboard();
  renderProgress();
}

// ========================================
// NAVIGATION
// ========================================

function navigateTo(viewName) {
  const allowedViews = [
    "explore",
    "saved",
    "dashboard",
    "progress",
    "checklist"
  ];

  if (!allowedViews.includes(viewName)) return;

  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("hidden", view.id !== `view-${viewName}`);
  });

  document.querySelectorAll("[data-view].nav-link").forEach((button) => {
    const active = button.dataset.view === viewName;

    button.classList.toggle("active", active);

    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  if (viewName === "saved") renderSavedIssues();
  if (viewName === "dashboard") renderDashboard();
  if (viewName === "progress") renderProgress();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ========================================
// THEME
// ========================================

function applyTheme(theme) {
  const light = theme === "light";

  document.body.classList.toggle("light-theme", light);
  $("#themeToggle").textContent = light ? "Dark mode" : "Light mode";
  $("#themeToggle").setAttribute(
    "aria-label",
    light ? "Switch to dark theme" : "Switch to light theme"
  );

  document.documentElement.style.colorScheme = light ? "light" : "dark";
}

function initializeTheme() {
  const storedTheme = readStorage(STORAGE_KEYS.theme, "dark");
  applyTheme(storedTheme === "light" ? "light" : "dark");
}

$("#themeToggle").addEventListener("click", () => {
  const nextTheme = document.body.classList.contains("light-theme")
    ? "dark"
    : "light";

  applyTheme(nextTheme);
  writeStorage(STORAGE_KEYS.theme, nextTheme);
});

// ========================================
// BEFORE YOU START CHECKLIST
// ========================================

function renderChecklist() {
  const state = getChecklistState();
  const checkboxes = document.querySelectorAll("[data-check]");
  let completed = 0;

  checkboxes.forEach((checkbox) => {
    checkbox.checked = state[checkbox.dataset.check] === true;

    if (checkbox.checked) completed++;
  });

  $("#checklistCount").textContent =
    `${completed} of ${checkboxes.length} completed`;
}

document.querySelectorAll("[data-check]").forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    const state = getChecklistState();
    state[checkbox.dataset.check] = checkbox.checked;

    if (writeStorage(STORAGE_KEYS.checklist, state)) {
      renderChecklist();
    }
  });
});

$("#resetChecklist").addEventListener("click", () => {
  if (!confirm("Reset all checklist items?")) return;

  if (writeStorage(STORAGE_KEYS.checklist, {})) {
    renderChecklist();
    showToast("Checklist reset.");
  }
});

// ========================================
// EVENT LISTENERS
// ========================================

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  currentSort = sortInput.value;
  performSearch(false);
});

sortInput.addEventListener("change", () => {
  currentSort = sortInput.value;
  performSearch(false);
});

$("#clearFilters").addEventListener("click", () => {
  keywordInput.value = "";
  languageInput.value = "";
  difficultyInput.value = "beginner";
  issueStateInput.value = "open";
  sortInput.value = "best-match";
  repositoryInput.value = "";

  currentSort = "best-match";
  performSearch(false);
});

loadMoreButton.addEventListener("click", () => {
  if (hasMoreResults && !isLoading) {
    performSearch(true);
  }
});

document.addEventListener("click", (event) => {
  const navigationButton = event.target.closest("[data-view]");

  if (navigationButton) {
    event.preventDefault();
    navigateTo(navigationButton.dataset.view);
    return;
  }

  const saveButton = event.target.closest("[data-save]");

  if (saveButton) {
    toggleSavedIssue(saveButton.dataset.save);
  }
});

document.addEventListener("change", (event) => {
  const stageSelect = event.target.closest("[data-stage]");

  if (stageSelect) {
    updateIssueStage(stageSelect.dataset.stage, stageSelect.value);
  }
});

// ========================================
// INITIALIZATION
// ========================================

function initializeApp() {
  initializeTheme();
  renderChecklist();
  refreshPersonalViews();

  // Start with the Explore view.
  navigateTo("explore");
}

initializeApp();