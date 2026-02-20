/* ═══════════════════════════════════════════════════════════
   ApplyDraft - Frontend
   ═══════════════════════════════════════════════════════════ */

let projects = [];
let activeProjectId = null;
let globalConfig = {};
let pendingTargets = []; // search results awaiting confirmation
let manualTargets = []; // manually added targets
let supabaseClient = null;
let accessToken = null;
let currentUser = null;

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

// ── API helpers ───────────────────────────────────────────

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

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (accessToken) {
    opts.headers["Authorization"] = `Bearer ${accessToken}`;
  }
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch("/api" + path, opts);
  if (res.status === 401) {
    // Token expired — try to refresh
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
  // Smooth scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

  // Check for payment success/cancel in URL
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("payment") === "success") {
    toast("Payment successful! Credits added.");
    window.history.replaceState({}, "", "/");
  } else if (urlParams.get("payment") === "cancelled") {
    toast("Payment cancelled", "error");
    window.history.replaceState({}, "", "/");
  }

  if (supabaseClient) {
    // Listen for auth state changes
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        accessToken = session.access_token;
        showApp();
        await loadApp();
      } else {
        accessToken = null;
        showLanding();
      }
    });

    // Check existing session
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      accessToken = session.access_token;
      showApp();
      await loadApp();
    } else {
      showLanding();
    }
  } else {
    // No Supabase configured — run without auth (dev mode)
    showApp();
    await loadApp();
  }
}

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
  renderTabs();
  if (projects.length > 0) {
    switchProject(projects[0].id);
  } else {
    document.getElementById("emptyState").style.display = "";
  }
}

// ── Tabs ──────────────────────────────────────────────────

function renderTabs() {
  // Update project dropdown in top bar
  const sel = document.getElementById("projectSelect");
  const delBtn = document.getElementById("deleteProjectBtn");
  if (sel) {
    if (projects.length === 0) {
      sel.innerHTML = `<option value="">No projects</option>`;
    } else {
      sel.innerHTML = projects.map(p =>
        `<option value="${p.id}"${p.id === activeProjectId ? " selected" : ""}>${esc(p.name)}</option>`
      ).join("");
    }
  }
  if (delBtn) delBtn.style.display = projects.length === 0 ? "none" : "";

  // Keep tab bar in sync (hidden via CSS)
  const bar = document.getElementById("tabBar");
  const addBtn = document.getElementById("addProjectBtn");
  bar.querySelectorAll(".tab").forEach(t => t.remove());
  projects.forEach(p => {
    const tab = document.createElement("div");
    tab.className = "tab" + (p.id === activeProjectId ? " active" : "");
    tab.innerHTML = `
      <span onclick="switchProject('${p.id}')">${esc(p.name)}</span>
      <span class="close-tab" onclick="event.stopPropagation();confirmDeleteProject('${p.id}','${esc(p.name)}')">&times;</span>
    `;
    bar.insertBefore(tab, addBtn);
  });
}

async function deleteActiveProject() {
  if (!activeProjectId) return;
  const proj = projects.find(p => p.id === activeProjectId);
  if (proj) confirmDeleteProject(proj.id, proj.name);
}

async function switchProject(id) {
  activeProjectId = id;
  renderTabs();
  await renderProject(id);
}

async function promptNewProject() {
  const name = prompt("Project name:");
  if (!name) return;
  const proj = await api("POST", "/projects", { name });
  projects.push(proj);
  renderTabs();
  switchProject(proj.id);
  toast("Project created");
}

async function confirmDeleteProject(id, name) {
  if (!confirm(`Delete project "${name}"?`)) return;
  await api("DELETE", `/projects/${id}`);
  projects = projects.filter(p => p.id !== id);
  if (activeProjectId === id) {
    activeProjectId = projects.length > 0 ? projects[0].id : null;
  }
  renderTabs();
  if (activeProjectId) switchProject(activeProjectId);
  else {
    document.getElementById("mainContent").innerHTML = `
      <div class="empty-state" id="emptyState">
        <h2>Job Application Kit</h2>
        <p>Create a project to get started</p>
        <button class="btn btn-primary" onclick="promptNewProject()">+ New Project</button>
      </div>`;
  }
  toast("Project deleted");
}

document.getElementById("addProjectBtn").onclick = promptNewProject;

