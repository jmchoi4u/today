# 오늘 비서 설치 (Windows). install.cmd를 더블클릭하면 이 파일이 실행돼요.
# 하는 일: Node.js 확인 → 키 입력(.env, 이 PC에만 저장) → 점검 → 자동 시작 등록 → 텔레그램 연결 코드 안내
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Ask($label, $current, [switch]$Secret) {
  $hint = ''
  if ($current) { $hint = if ($Secret) { ' (Enter = 그대로)' } else { " (Enter = $current)" } }
  if ($Secret) {
    $s = Read-Host -AsSecureString "$label$hint"
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  } else {
    $v = Read-Host "$label$hint"
  }
  if ([string]::IsNullOrWhiteSpace($v)) { return $current }
  return $v.Trim()
}

Say ''
Say '=== 오늘 비서 설치 ===' 'Cyan'
Say ''

# 1) Node.js 22 이상
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say 'Node.js가 없어요. 공식 Node.js LTS를 winget으로 설치할게요.' 'Yellow'
  $ok = Read-Host '설치할까요? (Y/n)'
  if ($ok -match '^[nN]') { Say 'https://nodejs.org 에서 LTS를 설치한 뒤 install.cmd를 다시 실행해 주세요.'; exit 1 }
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Say ''
  Say 'Node.js 설치가 끝났어요. 이 창을 닫고 install.cmd를 한 번 더 실행해 주세요.' 'Yellow'
  exit 0
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) {
  Say "Node.js $major 버전이에요. 22 이상이 필요해요. 명령 창에서: winget upgrade OpenJS.NodeJS.LTS" 'Red'
  exit 1
}
Say "[OK] Node.js $(& node -v)" 'Green'

# 2) 설정 (.env). 이미 있으면 Enter로 그대로 둘 수 있어요
$envFile = Join-Path $here '.env'
$cur = @{}
if (Test-Path $envFile) {
  foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cur[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'") }
  }
}
function Def($k, $d) { if ($cur[$k]) { return $cur[$k] } else { return $d } }

Say ''
Say '1) 텔레그램 봇 토큰' 'Cyan'
Say '   텔레그램에서 @BotFather → /newbot → 이름 두 번 → 받은 토큰 (예: 123456:ABC...)'
$tg = Ask '   봇 토큰' $cur['TELEGRAM_BOT_TOKEN'] -Secret

Say ''
Say '2) 기록 저장소와 GitHub 토큰' 'Cyan'
Say '   github.com → Settings → Developer settings → Fine-grained tokens → Generate new token'
Say '   Repository access: Only select repositories → 기록 저장소 하나 / Permissions: Contents = Read and write'
$repo = Ask '   기록 저장소 (계정/이름)' (Def 'GITHUB_REPO' 'jmchoi4u/today-data')
$ght = Ask '   GitHub 토큰' $cur['GITHUB_TOKEN'] -Secret

Say ''
Say '3) AI (규칙으로 못 알아들은 말만 AI에게 물어봐요)' 'Cyan'
Say '   gemini = 무료 (aistudio.google.com → Get API key)  /  claude = 유료  /  none = AI 없이'
$prov = (Ask '   고르기 (gemini/claude/none)' (Def 'LLM_PROVIDER' 'gemini')).ToLower()
$gk = $cur['GEMINI_API_KEY']; $ak = $cur['ANTHROPIC_API_KEY']
if ($prov -eq 'gemini') { $gk = Ask '   Gemini API 키' $gk -Secret }
if ($prov -eq 'claude') { $ak = Ask '   Claude API 키 (console.anthropic.com)' $ak -Secret }

Say ''
Say '4) 시각 (Enter = 그대로)' 'Cyan'
$wd = Ask '   평일 기상 확인 시각' (Def 'WAKE_WEEKDAY' '07:00')
$we = Ask '   주말 기상 확인 시각' (Def 'WAKE_WEEKEND' '08:00')

if (-not $tg -or -not $ght -or -not $repo) { Say '봇 토큰, GitHub 토큰, 저장소는 꼭 있어야 해요. install.cmd를 다시 실행해 주세요.' 'Red'; exit 1 }

