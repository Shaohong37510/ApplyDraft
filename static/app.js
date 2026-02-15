/* ═══════════════════════════════════════════════════════════
   Job Application Kit - Frontend
   ═══════════════════════════════════════════════════════════ */

let projects = [];
let activeProjectId = null;
let globalConfig = {};
let pendingTargets = []; // search results awaiting confirmation

// ── API helpers ───────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch("/api" + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

async function uploadFile(path, file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api" + path, { method: "POST", body: fd });
  if (!res.ok) throw new Error("Upload failed");
  return res.json();
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
  globalConfig = await api("GET", "/global-config");
  projects = await api("GET", "/projects");
  renderTabs();
  if (projects.length > 0) {
    switchProject(projects[0].id);
  } else {
    document.getElementById("emptyState").style.display = "";
  }
}

// ── Tabs ──────────────────────────────────────────────────

function renderTabs() {
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
        <div class="template-preview">${esc(tplText || "(not generated yet)")}</div>
        <div class="link-row" onclick="openTypeFile('${id}','${esc(cf.id)}','template.txt')">
          <span class="icon">&#128196;</span> Open template.txt
        </div>

        <label>Custom Definitions</label>
        <div class="template-preview">${esc(defsText || "(not generated yet)")}</div>
        <div class="link-row" onclick="openTypeFile('${id}','${esc(cf.id)}','definitions.txt')">
          <span class="icon">&#128196;</span> Open definitions.txt
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
      <label>Claude API Key</label>
      <input type="password" id="cfgApiKey" value="${esc(globalConfig.api_key || "")}" placeholder="sk-ant-api03-...">
      <div class="row">
        <div>
          <label>Gmail Address</label>
          <input type="email" id="cfgEmail" value="${esc(globalConfig.email || "")}" placeholder="you@gmail.com">
        </div>
        <div>
          <label>Gmail App Password</label>
          <input type="password" id="cfgGmailPass" value="${esc(globalConfig.gmail_app_password || "")}" placeholder="xxxx xxxx xxxx xxxx">
        </div>
      </div>
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
      <div class="row">
        <div>
          <label>Your Name</label>
          <input type="text" id="projName" value="${esc(cfg.name || "")}" placeholder="Your Full Name">
        </div>
        <div>
          <label>Phone</label>
          <input type="text" id="projPhone" value="${esc(cfg.phone || "")}" placeholder="123-456-7890">
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
        <button class="btn btn-primary btn-sm" onclick="saveProjectConfig('${id}')">Save Project Config</button>
        <button class="btn btn-secondary btn-sm" onclick="generateProjectMd('${id}')">Generate AI Instructions</button>
      </div>

      <div class="link-row" onclick="openFile('${id}','project.md')">
        <span class="icon">&#128196;</span> Open project.md (AI instruction file)
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
        <button class="btn btn-secondary btn-sm add-type-btn" onclick="promptAddCustomizeFile('${id}')">+ Add Type</button>
      </div>

      <div id="customizeFilesContainer">
        ${customizeHtml}
      </div>

      <div class="link-row" onclick="openOutputFolder('${id}')" style="margin-top:8px">
        <span class="icon">&#128194;</span> View All Generated Files
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
      <label>Paste an example email (full text)</label>
      <textarea id="emailExampleText" rows="6" placeholder="Dear Hiring Manager,&#10;&#10;I am writing to apply for...&#10;&#10;Best regards,&#10;Your Name">${esc(emailTpl.example || "")}</textarea>

      <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
        <button class="btn btn-secondary btn-sm" onclick="saveEmailExample('${id}')">Save Example</button>
        <button class="btn btn-primary btn-sm" onclick="generateEmailTemplate('${id}')">&#9998; Generate Template</button>
      </div>

      <label>Template</label>
      <div class="template-preview">${esc(emailTpl.template || "(not generated yet)")}</div>
      <div class="link-row" onclick="openTypeFile('${id}','email_body','template.txt')">
        <span class="icon">&#128196;</span> Open template.txt
      </div>

      <label>Custom Definitions</label>
      <div class="template-preview">${esc(emailTpl.definitions || "(not generated yet)")}</div>
      <div class="link-row" onclick="openTypeFile('${id}','email_body','definitions.txt')">
        <span class="icon">&#128196;</span> Open definitions.txt
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

      <div id="runResults"></div>

      <div class="link-row" onclick="openTracker('${id}')" style="margin-top:8px">
        <span class="icon">&#128202;</span> View Generated Positions (${proj.tracker_count} records)
      </div>
    </div>
  </div>

  <!-- ═══ Section: Token Usage ══════════════════════════════ -->
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <h3><span>&#128200;</span> Token Usage</h3>
      <span class="arrow">&#9662;</span>
    </div>
    <div class="section-body">
      <div id="tokenUsageSummary">
        <span style="color:var(--text2);font-size:12px">Loading...</span>
      </div>
    </div>
  </div>
  `;

  // Load token usage data
  loadTokenUsage(id);
}

// ── Section toggle ────────────────────────────────────────

function toggleSection(header) {
  header.parentElement.classList.toggle("collapsed");
}

// ── Global config ─────────────────────────────────────────

async function saveGlobalConfig() {
  const data = {
    api_key: document.getElementById("cfgApiKey").value,
    email: document.getElementById("cfgEmail").value,
    gmail_app_password: document.getElementById("cfgGmailPass").value,
  };
  await api("POST", "/global-config", data);
  globalConfig = data;
  toast("Global settings saved");
}

// ── Project config ────────────────────────────────────────

async function saveProjectConfig(id) {
  const data = {
    name: document.getElementById("projName").value,
    phone: document.getElementById("projPhone").value,
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
  if (!text.trim()) { toast("Paste an email first", "error"); return; }
  try {
    await api("POST", `/projects/${id}/email-template/save-example`, { text });
    toast("Email example saved");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function generateEmailTemplate(id) {
  const text = document.getElementById("emailExampleText").value;
  if (!text.trim()) { toast("Paste an email first", "error"); return; }
  try {
    // Save first, then generate
    await api("POST", `/projects/${id}/email-template/save-example`, { text });
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
      pathEl.innerHTML = `<a href="#" class="preview-link">${esc(result.pdf_path)}</a>`;
      pathEl.querySelector('.preview-link').addEventListener('click', (e) => {
        e.preventDefault();
        openPdf(id, result.pdf_path);
      });
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
    let html = '<div class="search-results-panel">';
    html += '<div class="search-results-title">Search Results - Review & Confirm</div>';

    if (pendingTargets.length > 0) {
      pendingTargets.forEach((t, i) => {
        html += `<div class="search-result-row" id="searchRow_${i}">
          <div class="search-result-info">
            <span class="firm-name">${esc(t.firm)}</span>
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
      <span class="search-count">${pendingTargets.length} position(s) ready</span>
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

function removeSearchTarget(index) {
  pendingTargets.splice(index, 1);
  const row = document.getElementById(`searchRow_${index}`);
  if (row) row.remove();
  // Update count
  const countEl = document.querySelector(".search-count");
  if (countEl) countEl.textContent = `${pendingTargets.length} position(s) ready`;
  if (pendingTargets.length === 0) {
    const confirmBtn = document.getElementById("confirmBtn");
    if (confirmBtn) confirmBtn.disabled = true;
  }
}

async function confirmAndGenerate(id) {
  if (pendingTargets.length === 0) {
    toast("No positions to generate", "error");
    return;
  }

  const confirmBtn = document.getElementById("confirmBtn");
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = '<span class="spinner"></span> Generating...';

  showProgress("Generating Applications", `0 / ${pendingTargets.length} positions`, false);
  updateProgress(0);

  try {
    const response = await fetch(`/api/projects/${id}/generate-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: pendingTargets }),
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

      toast(`Done: ${finalResult.generated.length} generated`);
      if (usage) showTokenUsage(usage);
      if (finalResult.save_error) {
        toast(finalResult.save_error, "error");
      }
    }

    document.getElementById("runResults").innerHTML = html;
    pendingTargets = [];
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

// ── Utility ───────────────────────────────────────────────

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Boot ──────────────────────────────────────────────────
init();
