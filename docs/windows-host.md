# Optional Windows/WSL host preparation

Native Windows is not supported by omp-nightshift. Run the runner inside a Linux WSL2 distro with a running systemd user manager and all [README requirements](../README.md#requirements). This guide configures the Windows host only; it does not install or configure the Linux runner.

## Prerequisites and account

Use Windows PowerShell 5.1 or later on Windows. Check the installed distro name and version:

```powershell
wsl.exe --list --verbose
wsl.exe --help
```

Use an explicitly named, installed WSL2 distro. Enable systemd in that distro using the WSL systemd instructions for your installed version (typically `[boot]` with `systemd=true` in `/etc/wsl.conf`), restart WSL when safe, and verify that the Linux account running omp-nightshift has a working systemd user manager. Install Bun, Git, Bash, the required Linux commands, and omp inside Linux; configure and authenticate any selected delivery tools there.

Open PowerShell **as administrator under the same Windows account that owns the distro**. Do not supply another administrator account's credentials: WSL distro registration is per-user, and the script checks only the elevated current identity's distros. Elevation is required even for `-WhatIf`; the script never elevates itself. If that account cannot elevate, do not run the script under a different account as a workaround.

Before setup, record any existing values of these four Windows Update policy properties, including whether each property is absent:

```powershell
Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' `
    -Name SetActiveHours, ActiveHoursStart, ActiveHoursEnd -ErrorAction SilentlyContinue
Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' `
    -Name NoAutoRebootWithLoggedOnUsers -ErrorAction SilentlyContinue
```

The script does not back up old values. On a managed device, consult the policy owner instead of overriding organizational policy.

## Opt-in setup

From the repository root in elevated Windows PowerShell, replace `<distro>` with the exact installed name. Preview first:

```powershell
.\scripts\windows\harden-host.ps1 -Distro '<distro>' -WhatIf
```

`-WhatIf` performs account, distro, active-hours, and enabled executable validation, but does not create registry keys or tasks. Apply the defaults explicitly when ready:

```powershell
.\scripts\windows\harden-host.ps1 -Distro '<distro>'
```

The defaults are active hours 08:00–23:00, a WSL keepalive task, and no application tasks. Customize active hours, including a window crossing midnight:

```powershell
.\scripts\windows\harden-host.ps1 -Distro '<distro>' -ActiveHoursStart 18 -ActiveHoursEnd 8
```

Both endpoints must be integers from 0 through 23; they must differ, and the forward duration modulo 24 must not exceed 18 hours. All inputs are validated before any configuration is written. An environmental failure during application can still leave partial changes; no rollback is promised.

Docker Desktop is optional. Install it first and enable its WSL integration for the selected distro separately:

```powershell
.\scripts\windows\harden-host.ps1 -Distro '<distro>' -StartDockerDesktop
```

The default executable is under `$env:ProgramFiles` at `Docker\Docker\Docker Desktop.exe`. Override it if necessary, and optionally select other existing `.exe` files:

```powershell
.\scripts\windows\harden-host.ps1 -Distro '<distro>' -StartDockerDesktop `
    -DockerDesktopPath (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe') `
    -AppPaths @(
        (Join-Path $env:LOCALAPPDATA 'Programs\ExampleApp\ExampleApp.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\AnotherApp\AnotherApp.exe')
    ) -WhatIf
```

Replace the generic application paths with installed executables and omit `-WhatIf` to apply. An empty `-AppPaths @()` adds no application tasks; a missing Docker executable is an error only when `-StartDockerDesktop` is selected. Paths are canonicalized and deduplicated case-insensitively. Applications receive no arguments and use their executable's parent directory as the working directory. Standard PowerShell `-Confirm` is also available.

### What changes, and when

The script sets DWORD policies under `HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`: `SetActiveHours=1`, `ActiveHoursStart`, and `ActiveHoursEnd`. Under its `AU` child it sets `NoAutoRebootWithLoggedOnUsers=1`. Equal existing values are not rewritten. These are update policies, **not** a way to disable updates or guarantee that Windows never restarts. Their effect depends on Windows edition/version, update scheduling, and other policies; managed policy can override them. Save work and plan maintenance normally.

Tasks run at the owning account's **next interactive logon**, with that identity's SID, limited privileges, and no stored password. Setup does not immediately start WSL or applications. It does not stop WSL, compact disks, or change sparse state.

- `omp-nightshift-WSL-Keepalive` runs `wsl.exe -d "<distro>" --exec sleep infinity` through Windows PowerShell with `-WindowStyle Hidden` and a hidden `Start-Process` invocation. The wrapper waits for WSL and returns its exit code, so overlapping logon triggers do not launch duplicate keepalive processes. The distro must provide `sleep` with support for `infinity`. The task has no execution time limit.
- Each selected executable gets `omp-nightshift-App-<hash>`, where `<hash>` is the first 16 lowercase hexadecimal SHA256 characters of its invariant-lowercase canonical path. Application tasks retain the default finite execution limit.
- Tasks are marked hidden, ignore overlapping instances, and may run on battery without being stopped when switching to battery. Hidden task metadata does not guarantee an invisible window: Windows may briefly display a console.

Reruns replace the same owned task names instead of adding duplicates. Changing the distro replaces the single keepalive task. Omitting an application on a later run **does not remove its existing task**. Keepalive requires a logged-on account and is not an unattended boot service; it does not prevent Windows sleep or shutdown.

## Removing tasks and restoring policies

Inspect the exact names and actions before removing anything:

```powershell
Get-ScheduledTask -TaskName 'omp-nightshift-WSL-Keepalive', 'omp-nightshift-App-*' |
    Select-Object TaskName, TaskPath, Actions
```

Remove only explicitly selected owned task names, not every task matching a wildcard. Replace the example hash with the inspected name:

```powershell
Unregister-ScheduledTask -TaskName 'omp-nightshift-WSL-Keepalive' -Confirm
Unregister-ScheduledTask -TaskName 'omp-nightshift-App-<hash>' -Confirm
```

If a property was absent before setup, remove only that named property as appropriate:

```powershell
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' -Name SetActiveHours
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' -Name ActiveHoursStart
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' -Name ActiveHoursEnd
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Name NoAutoRebootWithLoggedOnUsers
```

If a property previously existed, restore its recorded DWORD value instead with `Set-ItemProperty -Path '<exact policy key>' -Name '<exact property>' -Value <recorded value>`. Do not blindly remove pre-existing policies, delete whole registry trees, or override managed policy. Task removal and policy restoration are independent.

## Manual-only VHD maintenance

The setup script never performs these steps. Schedule a maintenance window; keep WSL stopped throughout compaction. Run registry discovery as the distro-owning account and administrative disk operations in elevated PowerShell under that same account.

### 1. Back up and discover the actual disk

Choose a backup location with adequate free space for the export and maintenance. Replace both placeholders:

```powershell
$Distro = '<distro>'
$BackupPath = '<absolute backup directory>\distro-backup.tar'
wsl.exe --export $Distro $BackupPath
if ($LASTEXITCODE -ne 0) { throw 'Distro export failed; stop maintenance.' }
```

Verify the backup is usable before proceeding. Discover the named distro's `BasePath` from its owner's registry rather than guessing a package directory:

```powershell
$Matches = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' |
    ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DistributionName -eq $Distro })
