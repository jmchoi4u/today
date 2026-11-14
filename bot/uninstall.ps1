# 오늘 비서 끄기: 자동 시작을 지우고 돌고 있는 비서를 멈춘다. 설정(.env)과 기록(data)은 남겨 둔다.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Stop-ScheduledTask -TaskName 'TodayBot' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'TodayBot' -Confirm:$false -ErrorAction SilentlyContinue
# 감시 프로그램을 먼저 끄고 (안 그러면 비서를 다시 켠다), 그다음 비서를 끈다
foreach ($f in @('data\supervisor.pid', 'data\bot.lock')) {
  $pf = Join-Path $here $f
  if (Test-Path $pf) {
    $oldPid = 0
    try { [void][int]::TryParse([string](Get-Content $pf -Raw), [ref]$oldPid) } catch {}
    if ($oldPid -gt 0) {
      $p = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item $pf -ErrorAction SilentlyContinue
  }
}
Write-Host '오늘 비서를 껐어요. 다시 켜려면 install.cmd를 실행하세요.' -ForegroundColor Green
Write-Host '설정(.env)과 기록(data 폴더)은 남겨 뒀어요. 완전히 지우려면 bot 폴더를 지우면 돼요.' -ForegroundColor DarkGray
