"""
AI service: Claude API integration for job search, template generation, and content generation.
Uses Anthropic's built-in web search tool for reliable searching.
All public functions return (result, token_usage) tuples for token tracking.
"""
import json
import re
import time
from anthropic import Anthropic, RateLimitError


# Output token caps (per request)
MAX_OUTPUT_TOKENS = 6000          # Template/content generation
MAX_OUTPUT_TOKENS_GENERATE = 2400 # Per-target custom content generation
MAX_OUTPUT_TOKENS_SUBJECT = 200   # Subject line only

# Search limits by count (matches billing table)
# max_searches: count*2 + 4; max_output: count*1000 + 2000 (cap 12000)
def _search_limits(count: int) -> tuple[int, int]:
    """Return (max_searches, max_output_tokens) for a given position count."""
    max_searches = count + 2
    max_output = min(count * 1000 + 2000, 12000)
    return max_searches, max_output


def _merge_usage(*usages):
    """Merge multiple usage dicts into one cumulative total."""
    total = {"input_tokens": 0, "output_tokens": 0, "api_calls": 0}
    for u in usages:
        if u:
            total["input_tokens"] += u.get("input_tokens", 0)
            total["output_tokens"] += u.get("output_tokens", 0)
            total["api_calls"] += u.get("api_calls", 1)
    return total


def _call_claude(api_key: str, system: str, user_msg: str, max_tokens: int = 4096) -> tuple[str, dict]:
    """Call Claude API and return (text_response, token_usage).
    Retries up to 3 times on rate limit errors."""
    client = Anthropic(api_key=api_key)
    max_tokens = min(max_tokens, MAX_OUTPUT_TOKENS)

    for attempt in range(3):
        try:
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user_msg}],
            )
            break
        except RateLimitError:
            if attempt < 2:
                time.sleep(30 * (attempt + 1))  # 30s, 60s
            else:
                raise

    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "api_calls": 1,
    }
    return response.content[0].text, usage


def _call_claude_with_search(api_key: str, system: str, user_msg: str, max_tokens: int = 8000, max_searches: int = 10) -> tuple[str, dict]:
    """Call Claude API with web search tool enabled. Returns (text_response, token_usage).
    Retries up to 3 times on rate limit errors with increasing delays."""
    client = Anthropic(api_key=api_key)

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=max_tokens,
            system=system,
            tools=[{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": max_searches,
            }],
            messages=[{"role": "user", "content": user_msg}],
        )
    except RateLimitError:
        raise

    # Extract text from response (may contain multiple content blocks)
    text_parts = []
    for block in response.content:
        if hasattr(block, "text") and block.text:
            text_parts.append(block.text)

    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "api_calls": 1,
    }
    return "\n".join(text_parts) if text_parts else "", usage


# ── Generate project.md from job requirements ──────────────────

def generate_project_md(api_key: str, job_requirements: str, user_profile: dict) -> tuple[str, dict]:
    """Generate a project.md instruction file. Returns (md_content, token_usage)."""
    system = """You are an expert job search assistant. Generate a structured markdown instruction file
for an AI agent that will search for jobs and write tailored application materials.
Output ONLY the markdown content, no code fences."""

    profile_lines = []
    if user_profile.get("name"):
        profile_lines.append(f"- Name: {user_profile['name']}")
    if user_profile.get("email"):
        profile_lines.append(f"- Email: {user_profile['email']}")
    if user_profile.get("phone"):
        profile_lines.append(f"- Phone: {user_profile['phone']}")
    profile_text = "\n".join(profile_lines) if profile_lines else "Not provided"

    user_msg = f"""Based on the following job requirements and applicant profile, generate a project.md file that includes:
1. Target locations (cities, priority order)
2. Target positions (exact job titles to search for)
3. Required experience level and qualifications to match
4. Industry/specialization preferences
5. Application filtering rules (experience level, email vs portal, job recency)
6. Custom writing style guidelines that highlight the applicant's background

Job Requirements (natural language):
{job_requirements}

Applicant Profile:
{profile_text}
"""
    return _call_claude(api_key, system, user_msg)


# ── Generate template from example cover letters ───────────────

