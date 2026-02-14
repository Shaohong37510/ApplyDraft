"""
AI service: Claude API integration for job search, template generation, and content generation.
Uses DuckDuckGo for web searching (no extra API key needed).
"""
import json
import re
from anthropic import Anthropic
from duckduckgo_search import DDGS


def _search_web(query: str, max_results: int = 8) -> list[dict]:
    """Search the web using DuckDuckGo."""
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        return [{"title": r["title"], "url": r["href"], "snippet": r["body"]} for r in results]
    except Exception as e:
        return [{"title": "Search error", "url": "", "snippet": str(e)}]


def _call_claude(api_key: str, system: str, user_msg: str, max_tokens: int = 4096) -> str:
    """Call Claude API and return the text response."""
    client = Anthropic(api_key=api_key)
    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user_msg}],
    )
    return response.content[0].text


# ── Generate project.md from job requirements ──────────────────

def generate_project_md(api_key: str, job_requirements: str, user_profile: dict) -> str:
    """Generate a project.md instruction file based on natural language job requirements."""
    system = """You are an expert job search assistant. Generate a structured markdown instruction file
for an AI agent that will search for jobs and write tailored application materials.
Output ONLY the markdown content, no code fences."""

    user_msg = f"""Based on the following job requirements, generate a project.md file that includes:
1. Target locations (cities, priority order)
2. Target positions (job titles to search for)
3. Industry/specialization preferences
4. Search platforms to use
5. Application filtering rules (email vs portal)
6. Custom writing style guidelines for cover letters and emails

Job Requirements (natural language):
{job_requirements}

User Profile:
- Name: {user_profile.get('name', 'Not provided')}
- Phone: {user_profile.get('phone', 'Not provided')}
"""
    return _call_claude(api_key, system, user_msg)


# ── Generate template from example cover letters ───────────────

def generate_template_from_examples(api_key: str, examples: list[str], file_type_label: str = "Cover Letter") -> dict:
    """Analyze multiple example files and generate a template with {{CUSTOM_X}} placeholders.

    Returns:
        {
            "template": "Template with {{CUSTOM_X}} placeholders",
            "definitions": "Description of each CUSTOM_X placeholder"
        }
    """
    system = f"""You are an expert at analyzing {file_type_label} documents and creating reusable templates.
Compare the provided examples to identify:
- FIXED parts (identical or nearly identical across all examples)
- VARIABLE parts (different in each example, customized per firm/position)

Replace each variable section with a {{{{CUSTOM_X}}}} placeholder (numbered sequentially).
Also support {{{{NAME}}}}, {{{{PHONE}}}}, {{{{EMAIL}}}}, {{{{FIRM_NAME}}}}, {{{{POSITION}}}} as standard placeholders.

You must return valid JSON with exactly two keys:
- "template": the full template text with placeholders
- "definitions": a description of each CUSTOM_X placeholder, one per line, format: "CUSTOM_X: description"
"""

    examples_text = ""
    for i, ex in enumerate(examples, 1):
        examples_text += f"\n--- Example {i} ---\n{ex}\n"

    user_msg = f"""Analyze these {len(examples)} {file_type_label} examples and create a reusable template:
{examples_text}

Return JSON with "template" and "definitions" keys."""

    result = _call_claude(api_key, system, user_msg, max_tokens=8000)

    # Parse JSON from response
    try:
        # Try to find JSON in the response
        json_match = re.search(r'\{[\s\S]*\}', result)
        if json_match:
            parsed = json.loads(json_match.group())
            return {
                "template": parsed.get("template", ""),
                "definitions": parsed.get("definitions", ""),
            }
    except json.JSONDecodeError:
        pass

    return {"template": result, "definitions": "Could not parse definitions. Please edit manually."}


# ── Generate email template from example ───────────────────────

def generate_email_template(api_key: str, example: str) -> dict:
    """Generate an email body template from a single example."""
    system = """You are an expert at analyzing emails and creating reusable templates.
Identify the variable parts and replace them with {{CUSTOM_X}} placeholders.
Standard placeholders: {{NAME}}, {{PHONE}}, {{EMAIL}}, {{FIRM_NAME}}, {{POSITION}}.

Return valid JSON with:
- "template": the email template with placeholders
- "definitions": description of each CUSTOM_X placeholder
"""
    user_msg = f"""Analyze this email example and create a reusable template:\n\n{example}\n\nReturn JSON."""

    result = _call_claude(api_key, system, user_msg)
    try:
        json_match = re.search(r'\{[\s\S]*\}', result)
        if json_match:
            parsed = json.loads(json_match.group())
            return {
                "template": parsed.get("template", ""),
                "definitions": parsed.get("definitions", ""),
            }
    except json.JSONDecodeError:
        pass
    return {"template": result, "definitions": ""}


