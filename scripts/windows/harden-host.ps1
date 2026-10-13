<#
.SYNOPSIS
Configures optional Windows host policies and logon tasks for a WSL runner.
.DESCRIPTION
Run in elevated Windows PowerShell as the account that owns the WSL distro.
Use -WhatIf to validate inputs and preview changes without writing policies or
registering tasks. This script never starts apps, stops WSL, or maintains VHDs.
Existing policy values are not backed up: record them before applying changes.
.PARAMETER Distro
Exact installed WSL distro name. No default distro is selected.
.PARAMETER ActiveHoursStart
Windows Update active-hours start, from 0 to 23 (default 8).
.PARAMETER ActiveHoursEnd
Windows Update active-hours end, from 0 to 23 (default 23). Maximum span: 18 hours.
.PARAMETER StartDockerDesktop
Opt in to a Docker Desktop logon task. Docker's WSL integration is configured separately.
.PARAMETER DockerDesktopPath
Docker Desktop executable path, checked only when StartDockerDesktop is enabled.
.PARAMETER AppPaths
Optional existing .exe paths to start at logon, without arguments.
.EXAMPLE
.\scripts\windows\harden-host.ps1 -Distro '<distro>' -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [string]$Distro,
    [ValidateRange(0, 23)]
    [int]$ActiveHoursStart = 8,
    [ValidateRange(0, 23)]
    [int]$ActiveHoursEnd = 23,
    [switch]$StartDockerDesktop,
    [string]$DockerDesktopPath = (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    [string[]]$AppPaths = @()
)

$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Run this script on Windows in elevated Windows PowerShell.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Elevation is required, including for -WhatIf. Run elevated Windows PowerShell as the account that owns the distro, not with alternate administrator credentials.'
}
$sid = $identity.User.Value

if ([string]::IsNullOrWhiteSpace($Distro) -or $Distro -match '["\r\n\x00]') {
    throw 'Distro must be a nonempty installed name without quotes, newlines, or NUL characters.'
}
$Distro = $Distro.Trim()
$activeHoursSpan = ($ActiveHoursEnd - $ActiveHoursStart + 24) % 24
if ($activeHoursSpan -eq 0 -or $activeHoursSpan -gt 18) {
    throw 'Active hours must span 1 to 18 hours; midnight wraparound is allowed.'
}

$wslPath = (Get-Command wsl.exe -CommandType Application -ErrorAction Stop).Source
$distroOutput = @(& $wslPath --list --quiet)
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to list WSL distros. Check WSL installation and the current account.'
}
$installedDistros = @($distroOutput | ForEach-Object { ($_ -replace '\x00', '').Trim() })
if ($installedDistros -notcontains $Distro) {
    throw "Distro '$Distro' is not installed for the current account. Check wsl --list --verbose."
}

$requestedApps = @($AppPaths)
if ($StartDockerDesktop) {
    $requestedApps += $DockerDesktopPath
}
$appExecutables = New-Object 'System.Collections.Generic.List[string]'
$seenPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($path in $requestedApps) {
    if ([string]::IsNullOrWhiteSpace($path)) {
        throw 'App paths must not be empty.'
    }
    $item = Get-Item -LiteralPath $path -ErrorAction Stop
    if ($item -isnot [IO.FileInfo] -or $item.Extension -ine '.exe') {
        throw "App path must be an existing filesystem .exe file: $path"
    }
    if ($seenPaths.Add($item.FullName)) {
        $appExecutables.Add($item.FullName)
    }
}

# Build all task definitions before applying any changes.
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
$keepaliveSettings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$appSettings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
    throw 'Windows PowerShell is required for the hidden WSL keepalive action.'
}
# PowerShell literal escaping and distro validation prevent payload/argument injection.
$wslLiteral = "'" + $wslPath.Replace("'", "''") + "'"
$wslArguments = '-d "' + $Distro + '" --exec sleep infinity'
$argumentsLiteral = "'" + $wslArguments.Replace("'", "''") + "'"
$payload = '$ErrorActionPreference = ''Stop''; $process = Start-Process -FilePath ' +
    $wslLiteral + ' -ArgumentList ' + $argumentsLiteral +
    ' -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode'
$encodedPayload = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
$keepaliveAction = New-ScheduledTaskAction -Execute $windowsPowerShell `
    -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encodedPayload)
$keepaliveTask = New-ScheduledTask -Action $keepaliveAction -Trigger $logonTrigger `
    -Principal $taskPrincipal -Settings $keepaliveSettings `
    -Description 'Keeps the configured WSL distro running after logon; stops when WSL shuts down.'

$appTasks = @()
foreach ($path in $appExecutables) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($path.ToLowerInvariant()))
    } finally {
        $hasher.Dispose()
    }
    $suffix = ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant().Substring(0, 16)
    $action = New-ScheduledTaskAction -Execute $path -WorkingDirectory (Split-Path -Parent $path)
    $task = New-ScheduledTask -Action $action -Trigger $logonTrigger -Principal $taskPrincipal `
        -Settings $appSettings -Description 'Starts an explicitly selected application at logon.'
    $appTasks += [PSCustomObject]@{ Name = 'omp-nightshift-App-' + $suffix; Task = $task }
}

$updateKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
$policyValues = @(
    @{ Path = $updateKey; Name = 'SetActiveHours'; Value = 1 },
    @{ Path = $updateKey; Name = 'ActiveHoursStart'; Value = $ActiveHoursStart },
    @{ Path = $updateKey; Name = 'ActiveHoursEnd'; Value = $ActiveHoursEnd },
    @{ Path = "$updateKey\AU"; Name = 'NoAutoRebootWithLoggedOnUsers'; Value = 1 }
)
foreach ($policy in $policyValues) {
    $keyExists = Test-Path -LiteralPath $policy.Path
    $currentValue = $null
    $isDword = $false
    if ($keyExists) {
        $key = Get-Item -LiteralPath $policy.Path
        if ($key.GetValueNames() -contains $policy.Name) {
            $currentValue = $key.GetValue($policy.Name)
            $isDword = $key.GetValueKind($policy.Name) -eq [Microsoft.Win32.RegistryValueKind]::DWord
        }
    }
    if ($isDword -and $currentValue -eq $policy.Value) {
        continue
    }
    if ($PSCmdlet.ShouldProcess(($policy.Path + '\' + $policy.Name), ('Set DWORD to ' + $policy.Value))) {
        if (-not $keyExists) {
            New-Item -Path $policy.Path -Force | Out-Null
        }
        New-ItemProperty -LiteralPath $policy.Path -Name $policy.Name -PropertyType DWord `
            -Value $policy.Value -Force | Out-Null
    }
}

if ($PSCmdlet.ShouldProcess('omp-nightshift-WSL-Keepalive', 'Register or replace current-account logon task')) {
    Register-ScheduledTask -TaskName 'omp-nightshift-WSL-Keepalive' -InputObject $keepaliveTask -Force | Out-Null
}
foreach ($app in $appTasks) {
    if ($PSCmdlet.ShouldProcess($app.Name, 'Register or replace current-account application logon task')) {
        Register-ScheduledTask -TaskName $app.Name -InputObject $app.Task -Force | Out-Null
    }
}

if ($WhatIfPreference) {
    Write-Output "Preview complete for account '$($identity.Name)', distro '$Distro'. No policies or tasks were changed."
} else {
    Write-Output "Setup finished for account '$($identity.Name)', distro '$Distro'. Approved tasks activate at the next logon; nothing was started."
}