def generate_template_from_examples(api_key: str, examples: list[str], file_type_label: str = "Cover Letter") -> tuple[dict, dict]:
    """Analyze examples and generate template. Returns (result_dict, token_usage)."""
    system = f"""You are an expert at analyzing {file_type_label} documents and creating reusable HTML templates for PDF generation.
Compare the provided examples to identify:
- FIXED parts (identical or nearly identical across all examples)
- VARIABLE parts (different in each example, customized per firm/position)

Replace each variable section with a {{{{CUSTOM_X}}}} placeholder (numbered sequentially: CUSTOM_1, CUSTOM_2, CUSTOM_3...).
Also support {{{{NAME}}}}, {{{{PHONE}}}}, {{{{EMAIL}}}}, {{{{FIRM_NAME}}}}, {{{{POSITION}}}} as standard placeholders.

IMPORTANT: The "template" must be a COMPLETE HTML document for PDF generation. Follow this structure exactly:

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page {{ margin: 60px 65px; size: letter; }}
  body {{ font-family: 'Segoe UI', Arial, sans-serif; font-size: 10pt; line-height: 1.65; color: #222; margin: 0; padding: 0; }}
  .info {{ margin-bottom: 20px; }}
  .info .name {{ font-weight: 600; }}
  .firm {{ margin-bottom: 8px; }}
  .salutation {{ margin-bottom: 16px; }}
  .body p {{ margin: 0 0 13px 0; text-align: justify; }}
  .closing {{ margin-top: 24px; }}
  .signature {{ margin-top: 4px; font-weight: 600; }}
</style></head><body>
<div class="info">
  <div class="name">{{{{NAME}}}}</div>
  <div>{{{{PHONE}}}}</div>
  <div>{{{{EMAIL}}}}</div>
</div>
<div class="firm">{{{{FIRM_NAME}}}}</div>
<div class="salutation">Dear Hiring Manager,</div>
<div class="body">
  <p>First paragraph with {{{{CUSTOM_1}}}} etc.</p>
  <p>Second paragraph...</p>
  <p>More paragraphs as needed...</p>
</div>
<div class="closing">
  Sincerely,
  <div class="signature">{{{{NAME}}}}</div>
</div>
</body></html>
```

RULES for template:
- Each paragraph of the letter body MUST be wrapped in <p> tags inside <div class="body">
- Keep the number of CUSTOM_X placeholders SMALL (2-5 max). Group related variable content into one placeholder rather than splitting every sentence.
- Use &amp; for & and other HTML entities where needed
- The template must be a complete, valid HTML document

You must return valid JSON with exactly two keys:
- "template": the full HTML template (complete HTML document as shown above)
- "definitions": a structured description of each CUSTOM_X placeholder using this EXACT format:

[CUSTOM_1]: <brief description of what this section is about>
PROMPT: <detailed instruction for AI to generate this content for a specific firm>
EXAMPLES: <one real example extracted from the provided samples>
CONSTRAINTS: <word count and sentence limits, e.g. "30 words. two sentences">
KEY INFORMATIONS: <key personal/professional keywords relevant to this placeholder, e.g. internship companies, software skills, notable projects — drawn from the applicant's background>

[CUSTOM_2]: <brief description>
PROMPT: <detailed instruction>
EXAMPLES: <example>
CONSTRAINTS: <constraints>
KEY INFORMATIONS: <key info>

(continue for all CUSTOM_X placeholders, each block separated by a blank line)
"""

    examples_text = ""
    for i, ex in enumerate(examples, 1):
        examples_text += f"\n--- Example {i} ---\n{ex}\n"

    user_msg = f"""Analyze these {len(examples)} {file_type_label} examples and create a reusable HTML template for PDF generation.
Keep CUSTOM_X placeholders to 2-5 (group related variable content together).
{examples_text}

Return JSON with "template" (complete HTML document) and "definitions" keys."""

    result, usage = _call_claude(api_key, system, user_msg, max_tokens=MAX_OUTPUT_TOKENS)

    # Parse JSON from response
    try:
        json_match = re.search(r'\{[\s\S]*\}', result)
        if json_match:
            parsed = json.loads(json_match.group())
            return {
                "template": parsed.get("template", ""),
                "definitions": parsed.get("definitions", ""),
            }, usage
    except json.JSONDecodeError:
        pass

    return {"template": result, "definitions": "Could not parse definitions. Please edit manually."}, usage


# ── Generate email template from example ───────────────────────

