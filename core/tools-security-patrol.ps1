# security-patrol.ps1 -- weekly machine security patrol: collect state, diff against last run, write a report.
# Design: NO #Requires -- sections that need admin are attempted in try/catch and marked "(needs admin)" when they fail,
#         so the script is smoke-testable unelevated and gives full value when run as administrator.
# ASCII-only on purpose (Windows PowerShell 5.1 parses non-BOM .ps1 as ANSI).
param([switch]$Quiet)

$root      = '<LOCAL_PATH>'
$patrolDir = Join-Path $root 'docs\patrol'
$stateFile = Join-Path $patrolDir 'last-state.json'
$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$out       = Join-Path $patrolDir ("patrol-$stamp.txt")
$newState  = Join-Path $patrolDir ("state-$stamp.json")
New-Item -ItemType Directory -Force -Path $patrolDir | Out-Null
function W([string]$t) { if (-not $Quiet) { Write-Host $t }; $t | Out-File -FilePath $out -Append -Encoding UTF8 }

"=== SECURITY PATROL  $stamp ===" | Out-File -FilePath $out -Encoding UTF8

# ---------- collect ----------
$state = [ordered]@{ stamp = $stamp; sections = [ordered]@{} }

# 1) Defender config (exclusions need admin)
$sec = [ordered]@{}
try {
  $pre = Get-MpPreference -ErrorAction Stop
  # Non-admin reads return placeholder strings like "N/A: Must be an administrator ..." -- strip them,
  # otherwise they are counted as a real exclusion (bug found in the first smoke test, 2026-10-11).
  $clean = { param($v) @($v) | Where-Object { $_ -and ($_ -notmatch 'administrator|^N/A') } }
  $sec.exclusion_paths = @(& $clean $pre.ExclusionPath)
  $sec.exclusion_procs = @(& $clean $pre.ExclusionProcess)
  $sec.exclusion_ext   = @(& $clean $pre.ExclusionExtension)
  $sec.exclusion_ip    = @(& $clean $pre.ExclusionIpAddress)
  $rawAny = @($pre.ExclusionPath) + @($pre.ExclusionProcess) + @($pre.ExclusionExtension) + @($pre.ExclusionIpAddress)
  $sec.exclusions_readable = -not ($rawAny | Where-Object { $_ -match 'administrator|^N/A' })
  $sec.cloud_block_level = [int]$pre.CloudBlockLevel
  $sec.pua_protection    = [int]$pre.PUAProtection
  $sec.asr_ids     = @($pre.AttackSurfaceReductionRules_Ids | Where-Object { $_ })
  $sec.asr_actions = @($pre.AttackSurfaceReductionRules_Actions | Where-Object { $_ -ne $null })
  $sec.readable = $true
} catch {
  $sec.readable = $false
  $sec.error = $_.Exception.Message
}
try {
  $st = Get-MpComputerStatus -ErrorAction Stop
  $sec.realtime = [bool]$st.RealTimeProtectionEnabled
  $sec.tamper   = [bool]$st.IsTamperProtected
  $sec.sig_age_days = [math]::Round(((Get-Date) - $st.AntivirusSignatureLastUpdated).TotalDays, 1)
} catch { $sec.status_error = $_.Exception.Message }
$state.sections.defender = $sec

# 2) ASR audit/block hits (last 7 days) -- informs AuditMode -> Enabled decision
$asr = [ordered]@{}
try {
  $ev = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1121,1122; StartTime=(Get-Date).AddDays(-7)} -ErrorAction Stop
  $asr.total = ($ev | Measure-Object).Count
  $asr.audit_only = ($ev | Where-Object { $_.Id -eq 1122 } | Measure-Object).Count
  $asr.blocked    = ($ev | Where-Object { $_.Id -eq 1121 } | Measure-Object).Count
  $asr.samples = @($ev | Select-Object -First 5 | ForEach-Object { ($_.Message -replace "`r?`n", ' ').Substring(0, [Math]::Min(160, ($_.Message -replace "`r?`n",' ').Length)) })
} catch { $asr.error = $_.Exception.Message }
$state.sections.asr = $asr

# 3) listening surface (non-localhost)
try {
  $l = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }
  $pairs = $l | Select-Object LocalAddress, LocalPort, OwningProcess -Unique | ForEach-Object {
    $n = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    ("{0}:{1}|{2}" -f $_.LocalAddress, $_.LocalPort, $n)
  } | Sort-Object -Unique
  $state.sections.listeners = @($pairs)
} catch { $state.sections.listeners = @('ERROR: ' + $_.Exception.Message) }

# 4) updates / restore points / shadow storage
$up = [ordered]@{}
try {
  $au = New-Object -ComObject Microsoft.Update.AutoUpdate
  $up.last_install = [string]$au.Results.LastInstallationSuccessDate
  $up.last_search  = [string]$au.Results.LastSearchSuccessDate
  $s = New-Object -ComObject Microsoft.Update.Session
  $sr = $s.CreateUpdateSearcher()
  $up.pending = [int]($sr.Search("IsInstalled=0 and IsHidden=0")).Updates.Count
} catch { $up.error = $_.Exception.Message }
try {
  $rp = Get-CimInstance -Namespace root\default -ClassName SystemRestore -ErrorAction Stop
  $up.restore_points = ($rp | Measure-Object).Count
  $up.latest_point = [string](($rp | Sort-Object CreationTime -Descending | Select-Object -First 1).CreationTime)
} catch { $up.restore_error = 'needs admin' }
$state.sections.updates = $up