// ── Render Project ────────────────────────────────────────

async function renderProject(id) {
  const proj = await api("GET", `/projects/${id}`);
  const cfg = proj.config || {};
  const tpls = proj.templates || {};
  const customizeFiles = cfg.customize_files || [];

  // Fetch examples for each customize file type in parallel
  const examplesMap = {};
  await Promise.all(customizeFiles.map(async (cf) => {
    examplesMap[cf.id] = await api("GET", `/projects/${id}/customize/${cf.id}/examples`).catch(() => []);
  }));

  // Build attachment checkboxes (customize files that can be PDF attachments)
  const attachableFiles = customizeFiles.filter(cf => cf.id !== "email_body");
  let attachmentCheckboxes = attachableFiles.map(cf => {
    const checked = cf.is_attachment !== false ? "checked" : "";
    return `<label class="attach-check">
      <input type="checkbox" ${checked} onchange="toggleAttachment('${id}','${esc(cf.id)}',this.checked)">
      <span>${esc(cf.label)}</span>
    </label>`;
  }).join("");

  // Fetch email template data
  const emailTpl = await api("GET", `/projects/${id}/email-template`).catch(() => ({}));

  // Build customize files HTML (exclude email_body — shown in its own section)
  let customizeHtml = "";
  customizeFiles.filter(cf => cf.id !== "email_body").forEach((cf, idx) => {
    const typeExamples = examplesMap[cf.id] || [];
    const typeTpl = tpls[cf.id] || {};
    const tplText = typeTpl.template || "";
    const defsText = typeTpl.definitions || "";
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
        <textarea class="tpl-textarea" id="tpl-${esc(cf.id)}" rows="10">${esc(tplText)}</textarea>

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
  <div class="section">
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

      <!-- Gmail settings -->
      <div id="gmailSettings" style="display:${(globalConfig.email_provider || "gmail") === "gmail" ? "block" : "none"}">
        ${globalConfig.gmail_connected
          ? `<div style="display:flex;align-items:center;gap:12px;padding:10px;background:#e8f5e9;border-radius:6px">
              <span style="color:#2e7d32;font-size:18px">&#10003;</span>
              <span>Connected: <strong>${esc(globalConfig.gmail_email || globalConfig.email || "")}</strong></span>
              <button class="btn btn-secondary btn-sm" onclick="disconnectGmail()" style="margin-left:auto">Disconnect</button>
            </div>`
          : `<button class="btn btn-primary btn-sm" onclick="connectGmail()">Connect Gmail Account</button>
             <div style="margin-top:6px;font-size:12px;color:#666">Connect your Gmail account via Google OAuth to create email drafts</div>`
        }
      </div>

      <!-- Outlook settings -->
      <div id="outlookSettings" style="display:${globalConfig.email_provider === "outlook" ? "block" : "none"}">
        ${globalConfig.outlook_connected
          ? `<div style="display:flex;align-items:center;gap:12px;padding:10px;background:#e8f5e9;border-radius:6px">
              <span style="color:#2e7d32;font-size:18px">&#10003;</span>
              <span>Connected: <strong>${esc(globalConfig.outlook_email || "")}</strong></span>
              <button class="btn btn-secondary btn-sm" onclick="disconnectOutlook()" style="margin-left:auto">Disconnect</button>
            </div>`
          : `<button class="btn btn-primary btn-sm" onclick="connectOutlook()">Connect Outlook Account</button>
             <div style="margin-top:6px;font-size:12px;color:#666">Supports school (.edu) and personal Outlook accounts</div>`
        }
      </div>

      <!-- No email -->
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
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <h3><span>&#128221;</span> Project: ${esc(cfg.project_name || id)}</h3>
      <span class="arrow">&#9662;</span>
    </div>
    <div class="section-body">
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
        <button class="btn btn-primary btn-sm" onclick="saveProjectConfig('${id}')">Save Project Config</button>
        <button class="btn btn-secondary btn-sm" onclick="generateProjectMd('${id}')">Generate AI Instructions</button>
      </div>

    </div>
  </div>

  <!-- ═══ Section: Customize Files ═════════════════════════ -->
  <div class="section">
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


    </div>
  </div>

  <!-- ═══ Section: Email Template ══════════════════════════ -->
  <div class="section">
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
        <button class="btn btn-secondary btn-sm" onclick="saveEmailExample('${id}')">Save Example</button>
        <button class="btn btn-primary btn-sm" onclick="generateEmailTemplate('${id}')">&#9998; Generate Template</button>
      </div>

      <label>Template</label>
      <textarea class="tpl-textarea" id="tpl-email_body" rows="10">${esc(emailTpl.template || "")}</textarea>

      <label>Custom Definitions</label>
      <textarea class="tpl-textarea" id="def-email_body" rows="6">${esc(emailTpl.definitions || "")}</textarea>

      <div style="margin-top:8px">
        <button class="btn btn-secondary btn-sm" onclick="saveTemplate('${id}','email_body')">Save Template</button>
      </div>
    </div>
  </div>

  <!-- ═══ Section: Run ═════════════════════════════════════ -->
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <h3><span>&#9654;</span> Search & Generate</h3>
      <span class="arrow">&#9662;</span>
    </div>
    <div class="section-body">
      <div class="run-bar">
        <div class="count-selector">
          <label style="margin:0">Positions:</label>
          <select id="runCount">
            ${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}" ${n===5?"selected":""}>${n}</option>`).join("")}
          </select>
        </div>
        <button class="btn btn-run" id="runBtn" onclick="runSearch('${id}')">
          &#9654; Search
        </button>
      </div>

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
            <button class="btn btn-primary btn-sm" onclick="addManualEntry('${id}')">&#43; Add to Queue</button>
            <span style="font-size:12px;color:var(--text2)">Manual entries are prioritized during generation</span>
          </div>
        </div>
        <div class="manual-entries-list" id="manualEntriesList"></div>
        <div id="generateManualBtnContainer"></div>
      </div>

      <div id="runResults"></div>

      <div style="margin-top:8px">
        <button class="btn btn-secondary btn-sm" onclick="viewTracker('${id}')">
          &#128202; View Applications (${proj.tracker_count} records)
        </button>
        <div id="trackerTable" style="margin-top:12px"></div>
      </div>
    </div>
  </div>

  `;

  // Re-render manual entries if any
  renderManualEntries();
  updateGenerateManualBtn(id);

  // Restore search results if they were pending before re-render
  if (pendingTargets.length > 0) {
    restoreSearchResults(id);
  }
}

// ── Section toggle ────────────────────────────────────────

function toggleSection(header) {
  header.parentElement.classList.toggle("collapsed");
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
  // Update button styles
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
  globalConfig.outlook_connected = false;
  globalConfig.outlook_email = "";
  globalConfig.email_provider = "none";
  location.reload();
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
  globalConfig.gmail_connected = false;
  globalConfig.gmail_email = "";
  globalConfig.email_provider = "none";
  location.reload();
}

// ── Project config ────────────────────────────────────────

async function saveProjectConfig(id) {
  const data = {
    job_requirements: document.getElementById("projJobReq").value,
  };
  await api("PUT", `/projects/${id}/config`, data);
  toast("Project config saved");
}

// ── Materials ─────────────────────────────────────────────

async function uploadMaterials(id, files) {
  for (const file of files) {
    await uploadFile(`/projects/${id}/upload-material`, file);
  }
  toast(`${files.length} file(s) uploaded`);
  renderProject(id);
}

async function deleteMaterial(id, filename) {
  await api("DELETE", `/projects/${id}/material/${filename}`);
  toast("File removed");
  renderProject(id);
}

// ── Attachment toggles ───────────────────────────────────

async function toggleAttachment(id, typeId, checked) {
  // Update the customize_files entry's is_attachment field
  const proj = await api("GET", `/projects/${id}`);
  const cfs = proj.config.customize_files || [];
  const updated = cfs.map(cf => cf.id === typeId ? {...cf, is_attachment: checked} : cf);
  await api("PUT", `/projects/${id}/config`, { customize_files: updated });
  toast(checked ? "Will attach" : "Won't attach");
}

// ── Customize File Types ─────────────────────────────────

async function promptAddCustomizeFile(id) {
  const label = prompt("File type name (e.g. Work Sample, Thank You Letter):");
  if (!label) return;
  try {
    await api("POST", `/projects/${id}/customize-files`, { label });
    toast(`"${label}" added`);
    renderProject(id);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function removeCustomizeFile(id, typeId, label) {
  if (!confirm(`Remove "${label}" and all its templates/examples?`)) return;
  try {
    await api("DELETE", `/projects/${id}/customize-files/${typeId}`);
    toast(`"${label}" removed`);
    renderProject(id);
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
  renderProject(id);
}

async function deleteTypeExample(id, typeId, filename) {
  await api("DELETE", `/projects/${id}/customize/${typeId}/examples/${filename}`);
  toast("Example removed");
  renderProject(id);
}

// ── Per-type Template generation ─────────────────────────

async function generateTypeTemplate(id, typeId) {
  try {
    toast("Generating template... (this may take a moment)", "success");
    const result = await api("POST", `/projects/${id}/customize/${typeId}/generate-template`);
    toast("Template generated!");
    if (result.token_usage) showTokenUsage(result.token_usage);
    renderProject(id);
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
    toast("Email example saved");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function generateEmailTemplate(id) {
  const text = document.getElementById("emailExampleText").value;
  const subjectTemplate = document.getElementById("emailSubjectTemplate").value;
  const smartSubject = document.getElementById("smartSubjectEnabled").checked;
  if (!text.trim()) { toast("Paste an email first", "error"); return; }
  try {
    // Save first, then generate
    await api("POST", `/projects/${id}/email-template/save-example`, {
      text, subject_template: subjectTemplate, smart_subject: smartSubject
    });
    toast("Generating email template...", "success");
    const result = await api("POST", `/projects/${id}/email-template/generate`);
    toast("Email template generated!");
    if (result.token_usage) showTokenUsage(result.token_usage);
    renderProject(id);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Per-type Preview ─────────────────────────────────────

async function previewTypeTemplate(id, typeId) {
  try {
    toast("Generating preview PDF...", "success");
    const result = await api("POST", `/projects/${id}/customize/${typeId}/preview`);
    const pathEl = document.getElementById(`previewPath_${typeId}`);
    if (pathEl) {
      pathEl.innerHTML = `<a href="#" class="preview-link" onclick="apiOpenPdf('/projects/${id}/customize/${typeId}/preview-pdf');return false;">&#128065; Open Preview PDF</a>`;
    }
    toast("Preview generated!");
    if (result.token_usage) showTokenUsage(result.token_usage);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Project MD ────────────────────────────────────────────

async function generateProjectMd(id) {
  try {
    await saveProjectConfig(id);
    toast("Generating AI instructions...", "success");
    const result = await api("POST", `/projects/${id}/generate-project-md`);
    toast("project.md generated!");
    if (result.token_usage) showTokenUsage(result.token_usage);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Template inline editing ────────────────────────────────

async function saveTemplate(projectId, typeId) {
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

async function viewTracker(id) {
  const container = document.getElementById("trackerTable");
  if (!container) return;
  try {
    const rows = await api("GET", `/projects/${id}/tracker`);
    if (!rows || rows.length === 0) {
      container.innerHTML = `<p style="color:var(--text2);font-size:13px">No applications yet.</p>`;
      return;
    }
    const cols = ["Firm", "Position", "Location", "Status", "AppliedDate", "Email"];
    container.innerHTML = `<div class="tracker-wrap"><table class="tracker-table">
      <thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c] || "")}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
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
  // Mark previous active steps as done
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
  const btn = document.getElementById("runBtn");
  const resultsDiv = document.getElementById("runResults");
  const count = parseInt(document.getElementById("runCount").value);

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Searching...';
  resultsDiv.innerHTML = "";

  // Show progress modal with animated steps
  showProgress("Searching for Positions", "Preparing search...", true);

  try {
    await saveProjectConfig(id);
    updateProgress(null, "Connecting to AI...");
    animateSearchProgress();

    const result = await api("POST", `/projects/${id}/search`, { count });

    finishAllProgressSteps();
    updateProgress(100, "Search complete!");
    await new Promise(r => setTimeout(r, 600));
    hideProgress();

    pendingTargets = result.targets || [];
    const skipped = result.skipped || [];

    if (pendingTargets.length === 0 && skipped.length === 0) {
      resultsDiv.innerHTML = `<div style="color:var(--text2);font-size:13px;padding:12px 0">${esc(result.error || "No positions found. Try adjusting your requirements.")}</div>`;
      return;
    }

    // Show search results for user review
    const totalReady = manualTargets.length + pendingTargets.length;
    let html = '<div class="search-results-panel">';
    html += '<div class="search-results-title">Search Results - Review & Confirm</div>';

    // Show manual entries first (prioritized)
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
        const sourceLink = t.source ? `<a href="${esc(t.source)}" target="_blank" rel="noopener" class="source-link" title="View job posting">&#128279;</a>` : '';
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

    if (result.token_usage) {
      html += `<div class="token-usage-inline">${renderTokenBadge(result.token_usage)}</div>`;
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
    const sourceLink = t.source ? `<a href="${esc(t.source)}" target="_blank" rel="noopener" class="source-link" title="View job posting">&#128279;</a>` : '';
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
  // Merge manual (prioritized first) + searched targets
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
    // Gather email subject settings
    const subjectTemplateEl = document.getElementById("emailSubjectTemplate");
    const smartSubjectEl = document.getElementById("smartSubjectEnabled");
    const subjectTemplate = subjectTemplateEl ? subjectTemplateEl.value : "";
    const smartSubject = smartSubjectEl ? smartSubjectEl.checked : false;

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

      // Process complete SSE messages
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";  // keep incomplete line

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

    // Render results
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

      const usage = finalResult.token_usage;
      if (usage && (usage.input_tokens || usage.output_tokens)) {
        html += `<div class="token-usage-inline">${renderTokenBadge(usage)}</div>`;
      }

      if (usage) showTokenUsage(usage);
      if (finalResult.save_error) {
        toast(finalResult.save_error, "error");
      }

      // Show celebration popup
      showCelebration(finalResult.generated);
    }

    document.getElementById("runResults").innerHTML = html;
    pendingTargets = [];
    manualTargets = [];
    renderProject(id);
  } catch (e) {
    hideProgress();
    toast(e.message, "error");
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = "&#9654; Confirm & Generate";
  }
}

// ── Token Usage ───────────────────────────────────────────

function formatTokenUsage(usage) {
  if (!usage) return "";
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const calls = usage.api_calls || 0;
  const costIn = (inp * 0.80 / 1000000).toFixed(4);
  const costOut = (out * 4 / 1000000).toFixed(4);
  const costTotal = (parseFloat(costIn) + parseFloat(costOut)).toFixed(4);
  return `Tokens: ${inp.toLocaleString()} in / ${out.toLocaleString()} out (${calls} call${calls>1?"s":""}) | Cost: $${costTotal}`;
}

function showTokenUsage(usage) {
  if (!usage || (!usage.input_tokens && !usage.output_tokens)) return;
  toast(formatTokenUsage(usage), "success");
}

function renderTokenBadge(usage) {
  if (!usage) return "";
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  if (!inp && !out) return "";
  const costIn = (inp * 0.80 / 1000000).toFixed(4);
  const costOut = (out * 4 / 1000000).toFixed(4);
  const costTotal = (parseFloat(costIn) + parseFloat(costOut)).toFixed(4);
  return `<span class="token-badge">${inp.toLocaleString()} in / ${out.toLocaleString()} out | $${costTotal}</span>`;
}

async function loadTokenUsage(id) {
  try {
    const data = await api("GET", `/projects/${id}/token-usage`);
    const el = document.getElementById("tokenUsageSummary");
    if (!el) return;
    const t = data.totals || {};
    if (!t.input_tokens && !t.output_tokens) {
      el.innerHTML = '<span style="color:var(--text2);font-size:12px">No API usage yet</span>';
      return;
    }
    el.innerHTML = `
      <div class="token-summary">
        <div class="token-stat">
          <span class="token-stat-label">Input Tokens</span>
          <span class="token-stat-value">${(t.input_tokens||0).toLocaleString()}</span>
          <span class="token-stat-cost">$${(t.input_cost||0).toFixed(4)}</span>
        </div>
        <div class="token-stat">
          <span class="token-stat-label">Output Tokens</span>
          <span class="token-stat-value">${(t.output_tokens||0).toLocaleString()}</span>
          <span class="token-stat-cost">$${(t.output_cost||0).toFixed(4)}</span>
        </div>
        <div class="token-stat">
          <span class="token-stat-label">Total Cost</span>
          <span class="token-stat-value token-stat-total">$${(t.total_cost||0).toFixed(4)}</span>
          <span class="token-stat-cost">${(t.api_calls||0)} API calls</span>
        </div>
      </div>
      <details class="token-log-details">
        <summary>View Log (${(data.log||[]).length} entries)</summary>
        <div class="token-log">
          ${(data.log||[]).reverse().map(e => `
            <div class="token-log-row">
              <span class="token-log-time">${e.timestamp ? new Date(e.timestamp).toLocaleString() : ""}</span>
              <span class="token-log-op">${esc(e.operation)}</span>
              <span class="token-log-tokens">${(e.input_tokens||0).toLocaleString()} in / ${(e.output_tokens||0).toLocaleString()} out</span>
            </div>
          `).join("")}
        </div>
      </details>
    `;
  } catch (e) {
    // silently ignore
  }
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

function addManualEntry(projectId) {
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
  updateGenerateManualBtn(projectId);

  // Clear form
  document.getElementById("manualFirm").value = "";
  document.getElementById("manualEmail").value = "";
  document.getElementById("manualPosition").value = "";
  document.getElementById("manualLocation").value = "";
  document.getElementById("manualWebsite").value = "";

  toast(`Added ${firm} (manual)`);
}

function updateGenerateManualBtn(projectId) {
  const container = document.getElementById("generateManualBtnContainer");
  if (!container) return;
  if (manualTargets.length > 0) {
    container.innerHTML = `<button class="btn btn-run" onclick="generateManualOnly('${projectId}')" style="margin-top:12px">
      &#9654; Generate ${manualTargets.length} Manual Position${manualTargets.length > 1 ? "s" : ""}
    </button>`;
  } else {
    container.innerHTML = "";
  }
}

async function generateManualOnly(id) {
  // Skip search, go straight to generate with manual targets only
  pendingTargets = [];
  const resultsDiv = document.getElementById("runResults");
  resultsDiv.innerHTML = "";

  // Show a simplified confirm view then auto-generate
  const totalReady = manualTargets.length;
  let html = '<div class="search-results-panel">';
  html += '<div class="search-results-title">Manual Positions - Generating</div>';
  manualTargets.forEach((t, i) => {
    html += `<div class="manual-entry-row">
      <div class="search-result-info">
        <span class="firm-name">${esc(t.firm)}</span>
        <span class="search-detail">${esc(t.position || "")} | ${esc(t.location || "")} | ${esc(t.email || "")}</span>
      </div>
      <span class="manual-badge">Manual</span>
    </div>`;
  });
  html += `<div class="search-results-actions">
    <span class="search-count" id="confirmCount">${totalReady} position(s)</span>
    <button class="btn btn-run" id="confirmBtn" disabled>
      <span class="spinner"></span> Generating...
    </button>
  </div></div>`;
  resultsDiv.innerHTML = html;

  // Directly call confirmAndGenerate
  await confirmAndGenerate(id);
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

// ── Utility ───────────────────────────────────────────────

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Scroll glow orbs ──────────────────────────────────────
(function () {
  function makeOrb(cls) {
    const el = document.createElement("div");
    el.className = cls;
    document.body.appendChild(el);
    return el;
  }
  const orb1 = makeOrb("glow-orb glow-orb-r");
  const orb2 = makeOrb("glow-orb glow-orb-l");
  let c1 = 15, t1 = 15, c2 = 55, t2 = 55;
  window.addEventListener("scroll", function () {
    const f = window.scrollY / Math.max(document.body.scrollHeight - window.innerHeight, 1);
    t1 = 5 + f * 70;
    t2 = 35 + f * 55;
  }, { passive: true });
  (function tick() {
    c1 += (t1 - c1) * 0.04;
    c2 += (t2 - c2) * 0.03;
    orb1.style.top = c1 + "vh";
    orb2.style.top = c2 + "vh";
    requestAnimationFrame(tick);
  })();
})();

// ── Boot ──────────────────────────────────────────────────
init().catch(e => {
  console.error("Init failed:", e);
  // Fallback: show landing page so the user isn't stuck on a blank screen
  hideLoading();
  const landingPage = document.getElementById("landingPage");
  if (landingPage) {
    landingPage.style.display = "";
  } else {
    // If landing page doesn't exist, fall back to login
    const loginPage = document.getElementById("loginPage");
    if (loginPage) loginPage.style.display = "";
  }
});