def generate_email_template(api_key: str, example: str) -> tuple[dict, dict]:
    """Generate email body template. Returns (result_dict, token_usage)."""
    system = """You are an expert at analyzing emails and creating reusable templates.
Identify the variable parts and replace them with {{CUSTOM_X}} placeholders.
Standard placeholders: {{NAME}}, {{PHONE}}, {{EMAIL}}, {{FIRM_NAME}}, {{POSITION}}.

Return valid JSON with:
- "template": the email template with placeholders
- "definitions": description of each CUSTOM_X placeholder
"""
    user_msg = f"""Analyze this email example and create a reusable template:\n\n{example}\n\nReturn JSON."""

    result, usage = _call_claude(api_key, system, user_msg)
    try:
        json_match = re.search(r'\{[\s\S]*\}', result)
        if json_match:
            parsed = json.loads(json_match.group())
            return {
                "template": parsed.get("template", ""),
                "definitions": parsed.get("definitions", ""),
            }, usage
    except json.JSONDecodeError:
        pass
    return {"template": result, "definitions": ""}, usage


# ── Search for firms and generate targets ──────────────────────

def search_and_generate_targets(
    api_key: str,
    project_md: str,
    custom_definitions: str,
    job_requirements: str,
    count: int,
    existing_firms: list[str],
) -> tuple[dict, dict]:
    """Search for firms using Claude's built-in web search and generate targets."""

    system = f"""You are a job application assistant. Use web search to find real job openings, then generate exactly {count} application target entries.

PROJECT INSTRUCTIONS:
{project_md}

CUSTOM PLACEHOLDER DEFINITIONS:
{custom_definitions}

RULES:
- Search the web for real, current job openings matching the requirements
- Each entry must be a JSON object with: firm, email, location, position, openDate, subject, source, and custom content fields
- For custom content: read the CUSTOM PLACEHOLDER DEFINITIONS above. For each [CUSTOM_X] defined, include a "custom_X" field (e.g. custom_1, custom_2, custom_3...) with content generated according to its PROMPT and CONSTRAINTS, naturally incorporating the KEY INFORMATIONS keywords where relevant
- SKIP firms that only accept applications through web portals (Greenhouse, Workday, etc.) with no email alternative
- If a firm must be skipped, include it in a separate "skipped" array with reason and portal URL
- Do NOT include firms already applied to: {json.dumps(existing_firms)}
- For email: find the careers/jobs email from the firm's website. Use patterns like jobs@, careers@, hr@, info@, office@
- For subject: check if job posting specifies a required format. Otherwise use "Application for [Position] - [Applicant Name]"
- Return valid JSON: {{"targets": [...], "skipped": [...]}}"""

    user_msg = f"""Search the web for {count} job openings matching these requirements:

{job_requirements}

Find real firms with open positions and generate {count} target entries. Return JSON only."""

    max_searches, max_output = _search_limits(count)
    result, usage = _call_claude_with_search(api_key, system, user_msg, max_tokens=max_output, max_searches=max_searches)

    if not result or not result.strip():
        return {"targets": [], "skipped": [], "error": "AI returned empty response. Try again."}, usage

    # Try to find JSON with targets array
    try:
        json_match = re.search(r'\{[\s\S]*"targets"[\s\S]*\}', result)
        if json_match:
            parsed = json.loads(json_match.group())
            return parsed, usage
    except json.JSONDecodeError:
        pass

    # Fallback: try any JSON object
    try:
        json_match = re.search(r'\{[\s\S]*\}', result)
        if json_match:
            parsed = json.loads(json_match.group())
            if "targets" in parsed:
                return parsed, usage
            # Maybe targets are at top level as a list
            return {"targets": [parsed] if "firm" in parsed else [], "skipped": []}, usage
    except json.JSONDecodeError:
        pass

    # Try JSON array directly
    try:
        arr_match = re.search(r'\[[\s\S]*\]', result)
        if arr_match:
            parsed = json.loads(arr_match.group())
            if isinstance(parsed, list) and len(parsed) > 0:
                return {"targets": parsed, "skipped": []}, usage
    except json.JSONDecodeError:
        pass

    snippet = result[:300].replace('\n', ' ')
    return {"targets": [], "skipped": [], "error": f"Could not parse AI response: {snippet}..."}, usage


# ── Phase 1a: DuckDuckGo pre-search ───────────────────────────