$lines = @(
  '# 오늘 비서 설정 (install.cmd가 만듦). 이 파일은 이 PC에만 있고, 어디에도 올리지 않아요.',
  "TELEGRAM_BOT_TOKEN=$tg",
  "GITHUB_REPO=$repo",
  "GITHUB_TOKEN=$ght",
  "LLM_PROVIDER=$prov",
  "GEMINI_API_KEY=$gk",
  "GEMINI_MODEL=$(Def 'GEMINI_MODEL' 'gemini-flash-latest')",
  "ANTHROPIC_API_KEY=$ak",
  "CLAUDE_MODEL=$(Def 'CLAUDE_MODEL' 'claude-opus-5-5')",
  "WAKE_WEEKDAY=$wd",
  "WAKE_WEEKEND=$we",
  "QUIET_FROM=$(Def 'QUIET_FROM' '01:00')",
  "QUIET_TO=$(Def 'QUIET_TO' '06:30')",
  "APP_URL=$(Def 'APP_URL' 'https://jmchoi4u.github.io/today/')"
)
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding $false))
# 이 계정만 읽을 수 있게
try { & icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null } catch {}
Say '[OK] 설정 저장 (.env)' 'Green'

# 3) Claude를 고르면 공식 SDK 설치
if ($prov -eq 'claude') {
  Say 'Claude SDK 설치 중...'
  & npm install --omit=dev --no-audit --no-fund
}

# 4) 점검
Say ''
Say '점검 중...' 'Cyan'
& node main.mjs --check
if ($LASTEXITCODE -ne 0) {
  Say ''
  Say '위의 [X]를 고친 뒤 install.cmd를 다시 실행해 주세요. (Enter로 맞는 값은 그대로 둘 수 있어요)' 'Yellow'
  exit 1
}

# 5) 자동 시작 등록 (작업 스케줄러 "TodayBot")
$nodeExe = (Get-Command node).Source
$main = Join-Path $here 'main.mjs'
$user = "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
try { Stop-ScheduledTask -TaskName 'TodayBot' -ErrorAction SilentlyContinue } catch {}
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$registered = $false
if ($isAdmin) {
  try {
    # 관리자 권한이면: 부팅만 해도 로그인 없이, 창 없이 돈다
    $action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$main`"" -WorkingDirectory $here
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
    $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $user))
    Register-ScheduledTask -TaskName 'TodayBot' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description '오늘 비서 (텔레그램)' -Force | Out-Null
    $registered = $true
    Say '[OK] 부팅하면 로그인 없이도 자동으로 켜져요' 'Green'
  } catch {
    Say "관리자 방식 등록 실패: $($_.Exception.Message)" 'Yellow'
  }
}
if (-not $registered) {
  # 관리자 권한이 아니면: 이 계정으로 로그인할 때 창 없이 켜진다
  $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$nodeExe`" `"$main`"" -WorkingDirectory $here
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  Register-ScheduledTask -TaskName 'TodayBot' -Action $action -Trigger $trigger -Settings $settings -Description '오늘 비서 (텔레그램)' -Force | Out-Null
  Say '[OK] 이 계정으로 로그인하면 자동으로 켜져요' 'Green'
  Say '     로그인 없이 부팅만 해도 켜지게 하려면 install.cmd를 마우스 오른쪽 → 관리자 권한으로 실행' 'DarkGray'
}
Start-ScheduledTask -TaskName 'TodayBot'

# 6) 텔레그램 연결 코드
Say ''
$pair = Join-Path $here 'data\PAIRING.txt'
$state = Join-Path $here 'data\state.json'
for ($i = 0; $i -lt 20 -and -not (Test-Path $pair); $i++) {
  if ((Test-Path $state) -and ((Get-Content $state -Raw) -match '"owner"\s*:\s*-?\d')) { break }
  Start-Sleep -Seconds 1
}
if (Test-Path $pair) {
  Say '=====================================' 'Cyan'
  Say (Get-Content $pair -Raw -Encoding UTF8) 'White'
  Say '텔레그램에서 방금 만든 봇을 찾아 위 문장을 그대로 보내면 끝이에요.' 'Cyan'
  Say '=====================================' 'Cyan'
} elseif ((Test-Path $state) -and ((Get-Content $state -Raw) -match '"owner"\s*:\s*-?\d')) {
  Say '[OK] 이미 텔레그램과 연결돼 있어요. 봇에게 "오늘"이라고 보내 보세요.' 'Green'
} else {
  Say '연결 코드가 아직 안 나왔어요. 잠시 뒤 bot\data\PAIRING.txt 파일을 열어 보세요.' 'Yellow'
}
Say ''
Say '끄기: uninstall.cmd / 다시 설정: install.cmd / 기록: bot\data\bot.log' 'DarkGray'
