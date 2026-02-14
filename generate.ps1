# ============================================================
# Job Application Email Generator
# Reads config.json + targets.json -> Cover Letter PDF + Gmail Draft (IMAP) + tracker.csv
# ============================================================

$ErrorActionPreference = "Stop"
$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$config = Get-Content "$baseDir\config.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$targets = Get-Content "$baseDir\targets.json" -Raw -Encoding UTF8 | ConvertFrom-Json

$materialDir = "$baseDir\Material"
$coverLetterDir = "$baseDir\Email\CoverLetters"
$templatePath = "$baseDir\templates\cover_letter.html"
$trackerPath = "$baseDir\tracker.csv"

if (!(Test-Path "$baseDir\Email")) { New-Item -ItemType Directory -Path "$baseDir\Email" -Force | Out-Null }
if (!(Test-Path $coverLetterDir)) { New-Item -ItemType Directory -Path $coverLetterDir -Force | Out-Null }

$htmlTemplate = Get-Content $templatePath -Raw -Encoding UTF8

# ---- Check attachments ----
$cvPath = "$materialDir\$($config.cv_file)"
$portfolioPath = "$materialDir\$($config.portfolio_file)"
$recPath = "$materialDir\$($config.recommendation_file)"
if (!(Test-Path $cvPath)) { Write-Host "ERROR: CV not found at $cvPath" -ForegroundColor Red; exit 1 }
if (!(Test-Path $portfolioPath)) { Write-Host "ERROR: Portfolio not found at $portfolioPath" -ForegroundColor Red; exit 1 }
if (!(Test-Path $recPath)) { Write-Host "ERROR: Recommendation letter not found at $recPath" -ForegroundColor Red; exit 1 }

# ---- Find Edge ----
$edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (!(Test-Path $edgePath)) { $edgePath = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
if (!(Test-Path $edgePath)) { Write-Host "ERROR: Edge not found" -ForegroundColor Red; exit 1 }

# ---- Encode attachments (reused for all emails) ----
Write-Host "Encoding attachments..." -ForegroundColor Cyan
$cvBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($cvPath))
$portfolioBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($portfolioPath))
$recBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($recPath))

function Wrap-Base64 {
    param([string]$b64)
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $b64.Length; $i += 76) {
        $len = [Math]::Min(76, $b64.Length - $i)
        $sb.AppendLine($b64.Substring($i, $len)) | Out-Null
    }
    return $sb.ToString()
}

$cvWrapped = Wrap-Base64 $cvBase64
$portfolioWrapped = Wrap-Base64 $portfolioBase64
$recWrapped = Wrap-Base64 $recBase64
Write-Host "Attachments encoded." -ForegroundColor Cyan

# ---- Gmail IMAP connection ----
Write-Host "Connecting to Gmail IMAP..." -ForegroundColor Cyan
$imapServer = "imap.gmail.com"
$imapPort = 993
$gmailUser = $config.email
$gmailPass = $config.gmail_app_password

function Connect-Gmail {
    $tcp = New-Object System.Net.Sockets.TcpClient($imapServer, $imapPort)
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false)
    $ssl.AuthenticateAsClient($imapServer)
    $reader = New-Object System.IO.StreamReader($ssl)
    $writer = New-Object System.IO.StreamWriter($ssl)
    $writer.AutoFlush = $true

    # Read greeting
    $reader.ReadLine() | Out-Null

    # Login
    $writer.WriteLine("a1 LOGIN ""$gmailUser"" ""$gmailPass""")
    $resp = ""
    do { $resp = $reader.ReadLine() } while ($resp -notmatch "^a1 ")
    if ($resp -notmatch "^a1 OK") {
        Write-Host "ERROR: Gmail login failed: $resp" -ForegroundColor Red
        exit 1
    }
    Write-Host "Gmail connected." -ForegroundColor Cyan

    return @{ tcp=$tcp; ssl=$ssl; reader=$reader; writer=$writer; cmd=2 }
}

function Send-ImapDraft {
    param($conn, [string]$mimeMessage)

    $msgBytes = [System.Text.Encoding]::UTF8.GetBytes($mimeMessage)
    $byteCount = $msgBytes.Length
    $cmdTag = "a$($conn.cmd)"
    $conn.cmd++

    $conn.writer.WriteLine("$cmdTag APPEND ""[Gmail]/Drafts"" (\Draft) {$byteCount}")

    # Wait for continuation response "+"
    $resp = $conn.reader.ReadLine()
    if ($resp -notmatch "^\+") {
        Write-Host "  ERROR: IMAP APPEND rejected: $resp" -ForegroundColor Red
        return $false
    }

    # Send the raw message bytes
    $conn.ssl.Write($msgBytes, 0, $msgBytes.Length)
    $conn.writer.WriteLine("")  # CRLF to finish

    # Read response
    $resp = ""
    do { $resp = $conn.reader.ReadLine() } while ($resp -notmatch "^$cmdTag ")
    if ($resp -match "OK") { return $true }
    else {
        Write-Host "  ERROR: APPEND failed: $resp" -ForegroundColor Red
        return $false
    }
}

function Close-Gmail {
    param($conn)
    $conn.writer.WriteLine("a99 LOGOUT")
    $conn.reader.ReadLine() | Out-Null
    $conn.ssl.Close()
    $conn.tcp.Close()
}

$gmail = Connect-Gmail

# ---- Tracker ----
$trackerRows = @()
$existingTracker = @()
if (Test-Path $trackerPath) { $existingTracker = Import-Csv $trackerPath -Encoding UTF8 }