# ── Preview: fill template with sample content ─────────────────

def preview_template(api_key: str, template: str, definitions: str, firm_name: str = "Example Studio") -> str:
    """Fill a template with AI-generated sample content for preview."""
    system = "You generate realistic sample content to fill cover letter template placeholders. Output ONLY the filled text, no explanation."

    user_msg = f"""Fill the following template placeholders with realistic sample content.

Template:
{template}

Placeholder definitions:
{definitions}

Use these values:
- {{{{NAME}}}}: Jane Doe
- {{{{PHONE}}}}: 555-123-4567
- {{{{EMAIL}}}}: jane.doe@email.com
- {{{{FIRM_NAME}}}}: {firm_name}
- {{{{POSITION}}}}: Architectural Designer

For each {{{{CUSTOM_X}}}} placeholder, generate appropriate content based on its definition.
Return ONLY the filled template text."""

    return _call_claude(api_key, system, user_msg)


# ── Search for firms and generate targets ──────────────────────

def search_and_generate_targets(
    api_key: str,
    project_md: str,
    custom_definitions: str,
    job_requirements: str,
    count: int,
    existing_firms: list[str],
) -> list[dict]:
    """Search for firms and generate complete target entries."""

    # Step 1: Search the web
    search_queries = _generate_search_queries(api_key, job_requirements, count)
    all_results = []
    for query in search_queries:
        results = _search_web(query)
        all_results.extend(results)

    search_context = json.dumps(all_results[:30], ensure_ascii=False, indent=1)

    # Step 2: Ask Claude to analyze results and generate targets
    system = f"""You are a job application assistant. Based on web search results, generate exactly {count} job application target entries.

PROJECT INSTRUCTIONS:
{project_md}

CUSTOM PLACEHOLDER DEFINITIONS (for generating custom_p1, custom_p2, etc.):
{custom_definitions}

RULES:
- Each entry must be a JSON object with: firm, email, location, position, openDate, subject, custom_p1, custom_p2, custom_p3, custom_p4, source
- SKIP firms that only accept applications through web portals (Greenhouse, Workday, etc.) with no email alternative
- If a firm must be skipped, include it in a separate "skipped" array with reason and portal URL
- Do NOT include firms already applied to: {json.dumps(existing_firms)}
- For email: find the careers/jobs email from the firm's website. Use patterns like jobs@, careers@, hr@, info@, office@
- For subject: check if job posting specifies a required format. Otherwise use "Application for [Position] - [Applicant Name]"
- Fill custom_p1 through custom_p4 according to the placeholder definitions above
- Return valid JSON: {{"targets": [...], "skipped": [...]}}"""

    user_msg = f"""Job requirements: {job_requirements}

Web search results:
{search_context}

Generate {count} target entries. Return JSON only."""

    result = _call_claude(api_key, system, user_msg, max_tokens=8000)

    try:
        json_match = re.search(r'\{[\s\S]*\}', result)
        if json_match:
            parsed = json.loads(json_match.group())
            return parsed
    except json.JSONDecodeError:
        pass

    return {"targets": [], "skipped": [], "error": "Failed to parse AI response"}


def _generate_search_queries(api_key: str, job_requirements: str, count: int) -> list[str]:
    """Generate web search queries based on job requirements."""
    system = "Generate 3-5 web search queries to find job openings. Return one query per line, no numbering, no quotes."
    user_msg = f"I need to find {count} job openings matching: {job_requirements}"

    result = _call_claude(api_key, system, user_msg, max_tokens=500)
    queries = [line.strip() for line in result.strip().split("\n") if line.strip()]
    return queries[:5]


# ── Generate custom content for a single firm ──────────────────

def generate_custom_content(api_key: str, firm_info: dict, custom_definitions: str, project_md: str) -> dict:
    """Generate custom_p1 through custom_p4 for a specific firm."""
    system = f"""Generate custom cover letter and email content for a specific firm.

PROJECT INSTRUCTIONS:
{project_md}

PLACEHOLDER DEFINITIONS:
{custom_definitions}

Return valid JSON with keys: custom_p1, custom_p2, custom_p3, custom_p4"""

    user_msg = f"""Generate custom content for:
Firm: {firm_info.get('firm', '')}
Position: {firm_info.get('position', '')}
Location: {firm_info.get('location', '')}

Return JSON only."""

    result = _call_claude(api_key, system, user_msg)
    try:
        json_match = re.search(r'\{[\s\S]*\}', result)
        if json_match:
            return json.loads(json_match.group())
    except json.JSONDecodeError:
        pass
    return {}
