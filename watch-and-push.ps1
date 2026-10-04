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

Write-Host "Watching $repoRoot; commits will be pushed to origin/$defaultBranch. Press Ctrl+C to stop."

try {
    while ($true) {
        $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::All, [int]::MaxValue)
        if ($change.TimedOut) {
            continue
        }

        $pendingPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        [void]$pendingPaths.Add($change.Name)
        if ($change.ChangeType -eq [IO.WatcherChangeTypes]::Renamed -and $change.OldName) {
            [void]$pendingPaths.Add($change.OldName)
        }

        while ($true) {
            $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::All, $DebounceMilliseconds)
            if ($change.TimedOut) {
                break
            }
            [void]$pendingPaths.Add($change.Name)
            if ($change.ChangeType -eq [IO.WatcherChangeTypes]::Renamed -and $change.OldName) {
                [void]$pendingPaths.Add($change.OldName)
            }
        }

        $paths = @(
            foreach ($eventPath in $pendingPaths) {
                $relativePath = $eventPath.Replace('\', '/')
                $leaf = [IO.Path]::GetFileName($relativePath)
                if ($relativePath -match '(^|/)\.git(/|$)' -or
                    $relativePath -match '(^|/)(node_modules|dist|build|\.gradle|\.research-browser-profile|\.meeting-profile)(/|$)' -or
                    $leaf -match '^\.env($|\.)' -or $leaf -match '\.env$') {
                    continue
                }

                $null = & git -C $repoRoot check-ignore --quiet -- $relativePath 2>$null
                if ($LASTEXITCODE -eq 0) {
                    continue
                }

                $fullPath = Join-Path $repoRoot $eventPath
                if (Test-Path -LiteralPath $fullPath -PathType Container) {
                    continue
                }
                $relativePath
            }
        )

        if ($paths.Count -eq 0) {
            continue
        }

        $gitPathspecs = @($paths | ForEach-Object { ":(literal)$_" })
        & git -C $repoRoot add --all -- $gitPathspecs
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'git add failed; no commit was created for this batch.'
            continue
        }

        $message = "committed the following files:`n" + (($paths | Sort-Object -Unique | ForEach-Object { "- $_" }) -join "`n")
        & git -C $repoRoot commit --only -m $message -- $gitPathspecs
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'No commit was created for this batch.'
            continue
        }

        & git -C $repoRoot push origin $defaultBranch
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Pushed changes for: $($paths -join ', ')"
        }
        else {
            Write-Warning "Push failed. The commit is local on '$defaultBranch' and will be included in a later successful push."
        }
    }
}
finally {
    $watcher.Dispose()
}