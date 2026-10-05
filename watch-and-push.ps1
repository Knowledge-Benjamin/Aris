[CmdletBinding()]
param(
    [ValidateRange(100, 10000)]
    [int]$DebounceMilliseconds = 1200
)

$ErrorActionPreference = 'Stop'

$repoRoot = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) {
    throw 'Run this script from inside a Git repository.'
}
$repoRoot = $repoRoot.Trim()

$remoteHead = (& git -C $repoRoot symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remoteHead)) {
    throw 'origin/HEAD is not configured. Set it to the remote default branch before starting the watcher.'
}
$defaultBranch = $remoteHead.Trim() -replace '^origin/', ''
$currentBranch = (& git -C $repoRoot branch --show-current 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $currentBranch -ne $defaultBranch) {
    throw "Checked-out branch '$currentBranch' does not match origin's default branch '$defaultBranch'."
}

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $repoRoot
$watcher.Filter = '*'
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [IO.NotifyFilters]'FileName, DirectoryName, LastWrite, Size'
$watcher.InternalBufferSize = 65536
$watcher.EnableRaisingEvents = $true

function Sync-PendingChanges {
    $status = @(& git -C $repoRoot status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'git status failed; pending changes will be checked again.'
        return
    }
    if ($status.Count -eq 0) {
        return
    }

    & git -C $repoRoot add --all
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'git add --all failed; pending changes will be checked again.'
        return
    }

    $paths = @(& git -C $repoRoot diff --cached --name-only)
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Could not inspect staged changes; pending changes will be checked again.'
        return
    }
    if ($paths.Count -eq 0) {
        return
    }

    $message = "committed the following files:`n" + (($paths | Sort-Object -Unique | ForEach-Object { "- $_" }) -join "`n")
    & git -C $repoRoot commit -m $message
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Commit failed; staged changes will be retried after the next check.'
        return
    }

    & git -C $repoRoot push origin $defaultBranch
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Pushed changes for: $($paths -join ', ')"
    }
    else {
        Write-Warning "Push failed. The commit is local on '$defaultBranch' and will be included in a later successful push."
    }
}

Write-Host "Watching $repoRoot; commits will be pushed to origin/$defaultBranch. Press Ctrl+C to stop."

try {
    Sync-PendingChanges

    while ($true) {
        $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::All, 5000)
        if (-not $change.TimedOut) {
            while ($true) {
                $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::All, $DebounceMilliseconds)
                if ($change.TimedOut) {
                    break
                }
            }
        }

        Sync-PendingChanges
    }
}
finally {
    $watcher.Dispose()
}