def _ddg_search_jobs(job_requirements: str, count: int) -> str:
    """Pre-search with DuckDuckGo for job context. Returns formatted summary string."""
    try:
        from duckduckgo_search import DDGS
        first_line = job_requirements.split('\n')[0].strip()[:120]
        queries = [
            f"{first_line} job opening apply email",
            f"{first_line} hiring careers",
        ]
        results = []
        with DDGS() as ddgs:
            for q in queries:
                for r in ddgs.text(q, max_results=count):
                    title = r.get('title', '')
                    href = r.get('href', '')
                    body = r.get('body', '')[:100]
                    results.append(f"- {title} | {href} | {body}")
                    if len(results) >= count * 2:
                        break
                if len(results) >= count * 2:
                    break
        if results:
            return "Supplementary search results:\n" + "\n".join(results)
    except Exception:
        pass
    return ""


# ── Phase 1: Search firms (find jobs + email + firm background in one call) ──

def search_firms(
    api_key: str,
    project_md: str,
    job_requirements: str,
    count: int,
    existing_firms: list[str],
) -> tuple[list, list, dict]:
    """Search for job openings in one call: finds firm + email + firm_research.
    Returns (candidates, skipped, usage).
    candidates = [{firm, email, position, location, website, source, openDate, subject, salutation, firm_research}]
    """
    ddg_context = _ddg_search_jobs(job_requirements, count)

    system = f"""You are a job application assistant. Use web search to find real, current job openings and gather key information about each firm.

PROJECT INSTRUCTIONS:
{project_md}

RULES:
- Search for real job openings matching the requirements, posted within the last 60 days if possible
- For each firm found, also:
  1. Find the application email (check careers page, job posting, contact page; decode obfuscated emails like "jobs [at] firm.com" → "jobs@firm.com")
  2. Note any required email subject line format from the job posting
  3. Research the firm briefly: 1-2 notable projects by name, their design philosophy or approach, what makes them distinctive
- SKIP firms that only accept applications through web portals (Greenhouse, Workday, Lever, BambooHR, etc.) with no email option
- Do NOT include firms already applied to: {json.dumps(existing_firms)}
- Return valid JSON: {{"candidates": [...], "skipped": []}}
- Each candidate must have ALL these fields:
  {{"firm": "...", "email": "...", "position": "...", "location": "...", "website": "...", "source": "...", "openDate": "YYYY-MM", "subject": "...", "salutation": "Hiring Manager", "firm_research": "Notable projects: X, Y. Design philosophy: ..."}}
- Each skipped: {{"firm": "...", "reason": "portal only", "portal_url": "..."}}"""

    user_msg = f"""Search for {count} job openings matching these requirements:

{job_requirements}

{ddg_context}

For each firm: find their application email, note the required subject line format if any, and briefly research their notable projects and design approach. Return JSON with candidates array."""

    max_searches = count * 2 + 3
    max_output = min(count * 700 + 1500, 10000)
    result, usage = _call_claude_with_search(api_key, system, user_msg, max_tokens=max_output, max_searches=max_searches)

    if not result or not result.strip():
        return [], [], usage

    parsed = None
    for pattern in [r'\{[\s\S]*"candidates"[\s\S]*\}', r'\{[\s\S]*\}']:
        try:
            m = re.search(pattern, result)
            if m:
                parsed = json.loads(m.group())
                if "candidates" in parsed:
                    break
        except json.JSONDecodeError:
            continue

    if not parsed:
        try:
            m = re.search(r'\[[\s\S]*\]', result)
            if m:
                arr = json.loads(m.group())
                if isinstance(arr, list):
                    parsed = {"candidates": arr, "skipped": []}
        except json.JSONDecodeError:
            pass

    if not parsed:
        return [], [], usage

    return parsed.get("candidates", []) or [], parsed.get("skipped", []) or [], usage


# ── Phase 1b: Extract email for a single firm ──────────────────

def extract_firm_email(api_key: str, firm: str, url: str, position: str) -> tuple[dict, dict]:
    """Phase 1b: Find application email for a specific firm. Returns (details, usage).
    details = {email, openDate, subject}. Handles obfuscated emails."""

    system = """You are a job application assistant. Find the exact email address to submit a job application.

RULES:
- Search the firm's website, careers page, and the job posting URL provided
- Firms often obfuscate emails to block spam scrapers. Decode these formats:
  * "jobs [at] firm [dot] com" → "jobs@firm.com"
  * "careers(at)firm(dot)com" → "careers@firm.com"
  * "info AT company DOT com" → "info@company.com"
  * Emails split with spaces: "jobs @ firm .com" → "jobs@firm.com"
  * HTML-encoded: "&#106;obs&#64;firm.com" → decode to real address
- Common patterns: jobs@, careers@, hr@, apply@, studio@, hello@, info@, hiring@
- Also note: application deadline or open date if visible; required subject line format if specified
- Return JSON only: {"email": "...", "openDate": "YYYY-MM", "subject": ""}
- If truly no email found: {"email": "", "openDate": "", "subject": ""}"""

    user_msg = f"""Find the application email address for:
Firm: {firm}
Position: {position}
Job URL: {url}

Search their careers page and job posting. Decode any obfuscated email. Return JSON only."""

    result, usage = _call_claude_with_search(api_key, system, user_msg, max_tokens=400, max_searches=4)

    try:
        m = re.search(r'\{[\s\S]*\}', result)
        if m:
            parsed = json.loads(m.group())
            return {
                "email": (parsed.get("email") or "").strip(),
                "openDate": (parsed.get("openDate") or "").strip(),
                "subject": (parsed.get("subject") or "").strip(),
            }, usage
    except json.JSONDecodeError:
        pass

    return {"email": "", "openDate": "", "subject": ""}, usage