if ($Matches.Count -ne 1) { throw 'Expected exactly one matching distro; stop maintenance.' }
$VhdPath = Join-Path $Matches[0].BasePath 'ext4.vhdx'
if (-not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) {
    throw 'Distro VHD was not found; do not guess another path.'
}
$VhdPath
```

If missing, stop: do not substitute another distro's disk or assume a Store package path.

### 2. Stop every user of WSL

**`wsl --shutdown` stops all distros and WSL-backed services, including Docker workloads.** Stop Docker Desktop and other applications/services that start WSL first; coordinate any interrupted workloads. Temporarily disable the keepalive task if it is enabled so another logon cannot reopen the disk:

```powershell
Disable-ScheduledTask -TaskName 'omp-nightshift-WSL-Keepalive'
wsl.exe --shutdown
if ($LASTEXITCODE -ne 0) { throw 'WSL shutdown failed; stop maintenance.' }
```

If the task does not exist or was already disabled, leave it that way and record its prior state. Do not open a distro or allow WSL-starting applications to restart during compaction.

### 3. Compact while the disk is offline

In elevated PowerShell, if the Hyper-V PowerShell cmdlet is available:

```powershell
Get-Command Optimize-VHD -ErrorAction SilentlyContinue
Optimize-VHD -Path $VhdPath -Mode Full
```

Run the second command only when the first finds the cmdlet. Otherwise launch `diskpart` interactively from elevated PowerShell and carefully substitute the absolute path printed above:

```text
select vdisk file="<absolute ext4.vhdx path>"
attach vdisk readonly
compact vdisk
detach vdisk
exit
```

Check the selected disk path before attaching or compacting. Do not add destructive disk commands. If an operation fails, ensure the disk is detached before allowing WSL to restart.

If a sparse VHD prevents compaction, first check that `wsl --help` advertises `--manage` and `--set-sparse`. On a supported WSL version, run:

```powershell
wsl.exe --manage $Distro --set-sparse false
if ($LASTEXITCODE -ne 0) { throw 'Sparse-state change failed; stop maintenance.' }
wsl.exe --shutdown
if ($LASTEXITCODE -ne 0) { throw 'WSL shutdown failed; stop maintenance.' }
```

Then retry the offline compaction method above. Do not unregister, reimport, or delete the distro to bypass a failure.

### 4. Enable sparse state and restore normal operation

This step requires a WSL version whose `wsl --help` advertises `--manage` and `--set-sparse`. If unsupported, stop this maintenance step and explicitly update WSL before retrying; do not treat an unsupported command as success. Once supported and the disk is detached:

```powershell
wsl.exe --manage $Distro --set-sparse true
if ($LASTEXITCODE -ne 0) { throw 'Sparse-state change failed; stop maintenance.' }
```

After maintenance, re-enable the keepalive task **only if you disabled an originally enabled task**:

```powershell
Enable-ScheduledTask -TaskName 'omp-nightshift-WSL-Keepalive'
```

Restart the desired distro, Docker Desktop, and other services manually. Re-enabling the task does not itself launch it; its normal activation is at the next logon. If maintenance stops on an error, keep the disk safely detached and deliberately restore the previously enabled task and desired services when it is safe to do so.