# 5) tasks / services snapshot (names only, for "what is new" detection)
try {
  $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskPath + $_.TaskName }
  $state.sections.tasks = @($tasks | Sort-Object)
} catch { $state.sections.tasks = @() }
try {
  $svcs = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.StartType -ne 'Disabled' } | ForEach-Object { $_.Name + '|' + $_.Status + '|' + $_.StartType }
  $state.sections.services = @($svcs | Sort-Object)
} catch { $state.sections.services = @() }

# 6) remote surface quick states
$rem = [ordered]@{}
foreach ($sv in 'WinRM','RemoteRegistry','TermService','LanmanServer','RemoteAccess') {
  try { $o = Get-Service -Name $sv -ErrorAction Stop; $rem[$sv] = ($o.Status.ToString() + '/' + $o.StartType.ToString()) } catch { $rem[$sv] = 'n/a' }
}
try { $smb = Get-SmbServerConfiguration -ErrorAction Stop; $rem.SMB1 = [string]$smb.EnableSMB1Protocol; $rem.SMB2 = [string]$smb.EnableSMB2Protocol } catch { $rem.SMB1 = 'n/a' }
try { $rem.RDP_deny = (Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction Stop).fDenyTSConnections } catch { $rem.RDP_deny = 'n/a' }
$state.sections.remote = $rem

# ---------- diff against last state ----------
$prev = $null
if (Test-Path $stateFile) { try { $prev = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $prev = $null } }

function DiffLists([string]$title, $old, $new) {
  $o = @($old); $n = @($new)
  $added   = @($n | Where-Object { $_ -and ($o -notcontains $_) })
  $removed = @($o | Where-Object { $_ -and ($n -notcontains $_) })
  W ("`n--- " + $title + " ---")
  if (-not $prev) { W ("  (first run: " + $n.Count + " items recorded as baseline)") ; return }
  if ($added.Count -eq 0 -and $removed.Count -eq 0) { W "  no change" ; return }
  if ($added.Count)   { W ("  [NEW] " + $added.Count);   $added   | Select-Object -First 12 | ForEach-Object { W ("      + " + $_) } }
  if ($removed.Count) { W ("  [GONE] " + $removed.Count); $removed | Select-Object -First 12 | ForEach-Object { W ("      - " + $_) } }
}

W ("`n=== DEFENDER ===")
if ($state.sections.defender.readable) {
  W ("  exclusions(path/proc/ext/ip): " + $state.sections.defender.exclusion_paths.Count + "/" + $state.sections.defender.exclusion_procs.Count + "/" + $state.sections.defender.exclusion_ext.Count + "/" + $state.sections.defender.exclusion_ip.Count)
  if (-not $state.sections.defender.exclusions_readable) {
    W "  [WARN] exclusion lists are NOT readable without admin -- the zeros above mean 'unknown', not 'none'. Run elevated."
  }
  W ("  cloud_block_level=" + $state.sections.defender.cloud_block_level + "  pua=" + $state.sections.defender.pua_protection + "  asr_rules=" + $state.sections.defender.asr_ids.Count)
  W ("  realtime=" + $state.sections.defender.realtime + "  tamper=" + $state.sections.defender.tamper + "  signature_age_days=" + $state.sections.defender.sig_age_days)
  if ($prev) {
    DiffLists 'exclusion paths' @($prev.sections.defender.exclusion_paths) $state.sections.defender.exclusion_paths
    DiffLists 'exclusion processes' @($prev.sections.defender.exclusion_procs) $state.sections.defender.exclusion_procs
    DiffLists 'ASR rules' @($prev.sections.defender.asr_ids) $state.sections.defender.asr_ids
  }
} else {
  W ("  (needs admin) " + $state.sections.defender.error)
}

W ("`n=== ASR AUDIT (last 7 days) ===")
if ($state.sections.asr.error) { W ("  (unavailable) " + $state.sections.asr.error) }
else {
  W ("  total=" + $state.sections.asr.total + "  audit_only=" + $state.sections.asr.audit_only + "  blocked=" + $state.sections.asr.blocked)
  W "  hint: audit_only>0 with no bad actor means a rule would have fired; inspect before flipping AuditMode -> Enabled."
  @($state.sections.asr.samples) | ForEach-Object { W ("    " + $_) }
}

DiffLists 'listeners (addr:port|proc)' @($prev.sections.listeners) $state.sections.listeners
DiffLists 'scheduled tasks' @($prev.sections.tasks) $state.sections.tasks
DiffLists 'services (enabled)' @($prev.sections.services) $state.sections.services

W ("`n=== UPDATES / RECOVERY ===")
W ("  pending_updates=" + $state.sections.updates.pending + "  last_install=" + $state.sections.updates.last_install)
if ($state.sections.updates.restore_error) {
  W ("  restore points: (unavailable) " + $state.sections.updates.restore_error + " -- run this script elevated to see them")
} else {
  W ("  restore_points=" + $state.sections.updates.restore_points + "  latest=" + $state.sections.updates.latest_point)
}

W ("`n=== REMOTE SURFACE ===")
foreach ($k in $state.sections.remote.Keys) { W ("  " + $k + " = " + $state.sections.remote[$k]) }

# ---------- persist ----------
($state | ConvertTo-Json -Depth 6) | Out-File -FilePath $newState -Encoding UTF8
Copy-Item $newState $stateFile -Force
W ("`nReport : " + $out)
W ("State  : " + $newState + "  (baseline -> " + $stateFile + ")")
W "=== END ==="
if (-not $Quiet) { Write-Host ("Patrol report: " + $out) }
