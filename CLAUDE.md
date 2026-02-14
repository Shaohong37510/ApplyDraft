# Job Application Automation System

## Quick Start
When user says "help me find X firms" or similar:
1. Use WebSearch to find matching firms with open positions
2. Read existing `targets.json` and APPEND new entries (don't overwrite existing ones)
3. Each entry must follow this format:

```json
{
  "firm": "Firm Name",
  "email": "apply@firm.com",
  "location": "City, State",
  "position": "Position Title",
  "openDate": "2026-02",
  "subject": "Email subject (follow firm's requirements if any)",
  "custom_p1": "SHORT phrase for cover letter (see Custom Rules P1)",
  "custom_p2": "1-2 sentences for cover letter (see Custom Rules P2)",
  "custom_p3": "Paragraph for email body (see Custom Rules P3)",
  "custom_p4": "Sentence for email body (see Custom Rules P4)",
  "source": "URL of job posting or where info was found"
}
```

4. **IMPORTANT: Check if the job posting specifies a required email subject format** (e.g. "Subject: [Position] - [Your Name]" or "Reference Code: XXX"). If so, follow their format exactly in the "subject" field. If no format is specified, use the default format.
5. Tell user to run `generate.ps1` to generate Cover Letter PDFs + Gmail drafts + tracker update

## Job Search Criteria
- **Locations**: Customize based on user's target cities
- **Position**: Customize based on user's target roles (e.g. "Junior Architect", "Designer I", "Entry-Level")
- **Sources**: Search across multiple platforms and note the source in `source` field:
  - https://archinect.com/jobs
  - LinkedIn Jobs
  - Google Jobs
  - Firm websites directly
  - Industry-specific job boards
- **Priority**: Prefer newly posted positions (last 1-2 weeks). User may sometimes request mass/cold applications to firms without open postings, or specifically request only fresh postings — follow user's instruction each time.

## File Structure
- `config.json` - User personal info (name, email, phone, gmail_app_password)
- `targets.json` - All target firms (Claude appends to this)
- `generate.ps1` - One-click generator: reads targets.json -> creates Gmail drafts + PDF + tracker
- `templates/cover_letter.html` - HTML template for Cover Letter PDF
- `Material/` - CV, Portfolio, and Recommendation Letter PDFs
- `Email/CoverLetters/` - Generated Cover Letter PDFs
- `tracker.csv` - Auto-updated application tracker

## How generate.ps1 Works
1. Generates Cover Letter PDF via Edge headless (HTML -> PDF)
2. Uploads draft to Gmail via IMAP (with To, Subject, Body, 4 attachments: CV + Portfolio + Recommendation Letter + Cover Letter PDF)
3. Drafts appear in Gmail Drafts folder with Send button — user reviews and clicks Send
4. Requires Gmail App Password in config.json (`gmail_app_password`)

## User Profile (for tailoring cover letters)
<!-- CUSTOMIZE: Fill in your own profile -->
- **Name**: Your Name
- **Education**: Your Degree, University (Year)
- **Current**: Your current role
- **Experience**: List your relevant work experience
- **Skills**: List your technical skills
- **Target**: The type of positions you're looking for

## Custom Writing Rules

### CUSTOM_P1 (firm trait, completes "...drawn to {{FIRM_NAME}} for its focus on")
- Write the firm's most unique characteristic from their official website
- Keep it SHORT (one phrase, ~15-20 words)
- Do NOT copy examples, summarize from firm's website
- Examples for reference only:
  - "its thoughtful approach, strong design rigor, and attention to spatial quality"
  - "its emphasis on spatial clarity, material logic, and well-resolved systems"

### CUSTOM_P2 (cover letter: why I fit, standalone paragraph)
- Structure: 1) firm's trait, 2) a specific project I like, 3) my evaluation, 4) why my background fits
- MUST include firm name, 70-80 words
- Do NOT repeat experience already mentioned in cover letter body paragraphs

### CUSTOM_P3 (email: my relevant experience, based on JOB REQUIREMENTS)
- Match to job posting requirements, adapt tone to firm type
- Large/commercial firms: emphasize large-scale project experience, coordination, technical skills
- Small/artistic firms: emphasize design sensitivity, material exploration, visualization

### CUSTOM_P4 (email: what attracts me, completes "I am particularly drawn to...")
- State what specifically attracts user to THIS firm
- Must include firm name

## Application Method Filter
Before adding a firm to `targets.json`, check how the firm accepts applications:

1. **Email OK** -> Add to `targets.json` normally. Signs:
   - Firm lists a careers/jobs email (e.g. `jobs@`, `careers@`, `hr@`, `recruit@`, `info@`, `office@`)
   - Job posting says "email resume and portfolio to..."
   - Firm contact page provides a general submissions email

2. **Website Portal ONLY -> SKIP, do not add.** Signs:
   - Job posting explicitly states "apply through our career site/portal only"
   - Firm uses ATS platforms (Greenhouse, Workday, Lever, BambooHR, etc.) with **no** email alternative
   - Posting says "applications submitted outside our portal will not be considered"

3. **Both email and portal available** -> Prefer email (add to `targets.json`), note portal URL in `source` field

When skipping a firm, report it to the user with the reason and the portal URL so they can apply manually.

## Important
- Email body should be SHORT (not a full cover letter - that's in the PDF)
- **CRITICAL**: Always check the job posting for required email subject format. Many firms specify exact formats. Follow their format exactly. This is often a screening criterion.
- Script auto-skips firms already in tracker.csv with "Generated" status

## Setup Guide

### Prerequisites
- Windows with Microsoft Edge installed
- Gmail account with App Password enabled
- PowerShell 5.1+

### Steps
1. Edit `config.json` with your personal info
2. Place your CV, Portfolio, and Recommendation Letter PDFs in `Material/` folder
3. Customize `templates/cover_letter.html` with your own cover letter paragraphs
4. Ask Claude to search for firms and populate `targets.json`
5. Run `generate.ps1` to generate Gmail drafts
6. Review drafts in Gmail and click Send

### Gmail App Password Setup
1. Go to https://myaccount.google.com/security
2. Enable 2-Step Verification if not already enabled
3. Go to App Passwords (search "App passwords" in Google Account settings)
4. Generate a new app password for "Mail"
5. Copy the 16-character password into `config.json` field `gmail_app_password`
