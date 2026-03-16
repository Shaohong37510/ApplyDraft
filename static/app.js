/* ═══════════════════════════════════════════════════════════
   ApplyDraft - Frontend
   ═══════════════════════════════════════════════════════════ */

let projects = [];
let activeProjectId = null;
let currentView = 'projects';
let globalConfig = {};
let _appLoaded = false;
let pendingTargets = []; // search results awaiting confirmation
let manualTargets = []; // manually added targets
let currentOnboardingStep = 1; // 1-9 (onboarding wizard)
let onboardingSearchResults = []; // search results during onboarding wizard
let _projectHomeSubView = null; // null | 'stats' | 'email' | 'customize'
let supabaseClient = null;
let accessToken = null;
let currentUser = null;
let currentEmailTpl = {}; // cached email template for confirmAndGenerate
let _homeTrackerData = []; // cached tracker for project home modals
let _homeProj = null;      // cached project data for project home modals

// ── Supabase Init ────────────────────────────────────────

async function waitForSupabaseSDK(timeout = 5000) {
  if (typeof supabase !== "undefined") return true;
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      if (typeof supabase !== "undefined") return resolve(true);
      if (Date.now() - start > timeout) return resolve(false);
      setTimeout(check, 100);
    };
    check();
  });
}

async function initSupabase() {
  try {
    const sdkReady = await waitForSupabaseSDK();
    if (!sdkReady) {
      console.warn("Supabase SDK failed to load from CDN — running in demo mode");
      return null;
    }
    const res = await fetch("/api/config/public");
    const cfg = await res.json();
    if (!cfg.supabase_url || !cfg.supabase_anon_key) {
      console.warn("Supabase not configured — running in demo mode");
      return null;
    }
    return supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
  } catch (e) {
    console.warn("Failed to fetch config:", e);
    return null;
  }
}

// ── Template display helper ───────────────────────────────

function extractEditableContent(html) {
  if (!html || !html.toLowerCase().includes('<html')) return html;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return html;
  let body = bodyMatch[1];
  body = body.replace(/<br\s*\/?>/gi, '\n');
  body = body.replace(/<\/(p|div|h[1-6]|li)>/gi, '\n');
  body = body.replace(/<(p|div|h[1-6]|li)[^>]*>/gi, '');
  body = body.replace(/<[^>]+>/g, '');
  body = body.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  body = body.split('\n').map(l => l.trim()).join('\n');
  body = body.replace(/\n{3,}/g, '\n\n');
  return body.trim();
}

async function apiOpenPdf(path) {
  const res = await fetch("/api" + path, {
    headers: accessToken ? { "Authorization": `Bearer ${accessToken}` } : {}
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

async function apiDownloadPdf(path, filename) {
  try {
    const res = await fetch("/api" + path, {
      headers: accessToken ? { "Authorization": `Bearer ${accessToken}` } : {}
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Request failed");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── API helpers ───────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (accessToken) {
    opts.headers["Authorization"] = `Bearer ${accessToken}`;
  }
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch("/api" + path, opts);
  if (res.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      opts.headers["Authorization"] = `Bearer ${accessToken}`;
      const retry = await fetch("/api" + path, opts);
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({ detail: retry.statusText }));
        throw new Error(err.detail || "Request failed");
      }
      return retry.json();
    }
    showLogin();
    throw new Error("Session expired. Please sign in again.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

async function uploadFile(path, file) {
  const fd = new FormData();
  fd.append("file", file);
  const headers = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const res = await fetch("/api" + path, { method: "POST", body: fd, headers });
  if (!res.ok) throw new Error("Upload failed");
  return res.json();
}

// ── Auth: Login / Logout / Session ───────────────────────

async function loginWithGoogle() {
  if (!supabaseClient) { toast("Supabase not configured", "error"); return; }
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin }
  });
  if (error) toast(error.message, "error");
}

async function loginWithMicrosoft() {
  if (!supabaseClient) { toast("Supabase not configured", "error"); return; }
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "azure",
    options: {
      redirectTo: window.location.origin,
      scopes: "openid profile email"
    }
  });
  if (error) toast(error.message, "error");
}

async function logout() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  accessToken = null;
  currentUser = null;
  _appLoaded = false;
  showLogin();
}

async function refreshSession() {
  if (!supabaseClient) return false;
  const { data, error } = await supabaseClient.auth.refreshSession();
  if (error || !data.session) return false;
  accessToken = data.session.access_token;
  return true;
}

function hideLoading() {
  const el = document.getElementById("loadingScreen");
  if (el) el.style.display = "none";
}

function showLanding() {
  hideLoading();
  const landingPage = document.getElementById("landingPage");
  const loginPage = document.getElementById("loginPage");
  const appContainer = document.getElementById("appContainer");
  if (landingPage) landingPage.style.display = "";
  if (loginPage) loginPage.style.display = "none";
  if (appContainer) appContainer.style.display = "none";
}

function showLogin() {
  hideLoading();
  const landingPage = document.getElementById("landingPage");
  const loginPage = document.getElementById("loginPage");
  const appContainer = document.getElementById("appContainer");
  if (landingPage) landingPage.style.display = "none";
  if (loginPage) loginPage.style.display = "";
  if (appContainer) appContainer.style.display = "none";
}

function showLoginFromLanding() {
  showLogin();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── About / Info Page ─────────────────────────────────────

let _aboutReturnState = null; // tracks where to go back to

function showAboutPage(section) {
  const about = document.getElementById("aboutPage");
  const landing = document.getElementById("landingPage");
  const login = document.getElementById("loginPage");
  const app = document.getElementById("appContainer");
  // remember current state for back button
  _aboutReturnState = landing?.style.display !== "none" ? "landing"
    : login?.style.display !== "none" ? "login"
    : "app";
  if (landing) landing.style.display = "none";
  if (login) login.style.display = "none";
  if (app) app.style.display = "none";
  if (about) about.style.display = "";
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (section) {
    setTimeout(() => {
      const el = document.getElementById("about-" + section);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }
}

function hideAboutPage() {
  const about = document.getElementById("aboutPage");
  if (about) about.style.display = "none";
  if (_aboutReturnState === "landing") {
    showLanding();
  } else if (_aboutReturnState === "login") {
    showLogin();
  } else {
    const app = document.getElementById("appContainer");
    if (app) app.style.display = "";
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function submitContactForm(e) {
  e.preventDefault();
  const btn = document.getElementById("contactSubmitBtn");
  const result = document.getElementById("contactResult");
  btn.disabled = true;
  btn.textContent = "Sending...";
  result.style.display = "none";
  try {
    const res = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("contactName").value,
        email: document.getElementById("contactEmail").value,
        message: document.getElementById("contactMessage").value,
      }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      result.style.display = "";
      result.style.color = "#4ade80";
      result.textContent = "✓ Message sent! We'll get back to you within 24 hours.";
      document.getElementById("contactForm").reset();
    } else {
      throw new Error(data.detail || "Failed to send");
    }
  } catch (err) {
    result.style.display = "";
    result.style.color = "var(--orange)";
    result.textContent = "Failed to send: " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Message";
  }
}

function showApp() {
  hideLoading();
  const landingPage = document.getElementById("landingPage");
  const loginPage = document.getElementById("loginPage");
  const appContainer = document.getElementById("appContainer");
  if (landingPage) landingPage.style.display = "none";
  if (loginPage) loginPage.style.display = "none";
  if (appContainer) appContainer.style.display = "";
}

async function updateUserInfo() {
  try {
    const me = await api("GET", "/auth/me");
    currentUser = me;
    const creditsVal = Number(me.credits || 0);
    document.getElementById("creditsDisplay").textContent = `${creditsVal.toFixed(1)} credits`;
    document.getElementById("userEmail").textContent = me.gmail_email || me.outlook_email || me.user_id.slice(0, 8);
  } catch (e) {
    console.warn("Failed to get user info:", e);
  }
}

function updateCreditsDisplay(balance) {
  if (balance == null || isNaN(Number(balance))) return;
  const el = document.getElementById("creditsDisplay");
  if (el) el.textContent = `${Number(balance).toFixed(1)} credits`;
}

function buyCredits() {
  const modal = document.getElementById("creditModal");
  modal.style.cssText = "display:flex!important; position:fixed!important; top:0!important; left:0!important; width:100%!important; height:100%!important; background:rgba(0,0,0,.65)!important; z-index:9999!important; align-items:center!important; justify-content:center!important;";
}

function closeCreditModal(e) {
  if (e.target.id === "creditModal") {
    document.getElementById("creditModal").style.cssText = "display:none!important;";
  }
}

async function purchaseCredits(credits) {
  document.getElementById("creditModal").style.display = "none";
  try {
    const { checkout_url } = await api("POST", "/stripe/checkout", { credits });
    window.open(checkout_url, "_blank");
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Toast ─────────────────────────────────────────────────

function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Init ──────────────────────────────────────────────────

async function init() {
  supabaseClient = await initSupabase();

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("payment") === "success") {
    toast("Payment successful! Credits added.");
    window.history.replaceState({}, "", "/");
  } else if (urlParams.get("payment") === "cancelled") {
    toast("Payment cancelled", "error");
    window.history.replaceState({}, "", "/");
  }

  if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN') {
        accessToken = session.access_token;
        showApp();
        await loadApp();
      } else if (event === 'TOKEN_REFRESHED' && session) {
        accessToken = session.access_token; // just update token, don't reset view
      } else if (!session) {
        accessToken = null;
        showLanding();
      }
    });

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      accessToken = session.access_token;
      showApp();
      await loadApp();
    } else {
      // Guest: show landing page first; "Get Started Free" will call showApp()
      showLanding();
    }
  } else {
    showApp();
    await loadApp();
  }
}

// ── OAuth popup message handler ───────────────────────────
// Replaces the old location.reload() approach so onboarding state
// (currentOnboardingStep, activeProjectId, currentView) is preserved.
window.addEventListener('message', async (event) => {
  let data;
  try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
  if (!data || data.type !== 'oauth_complete') return;

  // Refresh global config so connected email shows up immediately
  globalConfig = await api("GET", "/global-config").catch(() => globalConfig);

  // Re-render current view in place — no page reload
  if (currentView === 'viewOnboarding' && activeProjectId) {
    await renderOnboarding(activeProjectId);
  } else if (currentView === 'viewEdit' && activeProjectId) {
    await renderEditView(activeProjectId);
  } else if (currentView === 'viewProjectHome' && activeProjectId) {
    await renderProjectHome(activeProjectId);
  }

  toast('Email account connected!');
});

async function loadApp() {
  try {
    await updateUserInfo();
  } catch (e) {
    console.error("updateUserInfo failed:", e);
  }
  try {
    globalConfig = await api("GET", "/global-config");
  } catch (e) {
    console.error("load global-config failed:", e);
    globalConfig = {};
  }
  try {
    projects = await api("GET", "/projects");
  } catch (e) {
    console.error("load projects failed:", e);
    projects = [];
  }
  if (!_appLoaded) {
    _appLoaded = true;
    navigateToProjects();
  }
}

// ── Top Bar Project Selector ──────────────────────────────

function updateTopBarSelect() {
  const el = document.getElementById('topBarProjectName');
  if (!el) return;
  if (!activeProjectId) { el.style.display = 'none'; return; }
  // Use projects[] first; fall back to _homeProj if list doesn't have it yet
  const proj = projects.find(p => String(p.id) === String(activeProjectId))
             || (_homeProj && String(_homeProj.id) === String(activeProjectId) ? _homeProj : null);
  const name = proj ? proj.name : '';
  if (!name) { el.style.display = 'none'; return; }

  const homeBtn = `<button class="btn-breadcrumb" onclick="navigateToProjects()">My Projects</button>`;
  const sep = `<span class="breadcrumb-sep">/</span>`;
  const projBtn = `<button class="btn-breadcrumb" onclick="navigateToProjectHome('${activeProjectId}')">${esc(name)}</button>`;

  let html;
  if (currentView === 'viewProjectHome') {
    const subLabels = { stats: ' — Statistics', email: ' — Email Preview', customize: ' — Customize Files' };
    const subLabel = _projectHomeSubView ? (subLabels[_projectHomeSubView] || '') : '';
    html = homeBtn + sep + `<span class="breadcrumb-current">${esc(name)}${subLabel}</span>`;
  } else if (currentView === 'viewStartApply') {
    html = homeBtn + sep + projBtn + sep + `<span class="breadcrumb-current">Start Apply</span>`;
  } else if (currentView === 'viewEdit') {
    html = homeBtn + sep + projBtn + sep + `<span class="breadcrumb-current">Edit Settings</span>`;
  } else if (currentView === 'viewOnboarding') {
    html = homeBtn + sep + `<span class="breadcrumb-current">${esc(name)} — Setup</span>`;
  } else {
    html = homeBtn + sep + `<span class="breadcrumb-current">${esc(name)}</span>`;
  }

  el.innerHTML = html;
  el.style.display = '';
}

// ── View Navigation ───────────────────────────────────────