# ---- Sanitize firm name for file paths ----
function Get-SafeFileName {
    param([string]$name)
    return ($name -replace '[^a-zA-Z0-9 ]', '_')
}

function Get-DisplayFileName {
    param([string]$name)
    return ($name -replace '[/\\]', '-')
}

# ---- Process targets ----
$index = 0
foreach ($target in $targets) {
    $index++
    $firmSafe = Get-SafeFileName $target.firm
    $firmDisplay = Get-DisplayFileName $target.firm
    $today = Get-Date -Format "yyyy-MM-dd"
    $nameSafe = Get-SafeFileName $config.name

    Write-Host "`n[$index/$($targets.Count)] $($target.firm)" -ForegroundColor Green

    $alreadyExists = $existingTracker | Where-Object { $_.Firm -eq $target.firm -and $_.Status -eq "Generated" }
    if ($alreadyExists) {
        Write-Host "  Skipped (already generated)" -ForegroundColor Yellow
        $trackerRows += $alreadyExists
        continue
    }

    # ---- Cover Letter PDF ----
    $html = $htmlTemplate
    $html = $html.Replace("{{NAME}}", $config.name)
    $html = $html.Replace("{{PHONE}}", $config.phone)
    $html = $html.Replace("{{EMAIL}}", $config.email)
    $html = $html.Replace("{{FIRM_NAME}}", $target.firm)
    $html = $html.Replace("{{POSITION}}", $target.position)
    $html = $html.Replace("{{CUSTOM_P1}}", $target.custom_p1)
    if ($target.custom_p2) { $html = $html.Replace("{{CUSTOM_P2}}", " " + $target.custom_p2) }
    else { $html = $html.Replace("{{CUSTOM_P2}}", "") }

    $htmlPath = "$coverLetterDir\CL_${firmSafe}.html"
    $pdfPath = "$coverLetterDir\${nameSafe}_COVER_LETTER_${firmDisplay}.pdf"
    [System.IO.File]::WriteAllText($htmlPath, $html, [System.Text.Encoding]::UTF8)

    $proc = Start-Process -FilePath $edgePath -ArgumentList "--headless --disable-gpu --no-pdf-header-footer --print-to-pdf=`"$pdfPath`" `"$htmlPath`"" -PassThru -WindowStyle Hidden
    $proc.WaitForExit(15000) | Out-Null

    if (Test-Path $pdfPath) { Write-Host "  PDF ok" -ForegroundColor White }
    else { Write-Host "  PDF failed" -ForegroundColor Yellow }

    # ---- Build MIME message ----
    $boundary = "----=_Part_${index}_" + [guid]::NewGuid().ToString("N").Substring(0,16)
    $emlDate = (Get-Date).ToUniversalTime().ToString("ddd, dd MMM yyyy HH:mm:ss +0000")

    $coverLetterAttachment = ""
    if (Test-Path $pdfPath) {
        $clBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pdfPath))
        $clWrapped = Wrap-Base64 $clBase64
        $clFileName = "${nameSafe}_COVER_LETTER_${firmSafe}.pdf"
        $coverLetterAttachment = @"

--$boundary
Content-Type: application/pdf; name="$clFileName"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="$clFileName"

$clWrapped
"@
    }

    # ---- Attachment file names ----
    $cvFileName = "${nameSafe}_CV.pdf"
    $portfolioFileName = "${nameSafe}_Portfolio.pdf"
    $recFileName = "${nameSafe}_Recommendation_Letter.pdf"

    $mime = @"
MIME-Version: 1.0
From: $($config.name) <$($config.email)>
To: $($target.email)
Subject: $($target.subject)
Date: $emlDate
Content-Type: multipart/mixed; boundary="$boundary"

--$boundary
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 8bit

Dear Hiring Manager,

I am writing to apply for the $($target.position) position at $($target.firm).

$($target.custom_p3)

$($target.custom_p4). I would welcome the opportunity to bring my design experience and skills to your team.

Thank you for your time and consideration. I look forward to the possibility of discussing how I can contribute to your projects.

Best regards,
$($config.name)
$($config.phone)
$($config.email)

--$boundary
Content-Type: application/pdf; name="$cvFileName"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="$cvFileName"

$cvWrapped
--$boundary
Content-Type: application/pdf; name="$portfolioFileName"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="$portfolioFileName"

$portfolioWrapped
--$boundary
Content-Type: application/pdf; name="$recFileName"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="$recFileName"

$recWrapped$coverLetterAttachment
--${boundary}--
"@

    # ---- Upload to Gmail Drafts ----
    $ok = Send-ImapDraft $gmail $mime
    if ($ok) { Write-Host "  Gmail draft saved" -ForegroundColor White }

    $trackerRows += [PSCustomObject]@{
        Firm=$target.firm; Location=$target.location; Position=$target.position
        OpenDate=$target.openDate; AppliedDate=$today; Email=$target.email
        Source=$target.source; Status="Generated"
    }
}

# ---- Cleanup ----
Close-Gmail $gmail
$trackerRows | Export-Csv -Path $trackerPath -NoTypeInformation -Encoding UTF8
Write-Host "`nDONE! $index application(s) processed." -ForegroundColor Green
Write-Host "  Drafts: Check Gmail Drafts" -ForegroundColor White
Write-Host "  PDF:    $coverLetterDir" -ForegroundColor White
Write-Host "  Tracker: $trackerPath" -ForegroundColor White
