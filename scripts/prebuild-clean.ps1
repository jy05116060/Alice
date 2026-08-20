# prebuild-clean.ps1
# Clean dist before build: detect file locks, close locking processes, remove old artifacts.

param([string]$DistPath = "dist")

$ErrorActionPreference = "Stop"
$distFull = Join-Path (Split-Path $PSScriptRoot) $DistPath

# Skip when dist does not exist.
if (-not (Test-Path $distFull)) {
    Write-Host "[prebuild] dist does not exist; skipping clean" -ForegroundColor Green
    exit 0
}

$asarPath = Join-Path $distFull "win-unpacked\resources\app.asar"

# If app.asar does not exist, remove dist directly.
if (-not (Test-Path $asarPath)) {
    Remove-Item $distFull -Recurse -Force
    Write-Host "[prebuild] dist removed" -ForegroundColor Green
    exit 0
}

# Use Restart Manager API to find locking processes.
$rmCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class RestartManager {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]  public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public int TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static List<int> GetLockingPids(string path) {
        var pids = new List<int>();
        uint session;
        string key = Guid.NewGuid().ToString();
        if (RmStartSession(out session, 0, key) != 0) return pids;
        try {
            if (RmRegisterResources(session, 1, new[] { path }, 0, null, 0, null) != 0) return pids;
            uint needed = 0, count = 0, reboot = 0;
            RmGetList(session, out needed, ref count, null, ref reboot);
            if (needed == 0) return pids;
            var infos = new RM_PROCESS_INFO[needed];
            count = needed;
            if (RmGetList(session, out needed, ref count, infos, ref reboot) == 0)
                foreach (var i in infos) pids.Add(i.Process.dwProcessId);
        } finally {
            RmEndSession(session);
        }
        return pids;
    }
}
'@

Add-Type -TypeDefinition $rmCode

$lockingPids = [RestartManager]::GetLockingPids($asarPath)

if ($lockingPids.Count -gt 0) {
    Write-Host "[prebuild] app.asar is locked by these processes:" -ForegroundColor Yellow
    $closedNames = @()
    foreach ($procId in $lockingPids) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  -> PID $procId  $($proc.Name)  $($proc.MainWindowTitle)" -ForegroundColor Yellow
            $closedNames += $proc.Name
            # Ask the process to close first so it can save state.
            $proc.CloseMainWindow() | Out-Null
        }
    }

    # Wait up to 6 seconds before forcing termination.
    $deadline = (Get-Date).AddSeconds(6)
    foreach ($procId in $lockingPids) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        while ($proc -and -not $proc.HasExited -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 300
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        }
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc -and -not $proc.HasExited) {
            Write-Host "  -> PID $procId did not exit; terminating" -ForegroundColor Red
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host "[prebuild] closed locking processes: $($closedNames -join ', ')" -ForegroundColor Green
    Write-Host "[prebuild] reopen these apps after the build completes" -ForegroundColor Cyan
    Start-Sleep -Milliseconds 500
}

# Remove dist.
try {
    Remove-Item $distFull -Recurse -Force
    Write-Host "[prebuild] dist removed; starting build" -ForegroundColor Green
} catch {
    Write-Host "[prebuild] clean failed: $_" -ForegroundColor Red
    exit 1
}