function showView(viewId) {
  ['viewProjectsList', 'viewProjectHome', 'viewStartApply', 'viewEdit', 'viewOnboarding'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const target = document.getElementById(viewId);
  if (target) target.style.display = '';
  currentView = viewId;
  const backBtn = document.getElementById('topBarBack');
  if (backBtn) backBtn.style.display = (viewId === 'viewProjectsList') ? 'none' : '';
}

function navigateBack() {
  if (currentView === 'viewProjectHome') {
    navigateToProjects();
  } else if (currentView === 'viewStartApply' || currentView === 'viewEdit') {
    navigateToProjectHome(activeProjectId);
  } else if (currentView === 'viewOnboarding') {
    navigateToProjects();
  }
}

function navigateToProjects() {
  showView('viewProjectsList');
  updateTopBarSelect();
  renderProjectsList();
}

async function navigateToProjectHome(id) {
  activeProjectId = id;
  _projectHomeSubView = null;
  // If onboarding not complete, redirect to setup wizard
  const cachedProj = projects.find(p => p.id === id);
  if (cachedProj && !cachedProj.onboarding_complete) {
    return navigateToOnboarding(id);
  }
  showView('viewProjectHome');
  updateTopBarSelect();
  await renderProjectHome(id);
}

async function navigateToHomeSubView(id, subView) {
  activeProjectId = id;
  _projectHomeSubView = subView;
  updateTopBarSelect();
  await renderProjectHome(id);
}

async function navigateToStartApply(id) {
  activeProjectId = id;
  showView('viewStartApply');
  updateTopBarSelect();
  await renderStartApply(id);
}

async function navigateToEdit(id, section) {
  activeProjectId = id;
  showView('viewEdit');
  updateTopBarSelect();
  await renderEditView(id);
  updateTopBarSelect(); // refresh after async render in case something cleared it
  if (section) {
    setTimeout(() => {
      const el = document.querySelector(`[data-section="${section}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }, 150);
  }
}

// ── Projects List ─────────────────────────────────────────

function renderProjectsList() {
  const grid = document.getElementById('projectsGrid');
  if (!grid) return;

  const cards = projects.map(p => `
    <div class="project-card" onclick="navigateToProjectHome('${p.id}')">
      <button class="project-card-delete" onclick="event.stopPropagation();confirmDeleteProject('${p.id}','${esc(p.name)}')" title="Delete project">×</button>
      <div class="project-card-name">${esc(p.name)}</div>
      ${p.job_requirements ? `<div class="project-card-subtitle">${esc(p.job_requirements)}</div>` : ''}
      <div class="project-card-count">${p.tracker_count || 0} application${(p.tracker_count || 0) !== 1 ? 's' : ''}</div>
    </div>
  `).join('');

  const newCard = `
    <div class="project-card project-card-new" onclick="promptNewProject()">
      <div class="project-card-new-icon">+</div>
      <div class="project-card-new-label">New Project</div>
    </div>
  `;

  grid.innerHTML = cards + newCard;
}

// ── Project Home ──────────────────────────────────────────

async function renderProjectHome(id) {
  const page = document.getElementById('projectHomePage');
  if (!page) return;
  page.innerHTML = '<div class="view-loading">Loading...</div>';
  try {
    switch (_projectHomeSubView) {
      case 'stats':      await renderProjectHomeStats(id, page); break;
      case 'email':      await renderProjectHomeEmail(id, page); break;
      case 'email-edit': await renderProjectHomeEmailEdit(id, page); break;
      case 'customize':  await renderProjectHomeCustomize(id, page); break;
      case 'profile':    await renderProjectHomeProfile(id, page); break;
      default:           await renderProjectHomeMain(id, page);
    }
  } catch (e) {
    page.innerHTML = `<div class="view-error">Failed to load: ${esc(e.message)}</div>`;
  }
}

// ── Project Home: Main (button list) ──────────────────────

async function renderProjectHomeMain(id, page) {
  const [proj, trackerData] = await Promise.all([
    api("GET", `/projects/${id}`),
    api("GET", `/projects/${id}/tracker`).catch(() => [])
  ]);
  _homeTrackerData = trackerData;
  _homeProj = proj;

  const cfg = proj.config || {};
  const total = trackerData.length;
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thisWeek = trackerData.filter(r => r.AppliedDate && new Date(r.AppliedDate) >= weekAgo).length;
  const generated = trackerData.filter(r => r.Status === 'Generated').length;
  const jobReq = (cfg.job_requirements || '').split('\n')[0].trim();

  page.innerHTML = `
    <div class="project-home-content">

      <div class="project-home-header">
        <div class="project-home-title-row">
          <span class="project-home-title" id="projTitleDisplay">${esc(cfg.project_name || id)}</span>
          <button class="btn-edit-proj-name" data-proj-id="${esc(id)}" data-proj-name="${esc(cfg.project_name || id)}" onclick="startRenameProject(this)" title="Rename project">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
        </div>
        ${jobReq ? `<div class="project-home-desc">${esc(jobReq)}</div>` : ''}
      </div>

      <div class="home-nav-list">

        <div class="home-nav-item" onclick="navigateToHomeSubView('${id}', 'profile')">
          <span class="home-nav-icon">👤</span>
          <div class="home-nav-info">
            <div class="home-nav-title">Personal Info</div>
            <div class="home-nav-sub">${cfg.name ? esc(cfg.name) : 'Name, phone, email, address'}</div>
          </div>
          <span class="home-nav-arrow">›</span>
        </div>

        <div class="home-nav-item" onclick="navigateToHomeSubView('${id}', 'stats')">
          <span class="home-nav-icon">📊</span>
          <div class="home-nav-info">
            <div class="home-nav-title">Statistics</div>
            <div class="home-nav-sub">${total} total · ${thisWeek} this week · ${generated} generated</div>
          </div>
          <span class="home-nav-arrow">›</span>
        </div>

        <div class="home-nav-item" onclick="navigateToHomeSubView('${id}', 'email')">
          <span class="home-nav-icon">✉️</span>
          <div class="home-nav-info">
            <div class="home-nav-title">Email Preview</div>
            <div class="home-nav-sub">View subject, body and attachments</div>
          </div>
          <span class="home-nav-arrow">›</span>
        </div>

        <div class="home-nav-item" onclick="navigateToHomeSubView('${id}', 'customize')">
          <span class="home-nav-icon">📝</span>
          <div class="home-nav-info">
            <div class="home-nav-title">Customize Files</div>
            <div class="home-nav-sub">Cover letter templates and custom content</div>
          </div>
          <span class="home-nav-arrow">›</span>
        </div>

        <div class="home-nav-item" onclick="openTableModal()">
          <span class="home-nav-icon">📋</span>
          <div class="home-nav-info">
            <div class="home-nav-title">Application Table</div>
            <div class="home-nav-sub">${total} records</div>
          </div>
          <span class="home-nav-arrow">›</span>
        </div>

        <div class="home-nav-item" onclick="openFilesModal('${id}')">
          <span class="home-nav-icon">📁</span>
          <div class="home-nav-info">
            <div class="home-nav-title">Generated Files</div>
            <div class="home-nav-sub">Cover letters &amp; email drafts</div>
          </div>
          <span class="home-nav-arrow">›</span>
        </div>

      </div>

      <div class="home-action-row">
        <button class="btn-start-apply btn-start-apply-compact" onclick="navigateToStartApply('${id}')">
          ▶ &nbsp;Start Search &amp; Add Jobs
        </button>
      </div>

    </div>
  `;
}

// ── Project Home: Stats sub-view ──────────────────────────

async function renderProjectHomeStats(id, page) {
  const [, trackerData] = await Promise.all([
    _homeProj || api("GET", `/projects/${id}`),
    _homeTrackerData.length ? Promise.resolve(_homeTrackerData) : api("GET", `/projects/${id}/tracker`).catch(() => [])
  ]);
  _homeTrackerData = Array.isArray(trackerData) ? trackerData : _homeTrackerData;

  const total = _homeTrackerData.length;
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thisWeek = _homeTrackerData.filter(r => r.AppliedDate && new Date(r.AppliedDate) >= weekAgo).length;
  const generated = _homeTrackerData.filter(r => r.Status === 'Generated').length;
  const chartData = buildDailyChart(_homeTrackerData, 30);
  const chartSvg = buildLineChartSVG(chartData);

  page.innerHTML = `
    <div class="project-home-content">
      <div class="sub-view-header">
        <button class="btn-back-sub" onclick="navigateToHomeSubView('${id}', null)">← Back</button>
        <h2 class="sub-view-title">Statistics</h2>
      </div>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value">${total}</div>
          <div class="stat-label">TOTAL</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${thisWeek}</div>
          <div class="stat-label">THIS WEEK</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${generated}</div>
          <div class="stat-label">GENERATED</div>
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-title">Daily Applications — Last 30 Days</div>
        <div class="chart-container">${chartSvg}</div>
      </div>
    </div>
  `;
}

// ── Project Home: Email preview sub-view ──────────────────

async function renderProjectHomeEmail(id, page) {
  const [proj, emailTpl] = await Promise.all([
    _homeProj || api("GET", `/projects/${id}`),
    api("GET", `/projects/${id}/email-template`).catch(() => ({}))
  ]);
  const cfg = (proj && proj.config) ? proj.config : {};
  const connectedEmail = globalConfig.gmail_email || globalConfig.outlook_email || '';
  const customizeFiles = cfg.customize_files || [];
  const attachableFiles = customizeFiles.filter(cf => cf.id !== 'email_body' && cf.is_attachment !== false);
  const materials = (proj && proj.materials) ? proj.materials : [];

  const attachmentChips = [
    ...materials.map(f => `<span class="attachment-chip">📎 ${esc(f)}</span>`),
    ...attachableFiles.map(f => `<span class="attachment-chip generated-chip">📄 ${esc(f.label)} (generated)</span>`)
  ].join('') || `<span class="text-muted">No attachments configured</span>`;

  const bodyPreview = (() => {
    if (emailTpl.example) return emailTpl.example.trim();
    if (!emailTpl.template) return '(No email template yet — go to Edit Settings → Email Template to set one)';
    let src = emailTpl.template;
    src = src.replace(/<style[\s\S]*?<\/style>/gi, '');
    src = src.replace(/<head[\s\S]*?<\/head>/gi, '');
    return src.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  })();

  const subjectPreview = emailTpl.subject_template || 'Application for {{POSITION}} - {{NAME}}';

  page.innerHTML = `
    <div class="project-home-content">
      <div class="sub-view-header">
        <button class="btn-back-sub" onclick="navigateToHomeSubView('${id}', null)">← Back</button>
        <h2 class="sub-view-title">Email Preview</h2>
      </div>

      <div class="email-preview-card">
        <div class="email-field-row">
          <span class="email-field-label">Subject</span>
          <span class="email-field-value">${esc(subjectPreview)}</span>
          <button class="btn-edit-field" onclick="navigateToHomeSubView('${id}', 'email-edit')" title="Edit subject"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
        </div>
        <div class="email-field-row">
          <span class="email-field-label">From</span>
          <span class="email-field-value">${connectedEmail ? esc(connectedEmail) : '<em style="color:var(--orange)">Not connected</em>'}</span>
          <button class="btn-edit-field" onclick="navigateToEdit('${id}', 'global')" title="Edit email account"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
        </div>
        <div class="email-field-row email-field-body">
          <span class="email-field-label">Body</span>
          <textarea class="email-field-value email-body-preview" readonly rows="5" style="resize:vertical;line-height:1.6;word-break:break-word;background:transparent;border:none;width:100%;outline:none;cursor:default;color:inherit;font:inherit;padding:0">${esc(bodyPreview)}</textarea>
          <button class="btn-edit-field" onclick="navigateToHomeSubView('${id}', 'email-edit')" title="Edit body"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
        </div>
        <div class="email-field-row">
          <span class="email-field-label">Attachments</span>
          <div class="email-attachments-list">${attachmentChips}</div>
          <button class="btn-edit-field" onclick="navigateToEdit('${id}', 'project')" title="Edit attachments"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
        </div>
      </div>

      <div style="margin-top:14px">
        <button class="btn btn-secondary" onclick="navigateToHomeSubView('${id}', 'email-edit')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>Edit Email Template
        </button>
      </div>
    </div>
  `;
}

// ── Project Home: Customize files sub-view ────────────────

async function renderProjectHomeCustomize(id, page) {
  const proj = await api("GET", `/projects/${id}`);
  const cfg = proj.config || {};
  const tpls = proj.templates || {};
  const customizeFiles = cfg.customize_files || [];

  const examplesMap = {};
  await Promise.all(customizeFiles.map(async (cf) => {
    examplesMap[cf.id] = await api("GET", `/projects/${id}/customize/${cf.id}/examples`).catch(() => []);
  }));

  let customizeHtml = "";
  customizeFiles.filter(cf => cf.id !== "email_body").forEach((cf) => {
    const typeExamples = examplesMap[cf.id] || [];
    const typeTpl = tpls[cf.id] || {};
    const tplText = typeTpl.template || "";
    const defsText = (typeTpl.definitions || "")
      .replace(/^Prompt:/gm, 'PROMPT:')
      .replace(/^Examples:/gm, 'EXAMPLES:')
      .replace(/^Constrains:/gm, 'CONSTRAINTS:');
    const inputId = `exInput_${cf.id}`;
    const fnFmt = cf.filename_format || "";

    customizeHtml += `
      <div class="customize-card" data-type-id="${esc(cf.id)}">
        <div class="customize-card-header">
          <span class="customize-card-title">${esc(cf.label)}</span>
          <span class="customize-card-remove" onclick="removeCustomizeFile('${id}','${esc(cf.id)}','${esc(cf.label)}')" title="Remove">&times;</span>
        </div>

        <label>File Name Format</label>
        <div class="filename-format-row">
          <input type="text" id="fnFmt_${cf.id}" value="${esc(fnFmt)}"
            placeholder="{{NAME}}-{{FIRM_NAME}}-${esc(cf.label)}">
          <button class="btn btn-secondary btn-sm" onclick="saveTypeFilenameFormat('${id}','${esc(cf.id)}')" title="Save">Save</button>
        </div>
        <div class="format-hint">Available: {{NAME}}, {{FIRM_NAME}}, {{POSITION}}, {{EMAIL}}</div>

        <label>Examples (upload 2-3 for AI analysis)</label>
        <div class="file-list">
          ${typeExamples.map(f => `
            <span class="file-chip">
              &#128196; ${esc(f)}
              <span class="remove" onclick="deleteTypeExample('${id}','${esc(cf.id)}','${esc(f)}')">&times;</span>
            </span>
          `).join("")}
        </div>
        <div class="upload-area" onclick="document.getElementById('${inputId}').click()">
          <input type="file" id="${inputId}" multiple accept=".txt,.pdf,.docx" onchange="uploadTypeExamples('${id}','${esc(cf.id)}', this.files)">
          <p>+ Upload example ${esc(cf.label.toLowerCase())} files (.txt recommended)</p>
        </div>

        <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <button class="btn btn-primary btn-sm" onclick="generateTypeTemplate('${id}','${esc(cf.id)}')">
            &#9998; Generate Template
          </button>
          <button class="btn btn-secondary btn-sm" onclick="previewTypeTemplate('${id}','${esc(cf.id)}')">
            &#128065; Preview PDF
          </button>
          <span class="preview-path" id="previewPath_${cf.id}"></span>
        </div>

        <label>Template</label>
        <textarea class="tpl-textarea" id="tpl-${esc(cf.id)}" rows="10">${esc(extractEditableContent(tplText))}</textarea>

        <label>Custom Definitions</label>
        <textarea class="tpl-textarea" id="def-${esc(cf.id)}" rows="6">${esc(defsText)}</textarea>

        <div style="margin-top:8px">
          <button class="btn btn-secondary btn-sm" onclick="saveTemplate('${id}','${esc(cf.id)}')">Save Template</button>
        </div>
      </div>
    `;
  });

  page.innerHTML = `
    <div class="project-home-content">
      <div class="sub-view-header">
        <button class="btn-back-sub" onclick="navigateToHomeSubView('${id}', null)">← Back</button>
        <h2 class="sub-view-title">Customize Files</h2>
      </div>
      <div class="customize-section">
        ${customizeHtml || '<div class="empty-state"><p>No file types configured.</p></div>'}
        <button class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="promptAddCustomizeFile('${id}').then(()=>navigateToHomeSubView('${id}','customize'))">+ Add File Type</button>
      </div>
    </div>
  `;
}

// ── Project Home: Profile sub-view ────────────────────────

async function renderProjectHomeProfile(id, page) {
  const proj = await api("GET", `/projects/${id}`).catch(() => ({ config: {} }));
  const cfg = proj.config || {};
  page.innerHTML = `
    <div class="project-home-content">
      <div class="sub-view-header">
        <button class="btn-back-sub" onclick="navigateToHomeSubView('${id}', null)">← Back</button>
        <h2 class="sub-view-title">Personal Info</h2>
      </div>
      <div class="customize-section">
        <div class="ob-form-grid" style="margin-top:8px">
          <div class="ob-field">
            <label>Full Name</label>
            <input type="text" id="profName" value="${esc(cfg.name || '')}" placeholder="e.g. Jane Smith">
          </div>
          <div class="ob-field">
            <label>Phone</label>
            <input type="tel" id="profPhone" value="${esc(cfg.phone || '')}" placeholder="e.g. 215-555-1234">
          </div>
          <div class="ob-field">
            <label>Personal Email</label>
            <input type="email" id="profEmail" value="${esc(cfg.personal_email || '')}" placeholder="e.g. jane@email.com">
          </div>
          <div class="ob-field">
            <label>Address</label>
            <input type="text" id="profAddress" value="${esc(cfg.address || '')}" placeholder="e.g. Philadelphia, PA">
          </div>
        </div>
        <div style="margin-top:16px">
          <button class="btn btn-primary btn-sm" onclick="saveProfileInfo('${id}')">Save</button>
        </div>
      </div>
    </div>
  `;
}

async function saveProfileInfo(id) {
  try {
    await api("PUT", `/projects/${id}/config`, {
      name: document.getElementById('profName')?.value || '',
      phone: document.getElementById('profPhone')?.value || '',
      personal_email: document.getElementById('profEmail')?.value || '',
      address: document.getElementById('profAddress')?.value || '',
    });
    toast('Saved');
    await navigateToHomeSubView(id, null);
  } catch (e) { toast(e.message, 'error'); }
}

// ── Project Home: Email Edit sub-view ─────────────────────

async function renderProjectHomeEmailEdit(id, page) {
  const emailTpl = await api("GET", `/projects/${id}/email-template`).catch(() => ({}));
  const tplText = extractEditableContent(emailTpl.template || '');
  const defsText = (emailTpl.definitions || '')
    .replace(/^Prompt:/gm, 'PROMPT:')
    .replace(/^Examples:/gm, 'EXAMPLES:')
    .replace(/^Constrains:/gm, 'CONSTRAINTS:');

  page.innerHTML = `
    <div class="project-home-content">
      <div class="sub-view-header">
        <button class="btn-back-sub" onclick="navigateToHomeSubView('${id}', 'email')">← Back</button>
        <h2 class="sub-view-title">Edit Email Template</h2>
      </div>
      <div class="customize-section">
        <label>Email Subject Template</label>
        <div class="subject-template-row">
          <input type="text" id="homeEmailSubject" value="${esc(emailTpl.subject_template || 'Application for {{POSITION}} - {{NAME}}')}">
        </div>
        <div class="format-hint">Available: {{NAME}}, {{FIRM_NAME}}, {{POSITION}}, {{EMAIL}}</div>

        <label style="margin-top:14px;display:block">Email Body Example</label>
        <textarea id="homeEmailExample" rows="6" placeholder="Dear Hiring Manager,&#10;&#10;I am writing to apply for...">${esc(emailTpl.example || '')}</textarea>

        <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
          <button class="btn btn-secondary btn-sm" onclick="homeEmailSaveExample('${id}')">Save</button>
          <button class="btn btn-primary btn-sm" onclick="homeEmailGenerate('${id}')">✎ Generate Template</button>
        </div>

        <label style="margin-top:16px;display:block">Template <span style="font-weight:400;opacity:.6;font-size:.85em">({{CUSTOM_1}}, {{CUSTOM_2}} written by AI per firm)</span></label>
        <textarea class="tpl-textarea" id="tpl-email_body" rows="8">${esc(tplText)}</textarea>

        <label style="margin-top:12px;display:block">AI Instructions</label>
        <textarea class="tpl-textarea" id="def-email_body" rows="5">${esc(defsText)}</textarea>

        <div style="margin-top:10px; display:flex; gap:8px;">
          <button class="btn btn-secondary btn-sm" onclick="saveTemplate('${id}','email_body')">Save Template</button>
        </div>
      </div>
    </div>
  `;
}

async function homeEmailSaveExample(id) {
  const text = document.getElementById('homeEmailExample')?.value.trim() || '';
  const subject = document.getElementById('homeEmailSubject')?.value.trim() || '';
  if (!text) { toast('Paste an email first', 'error'); return; }
  try {
    await api("POST", `/projects/${id}/email-template/save-example`, { text, subject_template: subject, smart_subject: false });
    toast('Saved');
  } catch (e) { toast(e.message, 'error'); }
}

async function homeEmailGenerate(id) {
  const text = document.getElementById('homeEmailExample')?.value.trim() || '';
  const subject = document.getElementById('homeEmailSubject')?.value.trim() || '';
  if (!text) { toast('Paste an email example first', 'error'); return; }
  try {
    await api("POST", `/projects/${id}/email-template/save-example`, { text, subject_template: subject, smart_subject: false });
    toast('Generating email template...', 'success');
    await api("POST", `/projects/${id}/email-template/generate`);
    toast('Email template generated!');
    await renderProjectHomeEmailEdit(id, document.getElementById('projectHomePage'));
  } catch (e) { toast(e.message, 'error'); }
}

function startRenameProject(btn) {
  const id = btn.dataset.projId;
  const currentName = btn.dataset.projName;
  const row = document.querySelector('.project-home-title-row');
  if (!row) return;
  row.innerHTML = `
    <input id="projNameInput" class="proj-name-input" value="${esc(currentName)}" maxlength="80"
      onkeydown="if(event.key==='Enter')saveRenameProject('${esc(id)}');if(event.key==='Escape')navigateToProjectHome('${esc(id)}')">
    <button class="btn-save-proj-name" onclick="saveRenameProject('${esc(id)}')">Save</button>
    <button class="btn-cancel-proj-name" onclick="navigateToProjectHome('${esc(id)}')">Cancel</button>
  `;
  document.getElementById('projNameInput').focus();
}

async function saveRenameProject(id) {
  const input = document.getElementById('projNameInput');
  if (!input) return;
  const newName = input.value.trim();
  if (!newName) { toast('Name cannot be empty', 'error'); return; }
  try {
    await api('PUT', `/projects/${id}/config`, { project_name: newName });
    // Update cached data
    if (_homeProj) _homeProj.name = newName;
    const p = projects.find(p => String(p.id) === String(id));
    if (p) p.name = newName;
    toast('Renamed');
    await navigateToProjectHome(id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Chart helpers ─────────────────────────────────────────

function buildDailyChart(trackerData, days) {
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const count = trackerData.filter(r => r.AppliedDate && r.AppliedDate.startsWith(dateStr)).length;
    result.push({ date: dateStr, count });
  }
  return result;
}

function buildLineChartSVG(data) {
  const w = 580, h = 110, padL = 28, padR = 8, padT = 8, padB = 28;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const maxVal = Math.max(...data.map(d => d.count), 1);
  const n = data.length;

  const pts = data.map((d, i) => {
    const x = padL + (n > 1 ? (i / (n - 1)) : 0.5) * innerW;
    const y = padT + innerH - (d.count / maxVal) * innerH;
    return [x, y];
  });

  const polyPts = pts.map(p => p.join(',')).join(' ');
  const areaPts = `${padL},${padT + innerH} ${polyPts} ${padL + innerW},${padT + innerH}`;

  // X-axis labels every 7 days
  const xLabels = data
    .map((d, i) => ({ d, i }))
    .filter(({ i }) => i % 7 === 0)
    .map(({ d, i }) => {
      const x = padL + (n > 1 ? (i / (n - 1)) : 0.5) * innerW;
      return `<text x="${x.toFixed(1)}" y="${h - 2}" class="chart-label">${d.date.slice(5)}</text>`;
    }).join('');

  // Y-axis labels
  const step = Math.ceil(maxVal / 3) || 1;
  const yLabels = [];
  for (let v = 0; v <= maxVal; v += step) {
    const y = padT + innerH - (v / maxVal) * innerH;
    yLabels.push(`<text x="${padL - 4}" y="${(y + 4).toFixed(1)}" class="chart-label" text-anchor="end">${v}</text>`);
  }

  // Dots for non-zero points
  const dots = pts
    .filter((_, i) => data[i].count > 0)
    .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="chart-dot"/>`)
    .join('');

  return `<svg viewBox="0 0 ${w} ${h}" class="line-chart-svg" preserveAspectRatio="none">
  <defs>
    <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#6c8cff" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#6c8cff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" class="chart-axis"/>
  <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" class="chart-axis"/>
  <polygon points="${areaPts}" fill="url(#chartGrad)"/>
  <polyline points="${polyPts}" class="chart-line" fill="none"/>
  ${dots}
  ${xLabels}
  ${yLabels.join('')}
</svg>`;
}

// ── Files Modal ───────────────────────────────────────────

function _fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function openFilesModal(id) {
  document.getElementById('filesModal')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'filesModal';
  overlay.innerHTML = `
    <div class="modal-panel modal-panel-wide">
      <div class="modal-header">
        <h3>📁 All Files</h3>
        <button class="modal-close" onclick="document.getElementById('filesModal').remove()">×</button>
      </div>
      <div class="modal-body" id="filesModalBody">
        <div class="view-loading">Loading...</div>
      </div>
    </div>
  `;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);

  await _refreshFilesModal(id);
}

async function _refreshFilesModal(id) {
  const body = document.getElementById('filesModalBody');
  if (!body) return;
  try {
    const [proj, files] = await Promise.all([
      _homeProj || api("GET", `/projects/${id}`),
      api("GET", `/projects/${id}/files`)
    ]);
    const materials = proj.materials || [];
    let html = '';

    // ── Uploaded Materials ──
    html += `<div class="files-section-title">Uploaded Materials</div>`;
    if (materials.length > 0) {
      html += materials.map(f => `
        <div class="file-list-row">
          <span class="file-list-icon">📎</span>
          <span class="file-list-name">${esc(f)}</span>
          <div class="file-list-actions">
            <button class="btn btn-sm btn-secondary" onclick="deleteMaterialRefresh('${id}','${esc(f)}')">Delete</button>
          </div>
        </div>
      `).join('');
    } else {
      html += `<div class="files-empty-note">No materials uploaded. Go to Edit Settings → Project to upload CV/Portfolio.</div>`;
    }

    // ── Cover Letters (PDF) ──
    html += `<div class="files-section-title" style="margin-top:20px">Cover Letters</div>`;
    if (files.pdf.length > 0) {
      html += files.pdf.map(f => `
        <div class="file-list-row">
          <span class="file-list-icon">📄</span>
          <span class="file-list-name">${esc(f.name)}<span class="file-size">${_fmtSize(f.size)}</span></span>
          <div class="file-list-actions">
            <button class="btn btn-sm btn-secondary" onclick="apiOpenPdf('/projects/${id}/output/pdf/${encodeURIComponent(f.name)}').catch(e=>toast(e.message,'error'))">Preview</button>
            <button class="btn btn-sm btn-secondary" onclick="apiDownloadPdf('/projects/${id}/output/pdf/${encodeURIComponent(f.name)}','${esc(f.name)}')">Download</button>
            <button class="btn btn-sm btn-danger" onclick="deleteOutputFile('${id}','pdf','${esc(f.name)}')">Delete</button>
          </div>
        </div>
      `).join('');
    } else {
      html += `<div class="files-empty-note">No cover letters generated yet.</div>`;
    }

    // ── Email Drafts (.eml) ──
    html += `<div class="files-section-title" style="margin-top:20px">Email Drafts (.eml)</div>`;
    if (files.eml.length > 0) {
      html += files.eml.map(f => `
        <div class="file-list-row">
          <span class="file-list-icon">✉️</span>
          <span class="file-list-name">${esc(f.name)}<span class="file-size">${_fmtSize(f.size)}</span></span>
          <div class="file-list-actions">
            <button class="btn btn-sm btn-secondary" onclick="apiDownloadPdf('/projects/${id}/output/eml/${encodeURIComponent(f.name)}','${esc(f.name)}')">Download</button>
            <button class="btn btn-sm btn-danger" onclick="deleteOutputFile('${id}','eml','${esc(f.name)}')">Delete</button>
          </div>
        </div>
      `).join('');
    } else {
      html += `<div class="files-empty-note">No email drafts generated yet.</div>`;
    }

    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red);padding:16px">${esc(e.message)}</div>`;
  }
}

async function deleteMaterialRefresh(id, filename) {
  await api("DELETE", `/projects/${id}/material/${encodeURIComponent(filename)}`);
  toast("File removed");
  await _refreshFilesModal(id);
}

async function deleteOutputFile(id, filetype, filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  try {
    await api("DELETE", `/projects/${id}/output/${filetype}/${encodeURIComponent(filename)}`);
    toast("Deleted");
    await _refreshFilesModal(id);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Table Modal ───────────────────────────────────────────

function openTableModal() {
  document.getElementById('tableModal')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'tableModal';
  overlay.innerHTML = `
    <div class="modal-panel modal-wide">
      <div class="modal-header">
        <h3>📊 Application Table</h3>
        <button class="modal-close" onclick="document.getElementById('tableModal').remove()">×</button>
      </div>
      <div class="modal-body modal-body-scroll">
        ${renderTrackerTable(_homeTrackerData)}
      </div>
    </div>
  `;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function renderTrackerTable(data) {
  if (!data || data.length === 0) {
    return `<div class="empty-state" style="padding:40px 0"><p>No applications recorded yet.</p></div>`;
  }
  const cols = ['Firm', 'Location', 'Position', 'OpenDate', 'AppliedDate', 'Email', 'Status'];
  return `
    <div class="tracker-table-wrap">
      <table class="tracker-table">
        <thead>
          <tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${data.map(row => `
            <tr>
              ${cols.map(c => `<td>${esc(row[c] || '')}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Start Apply ───────────────────────────────────────────

async function renderStartApply(id) {
  const page = document.getElementById('startApplyPage');
  if (!page) return;
  page.innerHTML = '<div class="view-loading">Loading...</div>';

  try {
    const proj = await api("GET", `/projects/${id}`);
    const cfg = proj.config || {};

    page.innerHTML = `
      <div class="start-apply-content">

        <!-- ─ Job Requirements & Search ─ -->
        <div class="apply-section">
          <h3 class="apply-section-title">Job Requirements & Search</h3>

          <label>Job Requirements (natural language)</label>
          <textarea id="projJobReq" rows="3"
            placeholder="e.g. Junior Architect positions in New York, 0-3 years experience, prefer cultural/museum projects"
          >${esc(cfg.job_requirements || '')}</textarea>

          <!-- Manual Entry -->
          <div class="manual-entry-section">
            <div class="manual-entry-toggle" onclick="toggleManualEntry()">
              <span class="arrow-icon">&#9654;</span>
              <span>&#43; Add Position Manually</span>
            </div>
            <div class="manual-entry-form" id="manualEntryForm">
              <div class="row">
                <div>
                  <label>Company Name *</label>
                  <input type="text" id="manualFirm" placeholder="e.g. Foster + Partners">
                </div>
                <div>
                  <label>Email *</label>
                  <input type="email" id="manualEmail" placeholder="careers@firm.com">
                </div>
              </div>
              <div class="row">
                <div>
                  <label>Position</label>
                  <input type="text" id="manualPosition" placeholder="e.g. Junior Architect">
                </div>
                <div>
                  <label>Location</label>
                  <input type="text" id="manualLocation" placeholder="e.g. New York, NY">
                </div>
              </div>
              <label>Website</label>
              <input type="text" id="manualWebsite" placeholder="https://www.firm.com">
              <div class="manual-entry-actions">
                <button class="btn btn-primary btn-sm" onclick="addManualEntry()">&#43; Add to Queue</button>
                <span style="font-size:12px;color:var(--text2)">Manual entries are prioritized during generation</span>
              </div>
            </div>
            <div class="manual-entries-list" id="manualEntriesList"></div>
          </div>

          <div id="runResults"></div>

          <div class="link-row" onclick="openTableModal()" style="margin-top:8px">
            <span class="icon">📊</span> View Generated Positions (${proj.tracker_count} records)
          </div>

        </div>

        <div class="search-action-row">
          <div class="count-selector">
            <label style="margin:0">Positions:</label>
            <select id="runCount">
              ${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}" ${n===5?"selected":""}>${n}</option>`).join("")}
            </select>
          </div>
          <button class="btn btn-run" id="runBtn" onclick="runSearch('${id}')">
            ▶ Search
          </button>
        </div>

      </div>
    `;

    renderManualEntries();

    if (pendingTargets.length > 0) {
      restoreSearchResults(id);
    }
  } catch (e) {
    page.innerHTML = `<div class="view-error">Failed to load: ${esc(e.message)}</div>`;
  }
}

// ── Edit View (Settings) ──────────────────────────────────

async function renderEditView(id) {
  const proj = await api("GET", `/projects/${id}`);
  const cfg = proj.config || {};
  const tpls = proj.templates || {};
  const customizeFiles = cfg.customize_files || [];

  const examplesMap = {};
  await Promise.all(customizeFiles.map(async (cf) => {
    examplesMap[cf.id] = await api("GET", `/projects/${id}/customize/${cf.id}/examples`).catch(() => []);
  }));

  const attachableFiles = customizeFiles.filter(cf => cf.id !== "email_body");
  let attachmentCheckboxes = attachableFiles.map(cf => {
    const checked = cf.is_attachment !== false ? "checked" : "";
    return `<label class="attach-check">
      <input type="checkbox" ${checked} onchange="toggleAttachment('${id}','${esc(cf.id)}',this.checked)">
      <span>${esc(cf.label)}</span>
    </label>`;
  }).join("");

  const emailTpl = await api("GET", `/projects/${id}/email-template`).catch(() => ({}));

  let customizeHtml = "";
  customizeFiles.filter(cf => cf.id !== "email_body").forEach((cf) => {
    const typeExamples = examplesMap[cf.id] || [];
    const typeTpl = tpls[cf.id] || {};
    const tplText = typeTpl.template || "";
    const defsText = (typeTpl.definitions || "")
      .replace(/^Prompt:/gm, 'PROMPT:')
      .replace(/^Examples:/gm, 'EXAMPLES:')
      .replace(/^Constrains:/gm, 'CONSTRAINTS:');
    const inputId = `exInput_${cf.id}`;
    const fnFmt = cf.filename_format || "";

    customizeHtml += `
      <div class="customize-card" data-type-id="${esc(cf.id)}">
        <div class="customize-card-header">
          <span class="customize-card-title">${esc(cf.label)}</span>
          <span class="customize-card-remove" onclick="removeCustomizeFile('${id}','${esc(cf.id)}','${esc(cf.label)}')" title="Remove">&times;</span>
        </div>

        <label>File Name Format</label>
        <div class="filename-format-row">
          <input type="text" id="fnFmt_${cf.id}" value="${esc(fnFmt)}"
            placeholder="{{NAME}}-{{FIRM_NAME}}-${esc(cf.label)}">
          <button class="btn btn-secondary btn-sm" onclick="saveTypeFilenameFormat('${id}','${esc(cf.id)}')" title="Save">Save</button>
        </div>
        <div class="format-hint">Available: {{NAME}}, {{FIRM_NAME}}, {{POSITION}}, {{EMAIL}}</div>

        <label>Examples (upload 2-3 for AI analysis)</label>
        <div class="file-list">
          ${typeExamples.map(f => `
            <span class="file-chip">
              &#128196; ${esc(f)}
              <span class="remove" onclick="deleteTypeExample('${id}','${esc(cf.id)}','${esc(f)}')">&times;</span>
            </span>
          `).join("")}
        </div>
        <div class="upload-area" onclick="document.getElementById('${inputId}').click()">
          <input type="file" id="${inputId}" multiple accept=".txt,.pdf,.docx" onchange="uploadTypeExamples('${id}','${esc(cf.id)}', this.files)">
          <p>+ Upload example ${esc(cf.label.toLowerCase())} files (.txt recommended)</p>
        </div>

        <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <button class="btn btn-primary btn-sm" onclick="generateTypeTemplate('${id}','${esc(cf.id)}')">
            &#9998; Generate Template
          </button>
          <button class="btn btn-secondary btn-sm" onclick="previewTypeTemplate('${id}','${esc(cf.id)}')">
            &#128065; Preview PDF
          </button>
          <span class="preview-path" id="previewPath_${cf.id}"></span>
        </div>

        <label>Template</label>
        <textarea class="tpl-textarea" id="tpl-${esc(cf.id)}" rows="10">${esc(extractEditableContent(tplText))}</textarea>

        <label>Custom Definitions</label>
        <textarea class="tpl-textarea" id="def-${esc(cf.id)}" rows="6">${esc(defsText)}</textarea>

        <div style="margin-top:8px">
          <button class="btn btn-secondary btn-sm" onclick="saveTemplate('${id}','${esc(cf.id)}')">Save Template</button>
        </div>
      </div>
    `;
  });

  document.getElementById("mainContent").innerHTML = `

  <!-- ═══ Section: Global Config ═══════════════════════════ -->
  <div class="section" data-section="global">
    <div class="section-header" onclick="toggleSection(this)">
      <h3><span>&#9881;</span> Global Settings</h3>
      <span class="arrow">&#9662;</span>
    </div>
    <div class="section-body">
      <label>Email Provider</label>
      <div class="email-provider-tabs" style="display:flex;gap:8px;margin-bottom:12px">
        <button class="btn btn-sm ${(globalConfig.email_provider || "gmail") === "gmail" ? "btn-primary" : "btn-secondary"}"
          onclick="switchEmailProvider('gmail')">Gmail</button>
        <button class="btn btn-sm ${globalConfig.email_provider === "outlook" ? "btn-primary" : "btn-secondary"}"
          onclick="switchEmailProvider('outlook')">Outlook</button>
        <button class="btn btn-sm ${globalConfig.email_provider === "none" ? "btn-primary" : "btn-secondary"}"
          onclick="switchEmailProvider('none')">None</button>
      </div>

      <div id="gmailSettings" style="display:${(globalConfig.email_provider || "gmail") === "gmail" ? "block" : "none"}">
        ${globalConfig.gmail_connected
          ? `<div style="display:flex;align-items:center;gap:12px;padding:10px;background:rgba(30,60,40,0.85);border:1px solid rgba(74,222,128,0.2);border-radius:6px">
              <span style="color:#4ade80;font-size:18px">&#10003;</span>
              <span>Connected: <strong>${esc(globalConfig.gmail_email || globalConfig.email || "")}</strong></span>
              <button class="btn btn-secondary btn-sm" onclick="disconnectGmail()" style="margin-left:auto">Disconnect</button>
            </div>`
          : `<button class="btn btn-primary btn-sm" onclick="connectGmail()">Connect Gmail Account</button>
             <div style="margin-top:6px;font-size:12px;color:#666">Connect your Gmail account via Google OAuth to create email drafts</div>`
        }
      </div>

      <div id="outlookSettings" style="display:${globalConfig.email_provider === "outlook" ? "block" : "none"}">
        ${globalConfig.outlook_connected
          ? `<div style="display:flex;align-items:center;gap:12px;padding:10px;background:rgba(30,60,40,0.85);border:1px solid rgba(74,222,128,0.2);border-radius:6px">
              <span style="color:#4ade80;font-size:18px">&#10003;</span>
              <span>Connected: <strong>${esc(globalConfig.outlook_email || "")}</strong></span>
              <button class="btn btn-secondary btn-sm" onclick="disconnectOutlook()" style="margin-left:auto">Disconnect</button>
            </div>`
          : `<button class="btn btn-primary btn-sm" onclick="connectOutlook()">Connect Outlook Account</button>
             <div style="margin-top:6px;font-size:12px;color:#666">Supports school (.edu) and personal Outlook accounts</div>`
        }
      </div>

      <div id="noneSettings" style="display:${globalConfig.email_provider === "none" ? "block" : "none"}">
        <div style="padding:10px;background:#fff3e0;border-radius:6px;font-size:13px;color:#e65100">
          Email drafts will not be created. Only PDFs will be generated.
        </div>
      </div>

      <input type="hidden" id="cfgEmailProvider" value="${esc(globalConfig.email_provider || "gmail")}">
      <div style="margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="saveGlobalConfig()">Save Global Settings</button>
      </div>
    </div>
  </div>

  <!-- ═══ Section: Project Config ══════════════════════════ -->
  <div class="section" data-section="project">
    <div class="section-header" onclick="toggleSection(this)">
      <h3><span>&#128221;</span> Project: ${esc(cfg.project_name || id)}</h3>
      <span class="arrow">&#9662;</span>
    </div>
    <div class="section-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-bottom:12px">
        <div>
          <label>Full Name</label>
          <input type="text" id="projName" value="${esc(cfg.name || '')}" placeholder="e.g. Jane Smith">
        </div>
        <div>
          <label>Phone</label>
          <input type="text" id="projPhone" value="${esc(cfg.phone || '')}" placeholder="e.g. 215-555-1234">
        </div>
        <div>
          <label>Personal Email</label>
          <input type="text" id="projPersonalEmail" value="${esc(cfg.personal_email || '')}" placeholder="e.g. jane@email.com">
        </div>
        <div>
          <label>Address</label>
          <input type="text" id="projAddress" value="${esc(cfg.address || '')}" placeholder="e.g. Philadelphia, PA">
        </div>
      </div>
      <label>Job Requirements (natural language)</label>
      <textarea id="projJobReq" rows="3" placeholder="e.g. Junior Architect positions in New York, 0-3 years experience, prefer cultural/museum projects">${esc(cfg.job_requirements || "")}</textarea>

      <label>Attachments (uploaded files)</label>
      <div class="file-list" id="materialList">
        ${(proj.materials || []).map(f => `
          <span class="file-chip">
            &#128206; ${esc(f)}
            <span class="remove" onclick="deleteMaterial('${id}','${esc(f)}')">&times;</span>
          </span>
        `).join("")}
      </div>
      <div class="upload-area" onclick="document.getElementById('materialInput').click()">
        <input type="file" id="materialInput" multiple accept=".pdf,.doc,.docx" onchange="uploadMaterials('${id}', this.files)">
        <p>+ Upload CV / Portfolio / Recommendation Letter</p>
      </div>

      ${attachableFiles.length > 0 ? `
      <label>Generated File Attachments</label>
      <div class="attach-list">${attachmentCheckboxes}</div>
      ` : ""}

      <div style="margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="saveProjectConfig('${id}')">Save</button>
      </div>

    </div>
  </div>

  <!-- ═══ Section: Customize Files ═════════════════════════ -->
  <div class="section" data-section="customize">
    <div class="section-header" onclick="toggleSection(this)">
      <h3><span>&#128203;</span> Customize Files</h3>
      <span class="arrow">&#9662;</span>
    </div>
    <div class="section-body">

      <div class="customize-files-header">
        <label style="margin:0">File Types</label>
        ${customizeFiles.length >= 4 ? "" : `<button class="btn btn-secondary btn-sm add-type-btn" onclick="promptAddCustomizeFile('${id}')">+ Add Type</button>`}
      </div>

      <div id="customizeFilesContainer">
        ${customizeHtml}
      </div>

      <div class="link-row" onclick="openFilesModal('${id}')" style="margin-top:8px">
        <span class="icon">&#128194;</span> View All Generated Files
      </div>

    </div>
  </div>

  <!-- ═══ Section: Email Template ══════════════════════════ -->
  <div class="section" data-section="email">
    <div class="section-header" onclick="toggleSection(this)">
      <h3><span>&#9993;</span> Email Template</h3>
      <span class="arrow">&#9662;</span>
    </div>
    <div class="section-body">
      <label>Email Subject Template</label>
      <div class="subject-template-row">
        <input type="text" id="emailSubjectTemplate" value="${esc(emailTpl.subject_template || "Application for {{POSITION}} - {{NAME}}")}"
          placeholder="Application for {{POSITION}} - {{NAME}}">
        <label class="smart-subject-toggle">
          <input type="checkbox" id="smartSubjectEnabled" ${emailTpl.smart_subject ? "checked" : ""}>
          <span>Smart Subject</span>
        </label>
      </div>
      <div class="format-hint">Available: {{NAME}}, {{FIRM_NAME}}, {{POSITION}}, {{EMAIL}}. When Smart Subject is enabled, each firm's career page will be searched during batch generation for required subject format.</div>

      <label>Paste an example email (full text)</label>
      <textarea id="emailExampleText" rows="6" placeholder="Dear Hiring Manager,&#10;&#10;I am writing to apply for...&#10;&#10;Best regards,&#10;Your Name">${esc(emailTpl.example || "")}</textarea>

      <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
        <button class="btn btn-secondary btn-sm" onclick="saveEmailExample('${id}')">Save</button>
        <button class="btn btn-primary btn-sm" onclick="generateEmailTemplate('${id}')">&#9998; Generate Template</button>
      </div>

      <label>Template</label>
      <textarea class="tpl-textarea" id="tpl-email_body" rows="10">${esc(extractEditableContent(emailTpl.template || ""))}</textarea>

      <label>Custom Definitions</label>
      <textarea class="tpl-textarea" id="def-email_body" rows="6">${esc((emailTpl.definitions || "").replace(/^Prompt:/gm,'PROMPT:').replace(/^Examples:/gm,'EXAMPLES:').replace(/^Constrains:/gm,'CONSTRAINTS:'))}</textarea>

      <div style="margin-top:8px">
        <button class="btn btn-secondary btn-sm" onclick="saveTemplate('${id}','email_body')">Save Template</button>
      </div>
    </div>
  </div>

  <div style="display:flex;justify-content:flex-end;padding:20px 0 8px">
    <button class="btn btn-primary" onclick="saveProjectConfig('${id}').then(()=>navigateToStartApply('${id}'))">
      Save &amp; Go to Apply &nbsp;→
    </button>
  </div>

  `;

}

// Keep renderProject as an alias for backward compatibility
async function renderProject(id) {
  return renderEditView(id);
}

// ── Section toggle ────────────────────────────────────────

function toggleSection(header) {
  header.parentElement.classList.toggle("collapsed");
}

// ── Project management ────────────────────────────────────

async function promptNewProject() {
  const name = prompt("Project name:");
  if (!name) return;
  try {
    const proj = await api("POST", "/projects", { name });
    proj.onboarding_complete = false; // new projects always go through onboarding
    projects.push(proj);
    toast("Project created");
    navigateToOnboarding(proj.id);
  } catch (e) {
    toast("Failed to create project: " + e.message, "error");
    console.error("Create project error:", e);
  }
}

async function confirmDeleteProject(id, name) {
  if (!confirm(`Delete project "${name}"?`)) return;
  await api("DELETE", `/projects/${id}`);
  projects = projects.filter(p => p.id !== id);
  if (activeProjectId === id) {
    activeProjectId = projects.length > 0 ? projects[0].id : null;
  }
  toast("Project deleted");
  navigateToProjects();
}

// ── Global config ─────────────────────────────────────────

async function saveGlobalConfig() {
  const data = {
    email_provider: document.getElementById("cfgEmailProvider").value,
  };
  await api("POST", "/global-config", data);
  globalConfig = {...globalConfig, ...data};
  toast("Global settings saved");
}

function switchEmailProvider(provider) {
  document.getElementById("cfgEmailProvider").value = provider;
  document.getElementById("gmailSettings").style.display = provider === "gmail" ? "block" : "none";
  document.getElementById("outlookSettings").style.display = provider === "outlook" ? "block" : "none";
  document.getElementById("noneSettings").style.display = provider === "none" ? "block" : "none";
  document.querySelectorAll(".email-provider-tabs button").forEach(btn => {
    btn.className = "btn btn-sm btn-secondary";
  });
  event.target.className = "btn btn-sm btn-primary";
}

async function connectOutlook() {
  try {
    const result = await api("GET", "/oauth/outlook/authorize");
    window.open(result.auth_url, "outlook_auth", "width=600,height=700");
  } catch (e) {
    toast("Failed to start Outlook auth: " + (e.message || e), "error");
  }
}

async function disconnectOutlook() {
  if (!confirm("Disconnect Outlook account?")) return;
  await api("POST", "/oauth/outlook/disconnect");
  globalConfig = await api("GET", "/global-config").catch(() => ({}));
  if (activeProjectId) renderEditView(activeProjectId);
}

async function connectGmail() {
  try {
    const result = await api("GET", "/oauth/gmail/authorize");
    window.open(result.auth_url, "gmail_auth", "width=600,height=700");
  } catch (e) {
    toast("Failed to start Gmail auth: " + (e.message || e), "error");
  }
}

async function disconnectGmail() {
  if (!confirm("Disconnect Gmail account?")) return;
  await api("POST", "/oauth/gmail/disconnect");
  globalConfig = await api("GET", "/global-config").catch(() => ({}));
  if (activeProjectId) renderEditView(activeProjectId);
}

// ── Project config ────────────────────────────────────────

async function saveProjectConfig(id) {
  const reqEl = document.getElementById("projJobReq");
  if (!reqEl) return;
  const data = { job_requirements: reqEl.value };
  const nameEl = document.getElementById("projName");
  const phoneEl = document.getElementById("projPhone");
  const emailEl = document.getElementById("projPersonalEmail");
  const addrEl = document.getElementById("projAddress");
  if (nameEl) data.name = nameEl.value;
  if (phoneEl) data.phone = phoneEl.value;
  if (emailEl) data.personal_email = emailEl.value;
  if (addrEl) data.address = addrEl.value;
  await api("PUT", `/projects/${id}/config`, data);
  toast("Saved");
}

// ── Materials ─────────────────────────────────────────────

async function uploadMaterials(id, files) {
  for (const file of files) {
    await uploadFile(`/projects/${id}/upload-material`, file);
  }
  toast(`${files.length} file(s) uploaded`);
  renderEditView(id);
}

async function deleteMaterial(id, filename) {
  await api("DELETE", `/projects/${id}/material/${filename}`);
  toast("File removed");
  // Refresh current view
  if (currentView === 'viewEdit') renderEditView(id);
}

// ── Attachment toggles ───────────────────────────────────

async function toggleAttachment(id, typeId, checked) {
  const proj = await api("GET", `/projects/${id}`);
  const cfs = proj.config.customize_files || [];
  const updated = cfs.map(cf => cf.id === typeId ? {...cf, is_attachment: checked} : cf);
  await api("PUT", `/projects/${id}/config`, { customize_files: updated });
  toast(checked ? "Will attach" : "Won't attach");
}

// ── Customize File Types ─────────────────────────────────

function _refreshCustomizeView(id) {
  if (currentView === 'viewProjectHome' && _projectHomeSubView === 'customize') {
    navigateToHomeSubView(id, 'customize');
  } else {
    renderEditView(id);
  }
}

async function promptAddCustomizeFile(id) {
  const label = prompt("File type name (e.g. Work Sample, Thank You Letter):");
  if (!label) return;
  try {
    await api("POST", `/projects/${id}/customize-files`, { label });
    toast(`"${label}" added`);
    _refreshCustomizeView(id);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function removeCustomizeFile(id, typeId, label) {
  if (!confirm(`Remove "${label}" and all its templates/examples?`)) return;
  try {
    await api("DELETE", `/projects/${id}/customize-files/${typeId}`);
    toast(`"${label}" removed`);
    _refreshCustomizeView(id);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function saveTypeFilenameFormat(id, typeId) {
  const fmt = document.getElementById(`fnFmt_${typeId}`).value;
  const proj = await api("GET", `/projects/${id}`);
  const cfs = proj.config.customize_files || [];
  const updated = cfs.map(cf => cf.id === typeId ? {...cf, filename_format: fmt} : cf);
  await api("PUT", `/projects/${id}/config`, { customize_files: updated });
  toast("Filename format saved");
}

// ── Per-type Examples ────────────────────────────────────

async function uploadTypeExamples(id, typeId, files) {
  for (const file of files) {
    await uploadFile(`/projects/${id}/customize/${typeId}/upload-example`, file);
  }
  toast(`${files.length} example(s) uploaded`);
  _refreshCustomizeView(id);
}

async function deleteTypeExample(id, typeId, filename) {
  await api("DELETE", `/projects/${id}/customize/${typeId}/examples/${filename}`);
  toast("Example removed");
  _refreshCustomizeView(id);
}

// ── Per-type Template generation ─────────────────────────

async function generateTypeTemplate(id, typeId) {
  gtag('event', 'template_generate_click', { event_category: 'engagement', type_id: typeId });
  try {
    toast("Generating template... (this may take a moment)", "success");
    await api("POST", `/projects/${id}/customize/${typeId}/generate-template`);
    toast("Template generated!");
    _refreshCustomizeView(id);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Email Template ────────────────────────────────────────

async function saveEmailExample(id) {
  const text = document.getElementById("emailExampleText").value;
  const subjectTemplate = document.getElementById("emailSubjectTemplate").value;
  const smartSubject = document.getElementById("smartSubjectEnabled").checked;
  if (!text.trim()) { toast("Paste an email first", "error"); return; }
  try {
    await api("POST", `/projects/${id}/email-template/save-example`, {
      text, subject_template: subjectTemplate, smart_subject: smartSubject
    });
    toast("Saved");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function generateEmailTemplate(id) {
  gtag('event', 'template_generate_click', { event_category: 'engagement', type_id: 'email_body' });
  const text = document.getElementById("emailExampleText").value;
  const subjectTemplate = document.getElementById("emailSubjectTemplate").value;
  const smartSubject = document.getElementById("smartSubjectEnabled").checked;
  if (!text.trim()) { toast("Paste an email first", "error"); return; }
  try {
    await api("POST", `/projects/${id}/email-template/save-example`, {
      text, subject_template: subjectTemplate, smart_subject: smartSubject
    });
    toast("Generating email template...", "success");
    await api("POST", `/projects/${id}/email-template/generate`);
    toast("Email template generated!");
    renderEditView(id);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Per-type Preview ─────────────────────────────────────

async function previewTypeTemplate(id, typeId) {
  try {
    toast("Generating preview PDF...", "success");
    await api("POST", `/projects/${id}/customize/${typeId}/preview`);
    const pathEl = document.getElementById(`previewPath_${typeId}`);
    if (pathEl) {
      pathEl.innerHTML = `<a href="#" class="preview-link" onclick="apiOpenPdf('/projects/${id}/customize/${typeId}/preview-pdf');return false;">&#128065; Open Preview PDF</a>`;
    }
    toast("Preview generated!");
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Template inline editing ────────────────────────────────

async function saveTemplate(projectId, typeId) {
  gtag('event', 'template_save_click', { event_category: 'engagement', type_id: typeId });
  const tplEl = document.getElementById(`tpl-${typeId}`);
  const defEl = document.getElementById(`def-${typeId}`);
  if (!tplEl) return;
  try {
    await api("POST", `/projects/${projectId}/templates/${typeId}/save`, {
      template_content: tplEl.value,
      definitions_content: defEl ? defEl.value : "",
    });
    toast("Template saved");
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Project MD ────────────────────────────────────────────

async function generateProjectMd(id) {
  try {
    await saveProjectConfig(id);
    toast("Generating AI instructions...", "success");
    await api("POST", `/projects/${id}/generate-project-md`);
    toast("project.md generated!");
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Open file ─────────────────────────────────────────────

async function openFile(id, filename) {
  try {
    await api("POST", `/projects/${id}/open-file`, { filename });
  } catch (e) {
    toast(e.message, "error");
  }
}

async function openTypeFile(id, typeId, filename) {
  try {
    await api("POST", `/projects/${id}/open-file`, { filename, type_id: typeId });
  } catch (e) {
    toast(e.message, "error");
  }
}

async function openPdf(id, pdfPath) {
  try {
    await api("POST", `/projects/${id}/open-file`, { filename: pdfPath });
  } catch (e) {
    toast(e.message, "error");
  }
}

async function openTracker(id) {
  try {
    await api("POST", `/projects/${id}/open-tracker`);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function openOutputFolder(id) {
  try {
    await api("POST", `/projects/${id}/open-output-folder`);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Progress Modal ────────────────────────────────────────

let _progressTimer = null;

function showProgress(title, status = "", indeterminate = true) {
  document.getElementById("progressTitle").textContent = title;
  document.getElementById("progressStatus").textContent = status;
  document.getElementById("progressDetail").textContent = "";
  document.getElementById("progressSteps").innerHTML = "";
  const bar = document.getElementById("progressBar");
  if (indeterminate) {
    bar.classList.add("indeterminate");
    bar.style.width = "";
  } else {
    bar.classList.remove("indeterminate");
    bar.style.width = "0%";
  }
  document.getElementById("progressOverlay").style.display = "";
}

function updateProgress(pct, status, detail) {
  const bar = document.getElementById("progressBar");
  if (pct !== null && pct !== undefined) {
    bar.classList.remove("indeterminate");
    bar.style.width = pct + "%";
  }
  if (status !== undefined && status !== null) {
    document.getElementById("progressStatus").textContent = status;
  }
  if (detail !== undefined && detail !== null) {
    document.getElementById("progressDetail").textContent = detail;
  }
}

function addProgressStep(text, state = "active") {
  const container = document.getElementById("progressSteps");
  container.querySelectorAll(".progress-step.active").forEach(el => {
    el.classList.remove("active");
    el.classList.add("done");
    el.querySelector(".step-icon").innerHTML = "&#10003;";
  });
  const step = document.createElement("div");
  step.className = `progress-step ${state}`;
  const icon = state === "done" ? "&#10003;" : state === "active" ? "&#9679;" : "&#9675;";
  step.innerHTML = `<span class="step-icon">${icon}</span> ${esc(text)}`;
  container.appendChild(step);
  container.scrollTop = container.scrollHeight;
}

function finishAllProgressSteps() {
  const container = document.getElementById("progressSteps");
  container.querySelectorAll(".progress-step.active").forEach(el => {
    el.classList.remove("active");
    el.classList.add("done");
    el.querySelector(".step-icon").innerHTML = "&#10003;";
  });
}

function hideProgress() {
  document.getElementById("progressOverlay").style.display = "none";
  if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
}

function animateSearchProgress() {
  const steps = [
    "Searching job boards and career sites...",
    "Analyzing job postings...",
    "Finding contact email addresses...",
    "Verifying application methods...",
    "Generating tailored content...",
    "Compiling results...",
  ];
  let idx = 0;
  addProgressStep(steps[0]);
  _progressTimer = setInterval(() => {
    idx++;
    if (idx < steps.length) {
      addProgressStep(steps[idx]);
    }
  }, 8000);
}

// ── Search + Confirm + Generate pipeline ─────────────────

async function runSearch(id) {
  gtag('event', 'search_click', { event_category: 'engagement' });
  const btn = document.getElementById("runBtn");
  const resultsDiv = document.getElementById("runResults");
  const count = parseInt(document.getElementById("runCount").value);
  const aiCount = Math.max(0, count - manualTargets.length);

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Searching...';
  resultsDiv.innerHTML = "";

  // If manual entries already cover the requested count, skip AI search
  if (aiCount === 0) {
    pendingTargets = [];
    const totalReady = manualTargets.length;
    let html = '<div class="search-results-panel">';
    html += '<div class="search-results-title">Search Results - Review & Confirm</div>';
    manualTargets.forEach((t, i) => {
      html += `<div class="manual-entry-row" id="manualConfirmRow_${i}">
        <div class="search-result-info">
          <span class="firm-name">${esc(t.firm)}</span>
          <span class="search-detail">${esc(t.position || "")} | ${esc(t.location || "")} | ${esc(t.email || "")}</span>
        </div>
        <span class="manual-badge">Manual</span>
        <button class="btn-remove-target" onclick="removeManualEntry(${i});updateConfirmCount('${id}')" title="Remove">&times;</button>
      </div>`;
    });
    html += `<div class="search-results-actions">
      <span class="search-count" id="confirmCount">${totalReady} position(s) ready</span>
      <button class="btn btn-run" onclick="confirmAndGenerate('${id}')" id="confirmBtn">&#9654; Confirm &amp; Generate</button>
    </div></div>`;
    resultsDiv.innerHTML = html;
    btn.disabled = false;
    btn.innerHTML = "&#9654; Search";
    return;
  }

  showProgress("Searching for Positions", "Preparing search...", true);

  try {
    await saveProjectConfig(id);
    updateProgress(null, "Connecting to AI...");
    animateSearchProgress();

    const result = await api("POST", `/projects/${id}/search`, { count: aiCount });

    finishAllProgressSteps();
    updateProgress(100, "Search complete!");
    await new Promise(r => setTimeout(r, 600));
    hideProgress();

    if (result.credit_usage?.balance != null) updateCreditsDisplay(result.credit_usage.balance);
    if (result.credit_usage?.total != null) showCreditUsage(result.credit_usage);
    pendingTargets = result.targets || [];
    const skipped = result.skipped || [];

    if (pendingTargets.length === 0 && skipped.length === 0) {
      resultsDiv.innerHTML = `<div style="color:var(--text2);font-size:13px;padding:12px 0">${esc(result.error || "No positions found. Try adjusting your requirements.")}</div>`;
      return;
    }

    const totalReady = manualTargets.length + pendingTargets.length;
    let html = '<div class="search-results-panel">';
    html += '<div class="search-results-title">Search Results - Review & Confirm</div>';

    if (manualTargets.length > 0) {
      manualTargets.forEach((t, i) => {
        html += `<div class="manual-entry-row" id="manualConfirmRow_${i}">
          <div class="search-result-info">
            <span class="firm-name">${esc(t.firm)}</span>
            <span class="search-detail">${esc(t.position || "")} | ${esc(t.location || "")} | ${esc(t.email || "")}</span>
          </div>
          <span class="manual-badge">Manual</span>
          <button class="btn-remove-target" onclick="removeManualEntry(${i});updateConfirmCount('${id}')" title="Remove">&times;</button>
        </div>`;
      });
      if (pendingTargets.length > 0) {
        html += '<div class="search-results-divider" style="font-size:12px;color:var(--text2);padding-top:8px">AI Search Results</div>';
      }
    }

    if (pendingTargets.length > 0) {
      pendingTargets.forEach((t, i) => {
        const sourceLink = (t.source && t.source.startsWith('http')) ? `<a href="${esc(t.source)}" target="_blank" rel="noopener" class="source-link" title="View job posting">&#128279;</a>` : '';
        html += `<div class="search-result-row" id="searchRow_${i}">
          <div class="search-result-info">
            <span class="firm-name">${esc(t.firm)}${sourceLink}</span>
            <span class="search-detail">${esc(t.position || "")} | ${esc(t.location || "")} | ${esc(t.email || "")}</span>
          </div>
          <button class="btn-remove-target" onclick="removeSearchTarget(${i})" title="Remove">&times;</button>
        </div>`;
      });
    }

    if (skipped.length > 0) {
      html += '<div class="search-results-divider">Skipped (portal only)</div>';
      skipped.forEach(s => {
        html += `<div class="search-result-row skipped">
          <div class="search-result-info">
            <span class="firm-name">${esc(s.firm || s.name || "Unknown")}</span>
            <span class="search-detail">${esc(s.reason || "Portal only")}</span>
          </div>
          <span class="badge badge-warn">Skipped</span>
        </div>`;
      });
    }

    if (result.credit_usage?.total != null) {
      html += `<div class="token-usage-inline"><span class="token-badge">Used ${result.credit_usage.total.toFixed(1)} credits</span></div>`;
    }

    html += `<div class="search-results-actions">
      <span class="search-count" id="confirmCount">${totalReady} position(s) ready</span>
      <button class="btn btn-run" onclick="confirmAndGenerate('${id}')" id="confirmBtn">
        &#9654; Confirm & Generate
      </button>
    </div>`;
    html += '</div>';

    resultsDiv.innerHTML = html;

  } catch (e) {
    hideProgress();
    toast(e.message, "error");
    resultsDiv.innerHTML = `<div style="color:var(--red);font-size:13px">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = "&#9654; Search";
  }
}

function restoreSearchResults(id) {
  const resultsDiv = document.getElementById("runResults");
  if (!resultsDiv || pendingTargets.length === 0) return;
  const totalReady = manualTargets.length + pendingTargets.length;
  let html = '<div class="search-results-panel">';
  html += '<div class="search-results-title">Search Results - Review & Confirm</div>';
  pendingTargets.forEach((t, i) => {
    const sourceLink = (t.source && t.source.startsWith('http')) ? `<a href="${esc(t.source)}" target="_blank" rel="noopener" class="source-link" title="View job posting">&#128279;</a>` : '';
    html += `<div class="search-result-row" id="searchRow_${i}">
      <div class="search-result-info">
        <span class="firm-name">${esc(t.firm)}${sourceLink}</span>
        <span class="search-detail">${esc(t.position || "")} | ${esc(t.location || "")} | ${esc(t.email || "")}</span>
      </div>
      <button class="btn-remove-target" onclick="removeSearchTarget(${i})" title="Remove">&times;</button>
    </div>`;
  });
  html += `<div class="search-results-actions">
    <span class="search-count" id="confirmCount">${totalReady} position(s) ready</span>
    <button class="btn btn-run" onclick="confirmAndGenerate('${id}')" id="confirmBtn">
      &#9654; Confirm & Generate
    </button>
  </div></div>`;
  resultsDiv.innerHTML = html;
}

function removeSearchTarget(index) {
  pendingTargets.splice(index, 1);
  const row = document.getElementById(`searchRow_${index}`);
  if (row) row.remove();
  updateConfirmCount();
}

function updateConfirmCount() {
  const total = manualTargets.length + pendingTargets.length;
  const countEl = document.getElementById("confirmCount") || document.querySelector(".search-count");
  if (countEl) countEl.textContent = `${total} position(s) ready`;
  if (total === 0) {
    const confirmBtn = document.getElementById("confirmBtn");
    if (confirmBtn) confirmBtn.disabled = true;
  }
}

async function confirmAndGenerate(id) {
  gtag('event', 'generate_click', { event_category: 'engagement' });
  const allTargets = [...manualTargets, ...pendingTargets];
  if (allTargets.length === 0) {
    toast("No positions to generate", "error");
    return;
  }

  const confirmBtn = document.getElementById("confirmBtn");
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = '<span class="spinner"></span> Generating...';

  showProgress("Generating Applications", `0 / ${allTargets.length} positions`, false);
  updateProgress(0);

  try {
    // Use DOM values if available, fall back to cached currentEmailTpl
    const subjectTemplate = document.getElementById("emailSubjectTemplate")?.value
      || currentEmailTpl.subject_template
      || "Application for {{POSITION}} - {{NAME}}";
    const smartSubject = document.getElementById("smartSubjectEnabled")?.checked
      || currentEmailTpl.smart_subject
      || false;

    const streamHeaders = { "Content-Type": "application/json" };
    if (accessToken) streamHeaders["Authorization"] = `Bearer ${accessToken}`;
    const response = await fetch(`/api/projects/${id}/generate-stream`, {
      method: "POST",
      headers: streamHeaders,
      body: JSON.stringify({ targets: allTargets, subject_template: subjectTemplate, smart_subject: smartSubject }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || "Generate failed");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6));

          if (evt.type === "progress") {
            if (evt.pct !== undefined) updateProgress(evt.pct);
            if (evt.status) updateProgress(null, evt.status);
            if (evt.detail) updateProgress(null, null, evt.detail);
            if (evt.step) addProgressStep(evt.step);
          } else if (evt.type === "target_done") {
            let badge = (evt.pdf ? "PDF" : "") + (evt.draft ? " + Draft" : "");
            if (evt.draft_error) badge += ` (${evt.draft_error})`;
            addProgressStep(`${evt.firm} - ${badge || "Done"}`);
          } else if (evt.type === "complete") {
            finalResult = evt;
          }
        } catch (parseErr) {
          // skip invalid lines
        }
      }
    }

    finishAllProgressSteps();
    updateProgress(100, "All done!");
    await new Promise(r => setTimeout(r, 800));
    hideProgress();

    let html = "";
    if (finalResult && finalResult.generated) {
      finalResult.generated.forEach(r => {
        const pdfBadge = r.pdf ? '<span class="badge badge-ok">PDF</span>' : '<span class="badge badge-err">No PDF</span>';
        const draftBadge = r.draft ? '<span class="badge badge-ok">Draft</span>' : '<span class="badge badge-warn">No Draft</span>';
        const draftErr = r.draft_error ? `<div class="draft-error">${esc(r.draft_error)}</div>` : "";
        html += `<div class="result-item">
          <span class="status-icon">${r.pdf && r.draft ? "&#9989;" : "&#9888;"}</span>
          <span class="firm-name">${esc(r.firm)}</span>
          ${pdfBadge} ${draftBadge}
          ${draftErr}
        </div>`;
      });

      if (finalResult.credit_usage?.total != null) {
        html += `<div class="token-usage-inline"><span class="token-badge">Used ${finalResult.credit_usage.total.toFixed(1)} credits</span></div>`;
        showCreditUsage(finalResult.credit_usage);
      }
      if (finalResult.credit_usage?.balance != null) updateCreditsDisplay(finalResult.credit_usage.balance);
      if (finalResult.save_error) {
        toast(finalResult.save_error, "error");
      }

      showCelebration(finalResult.generated);
    }

    document.getElementById("runResults").innerHTML = html;
    pendingTargets = [];
    manualTargets = [];
    // Refresh project home tracker data in background
    if (activeProjectId) {
      api("GET", `/projects/${activeProjectId}/tracker`).then(data => {
        _homeTrackerData = data;
        _homeProj = null; // will refresh on next visit
      }).catch(() => {});
      // Update project list count
      const proj = projects.find(p => p.id === activeProjectId);
      if (proj) proj.tracker_count = (proj.tracker_count || 0) + (finalResult?.generated?.length || 0);
    }
  } catch (e) {
    hideProgress();
    toast(e.message, "error");
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = "&#9654; Confirm & Generate";
  }
}

// ── Credit Usage ───────────────────────────────────────────

function showCreditUsage(creditUsage) {
  if (!creditUsage || creditUsage.total == null) return;
  toast(`Used ${creditUsage.total.toFixed(1)} credits`, "success");
}

// ── Celebration Modal ─────────────────────────────────────

function showCelebration(results) {
  const totalGenerated = results.length;
  const pdfCount = results.filter(r => r.pdf).length;
  const draftCount = results.filter(r => r.draft).length;

  document.getElementById("celebrationTitle").textContent =
    totalGenerated === 1 ? "Application Complete!" : `${totalGenerated} Applications Complete!`;

  const msgs = [
    "Great job! Keep the momentum going!",
    "You're one step closer to your dream job!",
    "Amazing progress! Your hard work will pay off!",
    "Well done! Every application counts!",
    "Fantastic! You're building great opportunities!",
  ];
  document.getElementById("celebrationMsg").textContent = msgs[Math.floor(Math.random() * msgs.length)];

  document.getElementById("celebrationStats").innerHTML = `
    <div class="celeb-stat">
      <span class="celeb-stat-num">${totalGenerated}</span>
      <span class="celeb-stat-label">Generated</span>
    </div>
    <div class="celeb-stat">
      <span class="celeb-stat-num">${pdfCount}</span>
      <span class="celeb-stat-label">PDFs</span>
    </div>
    <div class="celeb-stat">
      <span class="celeb-stat-num">${draftCount}</span>
      <span class="celeb-stat-label">Drafts</span>
    </div>
  `;

  document.getElementById("celebrationOverlay").style.display = "";
  launchConfetti();
}

function hideCelebration() {
  document.getElementById("celebrationOverlay").style.display = "none";
  document.getElementById("confettiContainer").innerHTML = "";
}

function launchConfetti() {
  const container = document.getElementById("confettiContainer");
  container.innerHTML = "";
  const colors = ["#6c8cff", "#a78bfa", "#4ade80", "#fb923c", "#f87171", "#fbbf24", "#34d399", "#818cf8"];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "%";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.setProperty("--fall-duration", (2 + Math.random() * 2) + "s");
    piece.style.setProperty("--rotation", (360 + Math.random() * 720) + "deg");
    piece.style.animationDelay = Math.random() * 0.8 + "s";
    piece.style.width = (6 + Math.random() * 8) + "px";
    piece.style.height = (6 + Math.random() * 8) + "px";
    piece.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
    container.appendChild(piece);
  }
}

// ── Manual Entry ──────────────────────────────────────────

function toggleManualEntry() {
  const toggle = document.querySelector(".manual-entry-toggle");
  const form = document.getElementById("manualEntryForm");
  toggle.classList.toggle("expanded");
  form.classList.toggle("visible");
}

function addManualEntry() {
  const firm = document.getElementById("manualFirm").value.trim();
  const email = document.getElementById("manualEmail").value.trim();
  const position = document.getElementById("manualPosition").value.trim();
  const location = document.getElementById("manualLocation").value.trim();
  const website = document.getElementById("manualWebsite").value.trim();

  if (!firm) { toast("Company name is required", "error"); return; }
  if (!email) { toast("Email is required", "error"); return; }

  const entry = {
    firm,
    email,
    position: position || "Architect",
    location: location || "",
    website: website || "",
    source: "manual",
    openDate: new Date().toISOString().slice(0, 7),
    salutation: "Hiring Manager",
    _manual: true,
  };

  manualTargets.push(entry);
  renderManualEntries();

  document.getElementById("manualFirm").value = "";
  document.getElementById("manualEmail").value = "";
  document.getElementById("manualPosition").value = "";
  document.getElementById("manualLocation").value = "";
  document.getElementById("manualWebsite").value = "";

  toast(`Added ${firm} (manual)`);
}

function removeManualEntry(index) {
  manualTargets.splice(index, 1);
  renderManualEntries();
}

function renderManualEntries() {
  const container = document.getElementById("manualEntriesList");
  if (!container) return;
  if (manualTargets.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = manualTargets.map((t, i) => `
    <div class="manual-entry-row" id="manualRow_${i}">
      <div class="search-result-info">
        <span class="firm-name">${esc(t.firm)}</span>
        <span class="search-detail">${esc(t.position || "")} | ${esc(t.location || "")} | ${esc(t.email || "")}</span>
      </div>
      <span class="manual-badge">Manual</span>
      <button class="btn-remove-target" onclick="removeManualEntry(${i})" title="Remove">&times;</button>
    </div>
  `).join("");
}

// ── Onboarding Wizard ─────────────────────────────────────

const OB_TOTAL_STEPS = 9;

const OB_SAMPLE_COVER_LETTER = `Dear Hiring Manager,

I am writing to express my sincere interest in joining your team as an architect. With a strong foundation in architectural design, technical documentation, and collaborative project delivery, I am eager to contribute meaningfully to your firm's work.

Throughout my academic and professional experience, I have developed proficiency in industry-standard tools including Revit, AutoCAD, Rhino, and Grasshopper. I have applied these skills across a range of project types—from residential and mixed-use developments to cultural and civic buildings—gaining a versatile perspective on design and construction.

I am particularly drawn to firms that balance bold design vision with practical execution. I bring a detail-oriented mindset, strong communication skills, and the ability to thrive in fast-paced, collaborative environments.

Enclosed please find my resume and portfolio for your review. I would welcome the opportunity to discuss how my background aligns with your team's goals.

Thank you for your time and consideration.

Sincerely,
[Your Name]`;

const OB_SAMPLE_CL_TEMPLATE = `Dear {{SALUTATION}},

{{CUSTOM_1}}

{{CUSTOM_2}}

I am particularly drawn to {{FIRM_NAME}}'s commitment to design excellence and innovation. I believe my skills and enthusiasm would make a meaningful contribution to your team.

Enclosed please find my resume and portfolio for your review. I would welcome the opportunity to discuss how my background aligns with your goals.

Thank you for your time and consideration.

Sincerely,
{{NAME}}`;

const OB_SAMPLE_CL_DEFINITIONS = `PROMPT: Write a compelling opening paragraph for a cover letter applying to {{FIRM_NAME}} for the {{POSITION}} role. Mention the applicant's background in architecture and their genuine interest in this specific firm. Reference {{FIRM_NAME}}'s notable projects or design philosophy. Keep it 3-4 sentences.
EXAMPLES: I am excited to apply for the Junior Architect position at Zaha Hadid Architects, a firm whose boundary-pushing parametric design work has consistently inspired me. | I am writing to express my interest in the architectural role at Snøhetta, whose integration of landscape, interiors, and architecture into holistic experiences deeply resonates with my design philosophy.
CONSTRAINTS: Do not use generic phrases. Must reference the specific firm. First person. 3-4 sentences.

PROMPT: Write a second paragraph highlighting the applicant's technical skills and experience relevant to {{FIRM_NAME}} and {{POSITION}}. Mention software proficiency and relevant project types.
EXAMPLES: My experience with computational design tools, including Rhino and Grasshopper, combined with proficiency in Revit for documentation, positions me well to contribute to technically complex projects. | During my internship, I developed strong skills in design development and construction documentation across large-scale mixed-use projects.
CONSTRAINTS: Specific and professional. Mention at least one software or technical skill. 3-4 sentences.`;

const OB_SAMPLE_EMAIL_SUBJECT = 'Application for {{POSITION}} – {{NAME}}';

const OB_SAMPLE_EMAIL_BODY = `Dear {{SALUTATION}},

I am writing to express my interest in the {{POSITION}} role at {{FIRM_NAME}}. Please find my resume and portfolio attached for your consideration.

I would welcome the opportunity to discuss how my background aligns with your firm's vision and current projects.

Thank you for your time.

Best regards,
{{NAME}}`;

const OB_SAMPLE_JOB_REQ = 'Entry-level or junior architect positions in major US cities. 0-1 years of experience. Prefer firms working on residential, cultural, civic, or mixed-use projects.';

function obProgressBar(step) {
  const pct = Math.round(((step - 1) / OB_TOTAL_STEPS) * 100);
  const dots = Array.from({ length: OB_TOTAL_STEPS }, (_, i) => {
    const cls = i + 1 < step ? 'ob-dot ob-dot-done' : (i + 1 === step ? 'ob-dot ob-dot-active' : 'ob-dot');
    return `<div class="${cls}"></div>`;
  }).join('');
  return `
    <div class="ob-progress">
      <div class="ob-progress-bar"><div class="ob-progress-fill" style="width:${pct}%"></div></div>
      <div class="ob-dots">${dots}</div>
      <div class="ob-step-label">Step ${step} of ${OB_TOTAL_STEPS}</div>
    </div>`;
}

function obHeader(step, title, subtitle) {
  return `
    ${obProgressBar(step)}
    <div class="ob-title-area">
      <h2 class="ob-title">${title}</h2>
      ${subtitle ? `<p class="ob-subtitle">${subtitle}</p>` : ''}
    </div>`;
}

function obNavButtons(id, opts = {}) {
  const { prevStep, nextLabel = 'Continue', nextAction, skipLabel, skipAction } = opts;
  const backBtn = prevStep != null
    ? `<button class="btn btn-secondary" onclick="obGoStep('${id}', ${prevStep})">← Back</button>`
    : `<div></div>`;
  let rightBtns = '';
  if (skipLabel && skipAction) rightBtns += `<button class="btn btn-ghost" onclick="${skipAction}">${skipLabel}</button>`;
  if (nextAction) rightBtns += `<button class="btn btn-primary ob-next-btn" onclick="${nextAction}">${nextLabel} →</button>`;
  return `<div class="ob-nav">${backBtn}<div class="ob-nav-right">${rightBtns}</div></div>`;
}

async function navigateToOnboarding(id) {
  activeProjectId = id;
  currentOnboardingStep = 1;
  onboardingSearchResults = [];
  manualTargets = [];
  showView('viewOnboarding');
  updateTopBarSelect();
  await renderOnboarding(id);
}

async function renderOnboarding(id) {
  const page = document.getElementById('onboardingPage');
  if (!page) return;
  page.innerHTML = '<div class="view-loading">Loading...</div>';
  try {
    switch (currentOnboardingStep) {
      case 1: await renderObStep1(id, page); break;
      case 2: await renderObStep2(id, page); break;
      case 3: await renderObStep3(id, page); break;
      case 4: await renderObStep4(id, page); break;
      case 5: await renderObStep5(id, page); break;
      case 6: await renderObStep6(id, page); break;
      case 7: await renderObStep7(id, page); break;
      case 8: await renderObStep8(id, page); break;
      case 9: await renderObStep9(id, page); break;
      default: await renderObStep1(id, page);
    }
    // Inject skip link into progress bar row (not on final step)
    if (currentOnboardingStep < 9) {
      const progress = page.querySelector('.ob-progress');
      if (progress) {
        progress.insertAdjacentHTML('beforeend',
          `<button class="btn-ob-skip" onclick="obSkip('${id}')">Skip setup</button>`);
      }
    }
  } catch (e) {
    page.innerHTML = `<div class="view-error">Failed to load step: ${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

async function obSkip(id) {
  await obFinish(id);
}

async function obGoStep(id, step) {
  currentOnboardingStep = step;
  await renderOnboarding(id);
}

// ── Step 1: Upload Files ──────────────────────────────────

async function renderObStep1(id, page) {
  const proj = await api("GET", `/projects/${id}`).catch(() => ({ materials: [] }));
  const materials = proj.materials || [];
  page.innerHTML = `
    <div class="ob-card">
      ${obHeader(1, 'Upload Your Files', 'Upload your resume and portfolio so they can be attached to your applications.')}
      <div class="ob-body">
        <div class="ob-upload-zone" id="obDropZone"
          onclick="document.getElementById('obFileInput').click()"
          ondragover="event.preventDefault();this.classList.add('ob-drag-over')"
          ondragleave="this.classList.remove('ob-drag-over')"
          ondrop="event.preventDefault();this.classList.remove('ob-drag-over');obUploadMaterials('${id}',event.dataTransfer.files)">
          <div class="ob-upload-icon">📁</div>
          <div class="ob-upload-text">Click or drag files here</div>
          <div class="ob-upload-hint">PDF, DOCX accepted</div>
          <input type="file" id="obFileInput" style="display:none" multiple accept=".pdf,.docx,.txt,.doc"
            onchange="obUploadMaterials('${id}', this.files)">
        </div>
        <div class="ob-files-list" id="obFilesList">
          ${obRenderFileChips(materials, id, 'material')}
        </div>
      </div>
      ${obNavButtons(id, {
        prevStep: null,
        nextLabel: materials.length > 0 ? 'Continue' : 'Skip for Now',
        nextAction: `obGoStep('${id}', 2)`,
      })}
    </div>`;
}

function obRenderFileChips(files, id, type) {
  if (!files || files.length === 0) return '<div class="ob-empty-hint">No files uploaded yet</div>';
  return files.map(f => {
    const removeAction = type === 'material'
      ? `obDeleteMaterial('${id}','${esc(f)}')`
      : `obDeleteExample('${id}','cover_letter','${esc(f)}')`;
    return `<div class="ob-file-chip">📎 ${esc(f)}<button class="ob-file-remove" onclick="${removeAction}" title="Remove">×</button></div>`;
  }).join('');
}

async function obUploadMaterials(id, files) {
  if (!files || files.length === 0) return;
  try {
    for (const file of files) await uploadFile(`/projects/${id}/upload-material`, file);
    toast(`${files.length} file(s) uploaded`);
    const proj = await api("GET", `/projects/${id}`);
    const list = document.getElementById('obFilesList');
    if (list) list.innerHTML = obRenderFileChips(proj.materials || [], id, 'material');
    const nextBtn = document.querySelector('.ob-next-btn');
    if (nextBtn) nextBtn.textContent = 'Continue →';
  } catch (e) { toast(e.message, 'error'); }
}

async function obDeleteMaterial(id, filename) {
  try {
    await api("DELETE", `/projects/${id}/material/${filename}`);
    toast('File removed');
    const proj = await api("GET", `/projects/${id}`);
    const list = document.getElementById('obFilesList');
    if (list) list.innerHTML = obRenderFileChips(proj.materials || [], id, 'material');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Step 2: Personal Info ─────────────────────────────────

async function renderObStep2(id, page) {
  const proj = await api("GET", `/projects/${id}`).catch(() => ({ config: {} }));
  const cfg = proj.config || {};
  page.innerHTML = `
    <div class="ob-card">
      ${obHeader(2, 'Your Information', 'All fields are optional — fill in what you have. This appears on your cover letters.')}
      <div class="ob-body">
        <div class="ob-form-grid">
          <div class="ob-field">
            <label>Full Name</label>
            <input type="text" id="obName" placeholder="Jane Smith" value="${esc(cfg.name || '')}">
          </div>
          <div class="ob-field">
            <label>Phone</label>
            <input type="tel" id="obPhone" placeholder="+1 (555) 000-0000" value="${esc(cfg.phone || '')}">
          </div>
          <div class="ob-field">
            <label>Personal Email</label>
            <input type="email" id="obPersonalEmail" placeholder="jane@email.com" value="${esc(cfg.personal_email || '')}">
          </div>
          <div class="ob-field">
            <label>Location / Address</label>
            <input type="text" id="obAddress" placeholder="New York, NY" value="${esc(cfg.address || '')}">
          </div>
        </div>
      </div>
      ${obNavButtons(id, {
        prevStep: 1,
        nextLabel: 'Save & Continue',
        nextAction: `obSavePersonalInfo('${id}')`,
        skipLabel: 'Skip',
        skipAction: `obGoStep('${id}', 3)`,
      })}
    </div>`;
}

async function obSavePersonalInfo(id) {
  try {
    await api("PUT", `/projects/${id}/config`, {
      name: document.getElementById('obName')?.value || '',
      phone: document.getElementById('obPhone')?.value || '',
      personal_email: document.getElementById('obPersonalEmail')?.value || '',
      address: document.getElementById('obAddress')?.value || '',
    });
    toast('Saved');
    await obGoStep(id, 3);
  } catch (e) { toast(e.message, 'error'); }
}

// ── Step 3: Cover Letter Upload ───────────────────────────

async function renderObStep3(id, page) {
  const examples = await api("GET", `/projects/${id}/customize/cover_letter/examples`).catch(() => []);
  page.innerHTML = `
    <div class="ob-card">
      ${obHeader(3, 'Cover Letter Template', 'Upload an example cover letter so AI can learn your style — or start with our sample.')}
      <div class="ob-body">
        <div class="ob-sample-banner">
          <span class="ob-sample-icon">✨</span>
          <div>
            <strong>Use Sample Cover Letter</strong>
            <p>Upload a professional sample so AI can generate a template for you.</p>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="obUseSampleCoverLetter('${id}', this)">Use Sample</button>
        </div>
        <div class="ob-divider"><span>or upload your own</span></div>
        <div class="ob-upload-zone"
          onclick="document.getElementById('obClInput').click()"
          ondragover="event.preventDefault();this.classList.add('ob-drag-over')"
          ondragleave="this.classList.remove('ob-drag-over')"
          ondrop="event.preventDefault();this.classList.remove('ob-drag-over');obUploadClExample('${id}',event.dataTransfer.files)">
          <div class="ob-upload-icon">📝</div>
          <div class="ob-upload-text">Upload cover letter example</div>
          <div class="ob-upload-hint">PDF or TXT — 1-3 examples recommended</div>
          <input type="file" id="obClInput" style="display:none" multiple accept=".pdf,.txt,.doc,.docx"
            onchange="obUploadClExample('${id}', this.files)">
        </div>
        <div class="ob-files-list" id="obClFilesList">
          ${obRenderExampleChips(examples, id)}
        </div>
      </div>
      ${obNavButtons(id, {
        prevStep: 2,
        nextLabel: examples.length > 0 ? 'Generate Template' : 'Skip for Now',
        nextAction: `obGoStep('${id}', 4)`,
      })}
    </div>`;
}

function obRenderExampleChips(examples, id) {
  if (!examples || examples.length === 0) return '<div class="ob-empty-hint">No examples uploaded yet</div>';
  return examples.map(f =>
    `<div class="ob-file-chip">📄 ${esc(f)}<button class="ob-file-remove" onclick="obDeleteExample('${id}','cover_letter','${esc(f)}')" title="Remove">×</button></div>`
  ).join('');
}

async function obUploadClExample(id, files) {
  if (!files || files.length === 0) return;
  try {
    for (const file of files) await uploadFile(`/projects/${id}/customize/cover_letter/upload-example`, file);
    toast(`${files.length} example(s) uploaded`);
    const examples = await api("GET", `/projects/${id}/customize/cover_letter/examples`).catch(() => []);
    const list = document.getElementById('obClFilesList');
    if (list) list.innerHTML = obRenderExampleChips(examples, id);
    const nextBtn = document.querySelector('.ob-next-btn');
    if (nextBtn) nextBtn.textContent = 'Generate Template →';
  } catch (e) { toast(e.message, 'error'); }
}

async function obDeleteExample(id, typeId, filename) {
  try {
    await api("DELETE", `/projects/${id}/customize/${typeId}/examples/${filename}`);
    toast('Removed');
    const examples = await api("GET", `/projects/${id}/customize/${typeId}/examples`).catch(() => []);
    const list = document.getElementById('obClFilesList');
    if (list) list.innerHTML = obRenderExampleChips(examples, id);
  } catch (e) { toast(e.message, 'error'); }
}

async function obUseSampleCoverLetter(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Uploading...';
  try {
    const blob = new Blob([OB_SAMPLE_COVER_LETTER], { type: 'text/plain' });
    const file = new File([blob], 'sample-cover-letter.txt', { type: 'text/plain' });
    await uploadFile(`/projects/${id}/customize/cover_letter/upload-example`, file);
    toast('Sample uploaded — generating template next');
    await obGoStep(id, 4);
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Use Sample';
  }
}

// ── Step 4: Generate Template ─────────────────────────────

async function renderObStep4(id, page) {
  const proj = await api("GET", `/projects/${id}`).catch(() => ({}));
  const tpls = proj.templates || {};
  const existingTemplate = tpls.cover_letter?.template || '';
  const existingDefs = tpls.cover_letter?.definitions || '';
  const examples = await api("GET", `/projects/${id}/customize/cover_letter/examples`).catch(() => []);
  const hasExamples = examples.length > 0;

  if (existingTemplate) {
    page.innerHTML = `
      <div class="ob-card">
        ${obHeader(4, 'Cover Letter Template', 'Your template is ready. Review and edit as needed.')}
        <div class="ob-body">
          <div class="ob-template-section">
            <label class="ob-label">Template <span class="ob-label-hint">({{CUSTOM_1}}, {{CUSTOM_2}} will be written by AI per firm)</span></label>
            <textarea id="obTplText" class="ob-textarea ob-textarea-tall" rows="10">${esc(extractEditableContent(existingTemplate))}</textarea>
          </div>
          <div class="ob-template-section">
            <label class="ob-label">AI Instructions <span class="ob-label-hint">(defines what to write for each {{CUSTOM}} block)</span></label>
            <textarea id="obTplDefs" class="ob-textarea" rows="5">${esc(existingDefs)}</textarea>
          </div>
          <button class="btn btn-secondary btn-sm" style="margin-top:8px" onclick="obSaveTemplate('${id}')">Save Changes</button>
        </div>
        ${obNavButtons(id, { prevStep: 3, nextLabel: 'Continue', nextAction: `obGoStep('${id}', 5)` })}
      </div>`;
  } else {
    page.innerHTML = `
      <div class="ob-card">
        ${obHeader(4, 'Generate Cover Letter Template', hasExamples
          ? 'AI will analyze your example and create a personalized template.'
          : 'No examples uploaded — use the pre-built template or go back to upload examples.')}
        <div class="ob-body">
          ${hasExamples ? `
            <div class="ob-generate-area">
              <button class="btn btn-primary" id="obGenerateBtn" onclick="obGenerateTemplate('${id}')">
                ✨ Generate Template from Examples
              </button>
              <p class="ob-generate-hint">Uses AI credits · takes ~15 seconds</p>
            </div>` : `
            <div class="ob-sample-banner">
              <span class="ob-sample-icon">📋</span>
              <div>
                <strong>Use Pre-built Template</strong>
                <p>A professional cover letter template ready to customize.</p>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="obUsePrebuiltTemplate('${id}', this)">Use Template</button>
            </div>`}
          <div id="obTemplateResult" style="display:none">
            <div class="ob-template-section" style="margin-top:16px">
              <label class="ob-label">Template</label>
              <textarea id="obTplText" class="ob-textarea ob-textarea-tall" rows="10"></textarea>
            </div>
            <div class="ob-template-section">
              <label class="ob-label">AI Instructions</label>
              <textarea id="obTplDefs" class="ob-textarea" rows="5"></textarea>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px" onclick="obSaveTemplate('${id}')">Save Changes</button>
          </div>
        </div>
        ${obNavButtons(id, { prevStep: 3, nextLabel: 'Continue', nextAction: `obGoStep('${id}', 5)` })}
      </div>`;
  }
}

async function obGenerateTemplate(id) {
  const btn = document.getElementById('obGenerateBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating...'; }
  try {
    const result = await api("POST", `/projects/${id}/customize/cover_letter/generate-template`);
    toast('Template generated!');
    const resultDiv = document.getElementById('obTemplateResult');
    if (resultDiv) {
      resultDiv.style.display = '';
      const tplEl = document.getElementById('obTplText');
      const defsEl = document.getElementById('obTplDefs');
      if (tplEl) tplEl.value = result.template || '';
      if (defsEl) defsEl.value = result.definitions || '';
    }
    if (btn) { btn.disabled = false; btn.textContent = '✓ Generated — review below'; }
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generate Template from Examples'; }
  }
}

async function obUsePrebuiltTemplate(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    await api("POST", `/projects/${id}/templates/cover_letter/save`, {
      template_content: OB_SAMPLE_CL_TEMPLATE,
      definitions_content: OB_SAMPLE_CL_DEFINITIONS,
    });
    toast('Template saved');
    await obGoStep(id, 5);
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Use Template';
  }
}

async function obSaveTemplate(id) {
  try {
    await api("POST", `/projects/${id}/templates/cover_letter/save`, {
      template_content: document.getElementById('obTplText')?.value || '',
      definitions_content: document.getElementById('obTplDefs')?.value || '',
    });
    toast('Template saved');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Step 5: Email Template ─────────────────────────────────

async function renderObStep5(id, page) {
  const emailTpl = await api("GET", `/projects/${id}/email-template`).catch(() => ({}));
  const subject = emailTpl.subject_template || OB_SAMPLE_EMAIL_SUBJECT;
  const body = emailTpl.example || OB_SAMPLE_EMAIL_BODY;
  const tplText = extractEditableContent(emailTpl.template || '');
  const defsText = (emailTpl.definitions || '')
    .replace(/^Prompt:/gm, 'PROMPT:')
    .replace(/^Examples:/gm, 'EXAMPLES:')
    .replace(/^Constrains:/gm, 'CONSTRAINTS:');
  page.innerHTML = `
    <div class="ob-card">
      ${obHeader(5, 'Write Your Email', 'Set up the email template for your applications.')}
      <div class="ob-body">
        <div class="ob-field">
          <div class="ob-field-header">
            <label>Subject Line</label>
          </div>
          <input type="text" id="obEmailSubject" value="${esc(subject)}"
            placeholder="Application for {{POSITION}} – {{NAME}}">
          <div class="ob-field-hint">Use {{POSITION}}, {{NAME}}, {{FIRM_NAME}} as placeholders</div>
        </div>
        <div class="ob-field">
          <div class="ob-field-header">
            <label>Email Body Example</label>
            <button class="btn btn-ghost btn-sm" onclick="obUseSampleEmail()">Use Sample</button>
          </div>
          <textarea id="obEmailBody" rows="6">${esc(body)}</textarea>
        </div>
        <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
          <button class="btn btn-secondary btn-sm" onclick="obSaveEmailExample('${id}')">Save</button>
          <button class="btn btn-primary btn-sm" onclick="obGenerateEmailTemplate('${id}')">✎ Generate Template</button>
        </div>
        <div class="ob-template-section" style="margin-top:16px">
          <label class="ob-label">Template <span class="ob-label-hint">({{CUSTOM_1}}, {{CUSTOM_2}} will be written by AI per firm)</span></label>
          <textarea class="ob-textarea ob-textarea-tall" id="tpl-email_body" rows="8">${esc(tplText)}</textarea>
        </div>
        <div class="ob-template-section">
          <label class="ob-label">AI Instructions <span class="ob-label-hint">(defines what to write for each {{CUSTOM}} block)</span></label>
          <textarea class="ob-textarea" id="def-email_body" rows="5">${esc(defsText)}</textarea>
        </div>
        <div style="margin-top:8px">
          <button class="btn btn-secondary btn-sm" onclick="saveTemplate('${id}','email_body')">Save Template</button>
        </div>
      </div>
      ${obNavButtons(id, {
        prevStep: 4,
        nextLabel: 'Continue',
        nextAction: `obGoStep('${id}', 6)`,
        skipLabel: 'Skip',
        skipAction: `obGoStep('${id}', 6)`,
      })}
    </div>`;
}

function obUseSampleEmail() {
  const s = document.getElementById('obEmailSubject');
  const b = document.getElementById('obEmailBody');
  if (s) s.value = OB_SAMPLE_EMAIL_SUBJECT;
  if (b) b.value = OB_SAMPLE_EMAIL_BODY;
  toast('Sample email loaded');
}

async function obSaveEmail(id) {
  const body = document.getElementById('obEmailBody')?.value.trim() || '';
  const subject = document.getElementById('obEmailSubject')?.value.trim() || '';
  if (!body) { await obGoStep(id, 6); return; }
  try {
    await api("POST", `/projects/${id}/email-template/save-example`, {
      text: body, subject_template: subject, smart_subject: false,
    });
    toast('Email template saved');
    await obGoStep(id, 6);
  } catch (e) { toast(e.message, 'error'); }
}

async function obSaveEmailExample(id) {
  const body = document.getElementById('obEmailBody')?.value.trim() || '';
  const subject = document.getElementById('obEmailSubject')?.value.trim() || '';
  if (!body) { toast('Paste an email first', 'error'); return; }
  try {
    await api("POST", `/projects/${id}/email-template/save-example`, {
      text: body, subject_template: subject, smart_subject: false,
    });
    toast('Saved');
  } catch (e) { toast(e.message, 'error'); }
}

async function obGenerateEmailTemplate(id) {
  const body = document.getElementById('obEmailBody')?.value.trim() || '';
  const subject = document.getElementById('obEmailSubject')?.value.trim() || '';
  if (!body) { toast('Paste an email example first', 'error'); return; }
  try {
    await api("POST", `/projects/${id}/email-template/save-example`, {
      text: body, subject_template: subject, smart_subject: false,
    });
    toast('Generating email template...', 'success');
    await api("POST", `/projects/${id}/email-template/generate`);
    toast('Email template generated!');
    await renderObStep5(id, document.getElementById('onboardingPage'));
  } catch (e) { toast(e.message, 'error'); }
}

// ── Step 6: Connect Email ──────────────────────────────────

async function renderObStep6(id, page) {
  const gmailConnected = globalConfig.gmail_connected;
  const outlookConnected = globalConfig.outlook_connected;
  const isConnected = gmailConnected || outlookConnected;
  page.innerHTML = `
    <div class="ob-card">
      ${obHeader(6, 'Connect Your Email', 'Connect Gmail or Outlook to automatically save applications as draft emails.')}
      <div class="ob-body">
        <div class="ob-email-options">
          <div class="ob-email-option ${gmailConnected ? 'ob-email-connected' : ''}">
            <div class="ob-email-option-left">
              <div class="ob-email-icon">✉️</div>
              <div>
                <strong>Gmail</strong>
                ${gmailConnected
                  ? `<div class="ob-connected-label">Connected: ${esc(globalConfig.gmail_email || '')}</div>`
                  : '<div class="ob-connect-desc">Save drafts directly to Gmail</div>'}
              </div>
            </div>
            ${gmailConnected
              ? `<button class="btn btn-secondary btn-sm" onclick="disconnectGmail()">Disconnect</button>`
              : `<button class="btn btn-primary btn-sm" onclick="connectGmail()">Connect Gmail</button>`}
          </div>
          <div class="ob-email-option ${outlookConnected ? 'ob-email-connected' : ''}">
            <div class="ob-email-option-left">
              <div class="ob-email-icon">📧</div>
              <div>
                <strong>Outlook</strong>
                ${outlookConnected
                  ? `<div class="ob-connected-label">Connected: ${esc(globalConfig.outlook_email || '')}</div>`
                  : '<div class="ob-connect-desc">Save drafts directly to Outlook</div>'}
              </div>
            </div>
            ${outlookConnected
              ? `<button class="btn btn-secondary btn-sm" onclick="disconnectOutlook()">Disconnect</button>`
              : `<button class="btn btn-primary btn-sm" onclick="connectOutlook()">Connect Outlook</button>`}
          </div>
        </div>
        ${isConnected ? '<div class="ob-success-note">✓ Email connected — applications will be saved as drafts for your review.</div>' : ''}
      </div>
      ${obNavButtons(id, {
        prevStep: 5,
        nextLabel: isConnected ? 'Continue' : 'Skip for Now',
        nextAction: `obGoStep('${id}', 7)`,
      })}
    </div>`;
}

// ── Step 7: Search Positions ───────────────────────────────

async function renderObStep7(id, page) {
  const proj = await api("GET", `/projects/${id}`).catch(() => ({ config: {} }));
  const savedReq = proj.config?.job_requirements || '';
  page.innerHTML = `
    <div class="ob-card">
      ${obHeader(7, 'Search for Positions', "Describe the jobs you're looking for. We'll find 3 matching positions.")}
      <div class="ob-body">
        <div class="ob-field">
          <div class="ob-field-header">
            <label>Job Requirements</label>
            <button class="btn btn-ghost btn-sm" onclick="obUseSampleReq()">Use Sample</button>
          </div>
          <textarea id="obJobReq" rows="4"
            placeholder="e.g. Junior Architect positions in New York, 0-1 years experience, prefer cultural or museum projects"
          >${esc(savedReq)}</textarea>
        </div>
        <div id="obSearchMsg"></div>
      </div>
      <div class="ob-nav">
        <button class="btn btn-secondary" onclick="obGoStep('${id}', 6)">← Back</button>
        <div class="ob-nav-right">
          <button class="btn btn-ghost" onclick="obGoStep('${id}', 8)">Skip Search</button>
          <button class="btn btn-primary" id="obSearchBtn" onclick="obRunSearch('${id}')">▶ Search (3 positions)</button>
        </div>
      </div>
    </div>`;
}

function obUseSampleReq() {
  const el = document.getElementById('obJobReq');
  if (el) el.value = OB_SAMPLE_JOB_REQ;
}

async function obRunSearch(id) {
  const btn = document.getElementById('obSearchBtn');
  const msgDiv = document.getElementById('obSearchMsg');
  const jobReq = document.getElementById('obJobReq')?.value.trim() || '';
  if (!jobReq) { toast('Please enter job requirements', 'error'); return; }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Searching...';
  if (msgDiv) msgDiv.innerHTML = '';
  showProgress("Searching for Positions", "Preparing search...", true);
  try {
    await api("PUT", `/projects/${id}/config`, { job_requirements: jobReq });
    animateSearchProgress();
    const result = await api("POST", `/projects/${id}/search`, { count: 3 });
    finishAllProgressSteps();
    updateProgress(100, 'Search complete!');
    await new Promise(r => setTimeout(r, 600));
    hideProgress();
    if (result.credit_usage?.balance != null) updateCreditsDisplay(result.credit_usage.balance);
    onboardingSearchResults = result.targets || [];
    if (onboardingSearchResults.length === 0) {
      if (msgDiv) msgDiv.innerHTML = `<div style="color:var(--text2);font-size:13px;padding:12px 0">No positions found. Try adjusting your requirements.</div>`;
    } else {
      await obGoStep(id, 8);
    }
  } catch (e) {
    hideProgress();
    toast(e.message, 'error');
    if (msgDiv) msgDiv.innerHTML = `<div style="color:var(--red);font-size:13px">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '▶ Search (3 positions)';
  }
}

// ── Step 8: Review & Generate ─────────────────────────────

async function renderObStep8(id, page) {
  const targets = onboardingSearchResults;
  if (targets.length === 0) {
    page.innerHTML = `
      <div class="ob-card">
        ${obHeader(8, 'Review Results', 'No search results to review.')}
        <div class="ob-body"><p class="ob-desc">Go back to search, or skip to finish setup.</p></div>
        ${obNavButtons(id, { prevStep: 7, nextLabel: 'Finish Setup', nextAction: `obGoStep('${id}', 9)` })}
      </div>`;
    return;
  }
  const resultsHtml = targets.map((t, i) => {
    const sourceLink = (t.source && t.source.startsWith('http'))
      ? `<a href="${esc(t.source)}" target="_blank" rel="noopener" class="source-link" title="View posting">🔗</a>` : '';
    return `<div class="search-result-row" id="obResultRow_${i}">
      <div class="search-result-info">
        <span class="firm-name">${esc(t.firm)}${sourceLink}</span>
        <span class="search-detail">${esc(t.position || '')} | ${esc(t.location || '')} | ${esc(t.email || '')}</span>
      </div>
      <button class="btn-remove-target" onclick="obRemoveResult(${i})" title="Remove">×</button>
    </div>`;
  }).join('');
  page.innerHTML = `
    <div class="ob-card">
      ${obHeader(8, 'Review & Generate', 'Review the positions found. Deselect any you don\'t want, then generate.')}
      <div class="ob-body">
        <div class="search-results-panel ob-results-panel">
          <div class="search-results-title">Found ${targets.length} position(s)</div>
          <div id="obResultsList">${resultsHtml}</div>
          <div id="obResultsCount" class="ob-results-count">${targets.length} position(s) ready</div>
        </div>
      </div>
      <div class="ob-nav">
        <button class="btn btn-secondary" onclick="obGoStep('${id}', 7)">← Back</button>
        <div class="ob-nav-right">
          <button class="btn btn-ghost" onclick="obGoStep('${id}', 9)">Skip Generation</button>
          <button class="btn btn-primary" id="obGenerateAppBtn" onclick="obGenerateApplications('${id}')">▶ Generate & Save to Drafts</button>
        </div>
      </div>
    </div>`;
}

function obRemoveResult(index) {
  onboardingSearchResults.splice(index, 1);
  const row = document.getElementById(`obResultRow_${index}`);
  if (row) row.remove();
  const countEl = document.getElementById('obResultsCount');
  if (countEl) countEl.textContent = `${onboardingSearchResults.length} position(s) ready`;
  if (onboardingSearchResults.length === 0) {
    const list = document.getElementById('obResultsList');
    if (list) list.innerHTML = '<div class="ob-empty-hint">All positions removed. Go back to search again.</div>';
    const genBtn = document.getElementById('obGenerateAppBtn');
    if (genBtn) genBtn.disabled = true;
  }
}

async function obGenerateApplications(id) {
  const targets = onboardingSearchResults;
  if (targets.length === 0) { toast('No positions to generate', 'error'); return; }
  const btn = document.getElementById('obGenerateAppBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating...';
  const emailTpl = await api("GET", `/projects/${id}/email-template`).catch(() => ({}));
  const subjectTemplate = emailTpl.subject_template || OB_SAMPLE_EMAIL_SUBJECT;
  showProgress("Generating Applications", `0 / ${targets.length} positions`, false);
  updateProgress(0);
  try {
    const streamHeaders = { "Content-Type": "application/json" };
    if (accessToken) streamHeaders["Authorization"] = `Bearer ${accessToken}`;
    const response = await fetch(`/api/projects/${id}/generate-stream`, {
      method: "POST",
      headers: streamHeaders,
      body: JSON.stringify({ targets, subject_template: subjectTemplate, smart_subject: false }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || "Generate failed");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", finalResult = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === "progress") {
            if (evt.pct !== undefined) updateProgress(evt.pct);
            if (evt.status) updateProgress(null, evt.status);
            if (evt.step) addProgressStep(evt.step);
          } else if (evt.type === "target_done") {
            addProgressStep(`${evt.firm} - Done`);
          } else if (evt.type === "complete") { finalResult = evt; }
        } catch (_) {}
      }
    }
    finishAllProgressSteps();
    updateProgress(100, 'All done!');
    await new Promise(r => setTimeout(r, 800));
    hideProgress();
    if (finalResult?.credit_usage?.balance != null) updateCreditsDisplay(finalResult.credit_usage.balance);
    if (finalResult?.credit_usage) showCreditUsage(finalResult.credit_usage);
    window._obFinalResult = finalResult;
    onboardingSearchResults = [];
    const proj = projects.find(p => p.id === id);
    if (proj) proj.tracker_count = (proj.tracker_count || 0) + (finalResult?.generated?.length || 0);
    await obGoStep(id, 9);
  } catch (e) {
    hideProgress();
    toast(e.message, 'error');
    btn.disabled = false;
    btn.innerHTML = '▶ Generate & Save to Drafts';
  }
}

// ── Step 9: Complete ───────────────────────────────────────

async function renderObStep9(id, page) {
  const finalResult = window._obFinalResult;
  const generated = finalResult?.generated || [];
  const genHtml = generated.length > 0 ? `
    <div class="ob-gen-results">
      ${generated.map(r => `
        <div class="ob-gen-item">
          <span>${r.pdf && r.draft ? '✅' : '⚠️'}</span>
          <span>${esc(r.firm)}</span>
          ${r.pdf ? '<span class="badge badge-ok">PDF</span>' : ''}
          ${r.draft ? '<span class="badge badge-ok">Draft</span>' : ''}
        </div>`).join('')}
    </div>` : '';
  page.innerHTML = `
    <div class="ob-card ob-card-complete">
      ${obProgressBar(OB_TOTAL_STEPS)}
      <div class="ob-complete-icon">
        <svg viewBox="0 0 52 52" width="64" height="64">
          <circle cx="26" cy="26" r="25" fill="none" stroke="var(--accent)" stroke-width="2"/>
          <path fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M14 27l8 8 16-16"/>
        </svg>
      </div>
      <h2 class="ob-complete-title">Setup Complete!</h2>
      <p class="ob-complete-msg">${generated.length > 0
        ? `${generated.length} application${generated.length !== 1 ? 's' : ''} generated and saved to your email drafts.`
        : 'Your project is ready. Search for positions and generate applications anytime.'}</p>
      ${genHtml}
      <button class="btn btn-primary ob-complete-btn" onclick="obFinish('${id}')">
        View My Project →
      </button>
    </div>`;
}

async function obFinish(id) {
  try {
    await api("PUT", `/projects/${id}/config`, { onboarding_complete: true });
    const proj = projects.find(p => p.id === id);
    if (proj) proj.onboarding_complete = true;
  } catch (e) { console.warn('Failed to save onboarding_complete:', e); }
  window._obFinalResult = null;
  activeProjectId = id;
  showView('viewProjectHome');
  updateTopBarSelect();
  await renderProjectHome(id);
}

// ── Utility ───────────────────────────────────────────────

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Boot ──────────────────────────────────────────────────
init().catch(e => {
  console.error("Init failed:", e);
  hideLoading();
  const landingPage = document.getElementById("landingPage");
  if (landingPage) {
    landingPage.style.display = "";
  } else {
    const loginPage = document.getElementById("loginPage");
    if (loginPage) loginPage.style.display = "";
  }
});

// ── Scroll Glow Orbs — depth parallax via top (vh) ───────
(function () {
  function makeOrb(cls) {
    const el = document.createElement("div");
    el.className = cls;
    document.body.appendChild(el);
    return el;
  }

  // startVh = initial top (vh), travel = how many vh it moves across full scroll
  // Near orbs: large + big travel. Far orbs: small (CSS) + tiny travel.
  const layers = [
    { el: makeOrb("glow-orb glow-orb-r"), startVh:  8, travel: 65, lerp: 0.045 },
    { el: makeOrb("glow-orb glow-orb-l"), startVh: 42, travel: 42, lerp: 0.038 },
    { el: makeOrb("glow-orb glow-orb-t"), startVh: 18, travel: 22, lerp: 0.030 },
    { el: makeOrb("glow-orb glow-orb-b"), startVh: 62, travel:  8, lerp: 0.022 },
  ];
  layers.forEach(l => { l.cur = l.startVh; l.tgt = l.startVh; });

  window.addEventListener("scroll", function () {
    const f = Math.min(window.scrollY / Math.max(document.body.scrollHeight - window.innerHeight, 1), 1);
    layers.forEach(l => { l.tgt = l.startVh + f * l.travel; });
  }, { passive: true });

  (function tick() {
    layers.forEach(l => {
      l.cur += (l.tgt - l.cur) * l.lerp;
      l.el.style.top = l.cur.toFixed(2) + "vh";
    });
    requestAnimationFrame(tick);
  })();
})();