# ── Generate custom content for a single firm ──────────────────

def generate_custom_content(api_key: str, firm_info: dict, custom_definitions: str, project_md: str) -> tuple[dict, dict]:
    """Generate custom content for a firm. Returns (content_dict, token_usage)."""
    firm_research = firm_info.get('firm_research', '')

    system = f"""You generate tailored cover letter paragraphs for a specific job application.

PROJECT INSTRUCTIONS:
{project_md if project_md else "(none)"}

FIRM RESEARCH (use this to write firm-specific paragraphs):
{firm_research if firm_research else "(none)"}

PLACEHOLDER DEFINITIONS:
{custom_definitions}

CRITICAL RULES:
- Return ONLY a flat JSON object with keys "custom_1", "custom_2", etc. — one per [CUSTOM_N] above
- Do NOT use nested keys or keys like "cover_letter" / "email_body"
- Follow each [CUSTOM_N]'s PROMPT and CONSTRAINTS strictly
- The EXAMPLES in each definition contain the applicant's REAL background — extract all proper nouns (employer names, school, degrees, project names, software) and USE THEM verbatim
- Use FIRM RESEARCH to reference the firm's specific projects and design philosophy
- If KEY INFORMATIONS is present, incorporate those keywords naturally"""

    user_msg = f"""Write tailored cover letter paragraphs for:
Firm: {firm_info.get('firm', '')}
Position: {firm_info.get('position', '')}
Location: {firm_info.get('location', '')}

Use the firm research provided and the applicant's real background from EXAMPLES. Return JSON only with keys custom_1, custom_2, etc."""

    print(f"[PHASE2] firm={firm_info.get('firm','')} has_research={bool(firm_research)}", flush=True)
    result, usage = _call_claude(api_key, system, user_msg, max_tokens=MAX_OUTPUT_TOKENS_GENERATE)
    print(f"[PHASE2] raw_result_len={len(result)}", flush=True)
    try:
        json_match = re.search(r'\{[\s\S]*\}', result)
        if json_match:
            content = json.loads(json_match.group())
            print(f"[PHASE2] content_keys={list(content.keys()) if content else 'EMPTY'}", flush=True)
            return content, usage
    except json.JSONDecodeError as e:
        print(f"[PHASE2] JSON parse error: {e}", flush=True)
    print(f"[PHASE2] content_keys=EMPTY", flush=True)
    return {}, usage


# ── Generate email subject from job posting ────────────────────

def generate_email_subject(api_key: str, firm: str, position: str, website: str, applicant_name: str) -> tuple[str, dict]:
    """Search for a firm's required email subject format and generate the correct subject line.
    Returns (subject_line, token_usage)."""

    system = """You are a job application assistant. Your task is to find if a company has a specific required format for application email subject lines, and generate the correct subject line.

RULES:
- Search the firm's careers/jobs page for any stated email subject format requirements
- Many firms specify exact formats like: "Position Title - Your Name", "Job Reference: XXX", "Application: [Position]", etc.
- If a specific format is found, generate the subject line following that exact format
- If no specific format is found, use the default: "Application for [Position] - [Applicant Name]"
- Return ONLY the subject line text, nothing else. No quotes, no explanation."""

    user_msg = f"""Find the required email subject line format for:
Firm: {firm}
Position: {position}
Website: {website}
Applicant Name: {applicant_name}

Search their careers page and job postings. Return ONLY the formatted subject line."""

    return _call_claude_with_search(api_key, system, user_msg, max_tokens=MAX_OUTPUT_TOKENS_SUBJECT, max_searches=3)
