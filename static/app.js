/* ═══════════════════════════════════════════════════════════
   Job Application Kit - Frontend
   ═══════════════════════════════════════════════════════════ */

let projects = [];
let activeProjectId = null;
let globalConfig = {};

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
  const examples = await api("GET", `/projects/${id}/examples`).catch(() => []);
  const cfg = proj.config || {};
  const tpls = proj.templates || {};

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

      <label>Attachments</label>
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

      <div style="margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="saveProjectConfig('${id}')">Save Project Config</button>
        <button class="btn btn-secondary btn-sm" onclick="generateProjectMd('${id}')">Generate AI Instructions</button>
      </div>

      <div class="link-row" onclick="openFile('${id}','project.md')">
        <span class="icon">&#128196;</span> Open project.md (AI instruction file)
      </div>
    </div>
  </div>

  <!-- ═══ Section: Templates ═══════════════════════════════ -->
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <h3><span>&#128203;</span> Templates</h3>
      <span class="arrow">&#9662;</span>
    </div>
    <div class="section-body">

      <label>Example Cover Letters (upload 2-3 for AI analysis)</label>
      <div class="file-list" id="exampleList">
        ${examples.map(f => `
          <span class="file-chip">
            &#128196; ${esc(f)}
            <span class="remove" onclick="deleteExample('${id}','${esc(f)}')">&times;</span>
          </span>
        `).join("")}
      </div>
      <div class="upload-area" onclick="document.getElementById('exampleInput').click()">
        <input type="file" id="exampleInput" multiple accept=".txt,.pdf,.docx" onchange="uploadExamples('${id}', this.files)">
        <p>+ Upload example cover letters (.txt recommended)</p>
      </div>

      <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="generateTemplate('${id}')">
          &#9998; Generate Cover Letter Template
        </button>
        <button class="btn btn-secondary btn-sm" onclick="previewTemplate('${id}')">
          &#128065; Preview PDF
        </button>
      </div>

      <label>Cover Letter Template</label>
      <div class="template-preview" id="tplCoverLetter">${esc(tpls["cover_letter.txt"] || "(not generated yet)")}</div>
      <div class="link-row" onclick="openFile('${id}','cover_letter.txt')">
        <span class="icon">&#128196;</span> Open cover_letter.txt
      </div>

      <label>Custom Definitions</label>
      <div class="template-preview" id="tplCustomDefs">${esc(tpls["custom_definitions.txt"] || "(not generated yet)")}</div>
      <div class="link-row" onclick="openFile('${id}','custom_definitions.txt')">
        <span class="icon">&#128196;</span> Open custom_definitions.txt
      </div>

      <label>Email Body Template</label>
      <div class="template-preview" id="tplEmailBody">${esc(tpls["email_body.txt"] || "(not generated yet)")}</div>
      <div class="link-row" onclick="openFile('${id}','email_body.txt')">
        <span class="icon">&#128196;</span> Open email_body.txt
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
        <button class="btn btn-run" id="runBtn" onclick="runPipeline('${id}')">
          &#9654; Run
        </button>
      </div>

      <div id="runResults"></div>

      <div class="link-row" onclick="openTracker('${id}')" style="margin-top:8px">
        <span class="icon">&#128202;</span> View Generated Positions (${proj.tracker_count} records)
      </div>
    </div>
  </div>
  `;
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

// ── Examples ──────────────────────────────────────────────

async function uploadExamples(id, files) {
  for (const file of files) {
    await uploadFile(`/projects/${id}/upload-example`, file);
  }
  toast(`${files.length} example(s) uploaded`);
  renderProject(id);
}

async function deleteExample(id, filename) {
  await api("DELETE", `/projects/${id}/examples/${filename}`);
  toast("Example removed");
  renderProject(id);
}

// ── Template generation ───────────────────────────────────

async function generateTemplate(id) {
  try {
    toast("Generating template... (this may take a moment)", "success");
    const result = await api("POST", `/projects/${id}/generate-template`);
    toast("Template generated!");
    renderProject(id);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function previewTemplate(id) {
  try {
    toast("Generating preview PDF...", "success");
    const result = await api("POST", `/projects/${id}/preview-template`);
    toast(`Preview saved: ${result.pdf_path}`);
    // Auto-open the PDF
    await api("POST", `/projects/${id}/open-file`, { filename: "preview" }).catch(() => {});
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Project MD ────────────────────────────────────────────

async function generateProjectMd(id) {
  try {
    // Save config first
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

async function openTracker(id) {
  try {
    await api("POST", `/projects/${id}/open-tracker`);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Run pipeline ──────────────────────────────────────────

async function runPipeline(id) {
  const btn = document.getElementById("runBtn");
  const resultsDiv = document.getElementById("runResults");
  const count = parseInt(document.getElementById("runCount").value);

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Searching...';
  resultsDiv.innerHTML = "";

  try {
    // Save config first
    await saveProjectConfig(id);

    const result = await api("POST", `/projects/${id}/run`, { count });

    let html = "";

    // Generated
    if (result.generated && result.generated.length > 0) {
      result.generated.forEach(r => {
        const pdfBadge = r.pdf ? '<span class="badge badge-ok">PDF</span>' : '<span class="badge badge-err">No PDF</span>';
        const draftBadge = r.draft ? '<span class="badge badge-ok">Draft</span>' : '<span class="badge badge-warn">No Draft</span>';
        html += `<div class="result-item">
          <span class="status-icon">${r.pdf && r.draft ? "&#9989;" : "&#9888;"}</span>
          <span class="firm-name">${esc(r.firm)}</span>
          ${pdfBadge} ${draftBadge}
        </div>`;
      });
    }

    // Skipped (portal-only)
    if (result.skipped && result.skipped.length > 0) {
      result.skipped.forEach(s => {
        html += `<div class="result-item">
          <span class="status-icon">&#9888;</span>
          <span class="firm-name">${esc(s.firm || s.name || "Unknown")}</span>
          <span class="badge badge-warn">Portal Only</span>
        </div>`;
      });
    }

    if (result.error) {
      html += `<div style="color:var(--red);margin-top:8px;font-size:13px">${esc(result.error)}</div>`;
    }

    resultsDiv.innerHTML = html;
    toast(`Done: ${(result.generated || []).length} generated, ${(result.skipped || []).length} skipped`);

    // Refresh project to update tracker count
    renderProject(id);
  } catch (e) {
    toast(e.message, "error");
    resultsDiv.innerHTML = `<div style="color:var(--red);font-size:13px">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = "&#9654; Run";
  }
}

// ── Utility ───────────────────────────────────────────────

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Boot ──────────────────────────────────────────────────
init();
