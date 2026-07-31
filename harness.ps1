 $max_iterations = 8
$iteration = 1
$is_clean = $false

Write-Host "🚀 STEP 1: Applying Master Production Prompt via OpenCode..." -ForegroundColor Cyan
opencode run "Execute all directives in the attached opencode.txt to make this codebase production-ready." --file opencode.txt

Write-Host "`n🚀 STEP 2: Starting 10/10 Production Deploy Harness..." -ForegroundColor Cyan

while ($iteration -le $max_iterations -and -not $is_clean) {
    Write-Host "`n=== Iteration $iteration ===" -ForegroundColor Yellow
    $errors_found = $false
    $error_log = ""

    # 1. Dependency Integrity & Audit
    Write-Host "Running npm ci & npm audit..."
    npm ci --silent
    $audit_output = npm audit --audit-level=high 2>&1
    if ($LASTEXITCODE -ne 0) {
        $errors_found = $true
        $error_log += "NPM AUDIT FAILED:`n$audit_output`n`n"
        Write-Host "❌ Audit failed." -ForegroundColor Red
    } else {
        Write-Host "✅ Dependencies secure." -ForegroundColor Green
    }

    # 2. Syntax Gate (Check all JS files in /api and /lib)
    Write-Host "Running strict syntax checks on /api and /lib..."
    $js_files = Get-ChildItem -Path api, lib -Filter *.js -Recurse -ErrorAction SilentlyContinue
    foreach ($file in $js_files) {
        $check_output = node --check $file.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            $errors_found = $true
            $error_log += "SYNTAX ERROR in $($file.Name):`n$check_output`n`n"
            Write-Host "❌ Syntax error in $($file.Name)" -ForegroundColor Red
        }
    }

    if (-not $errors_found) {
        $is_clean = $true
        Write-Host "`n✅ SUCCESS: Codebase is 10/10 Clean and Deploy-Ready!" -ForegroundColor Green
        break
    }

    Write-Host "`n⚠️ Errors found. Handing off to OpenCode for automated remediation..." -ForegroundColor DarkYellow
    $error_log | Out-File -Encoding utf8 "harness-errors.txt"

    # Handoff to OpenCode
    opencode run "You are in an automated deployment loop. The following errors prevented a clean production build. Fix these specific errors immediately without breaking existing functionality. Do not modify files unrelated to these errors." --file harness-errors.txt
    
    $iteration++
}

if (-not $is_clean) {
    Write-Host "`n❌ Hit max iterations ($max_iterations). Please review harness-errors.txt manually." -ForegroundColor Red
}