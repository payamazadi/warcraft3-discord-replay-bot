# Scans the running Warcraft III process memory for the local webui bridge
# endpoint (port + guid) and caches it to bridge.json next to this script.
param(
  [string]$OutFile = ''   # default: bridge.json in this script's folder
)
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutFile) { $OutFile = Join-Path $scriptDir 'bridge.json' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Mem3 {
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI { public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect; public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern UIntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI info, UIntPtr len);
}
'@

$enc = [Text.Encoding]::GetEncoding(28591)
$pats = @(
  [regex]'ws://127\.0\.0\.1:(\d+)/webui-socket/(\d+)',
  [regex]'http://127\.0\.0\.1:(\d+)/webui/index\.html\?guid=(\d+)'
)

function Scan-Proc($proc) {
  $h = [Mem3]::OpenProcess(0x0410, $false, $proc.Id)
  if ($h -eq [IntPtr]::Zero) { return }
  $mbiSize = [Runtime.InteropServices.Marshal]::SizeOf([type][Mem3+MBI])
  $found = New-Object System.Collections.Generic.HashSet[string]
  $addr = [UInt64]0x10000; $max = [UInt64]0x7FFFFFFEFFFF
  $chunk = 8388608; $scanned = [UInt64]0
  $buf = New-Object byte[] $chunk
  while ($addr -lt $max) {
    $info = New-Object Mem3+MBI
    $r = [Mem3]::VirtualQueryEx($h, [IntPtr][Int64]$addr, [ref]$info, [UIntPtr][UInt64]$mbiSize)
    if ($r -eq [UIntPtr]::Zero) { break }
    $size = [UInt64]$info.RegionSize.ToInt64()
    if ($size -eq [UInt64]0) { break }
    $readable = ($info.State -eq 0x1000) -and ($info.Type -eq 0x20000) -and
                (($info.Protect -band 0x100) -eq 0) -and (($info.Protect -band 0xFF) -ne 0x01) -and ($info.Protect -ne 0) -and
                ($size -lt 1073741824)
    if ($readable) {
      $regionEnd = $addr + $size; $p = $addr
      while ($p -lt $regionEnd) {
        $n = [Math]::Min([UInt64]$chunk, $regionEnd - $p)
        $read = [IntPtr]::Zero
        $ok = [Mem3]::ReadProcessMemory($h, [IntPtr][Int64]$p, $buf, [IntPtr][Int64]$n, [ref]$read)
        $got = [UInt64]$read.ToInt64()
        if ($ok -and $got -gt 0) {
          $s = $enc.GetString($buf, 0, [int]$got)
          foreach ($pat in $pats) {
            foreach ($m in $pat.Matches($s)) {
              [void]$found.Add($m.Groups[1].Value + '|' + $m.Groups[2].Value)
            }
          }
          $scanned += $got
          # advance with a 256-byte overlap so a URL string that straddles a
          # chunk boundary still appears whole in the next read (a torn match
          # yields a truncated guid that can never connect)
          $p += [Math]::Max([UInt64]4096, $got - [UInt64]256)
          if ($got -lt $n) { continue }
        } else { $p += 4096 }
      }
    }
    $addr += $size
  }
  Write-Host ("process {0}#{1}: {2} MB scanned, {3} endpoint(s)" -f $proc.ProcessName, $proc.Id, [int]($scanned/1MB), $found.Count)
  return $found
}

$all = New-Object System.Collections.Generic.HashSet[string]
# Scan ONLY the game process. BlizzardBrowser processes can outlive game
# restarts and hold stale endpoint strings from previous sessions, which
# caused dead-endpoint candidates; the game process only ever knows its own
# current URL.
$targets = @(Get-Process 'Warcraft III' -ErrorAction SilentlyContinue)
foreach ($proc in $targets) {
  foreach ($f in (Scan-Proc $proc)) { [void]$all.Add($f) }
}

if ($all.Count -eq 0) { throw "No bridge endpoints found - is the game running and logged in (chat view)?" }
$valid = @($all | Where-Object { $_ -match '^\d+\|\d+$' })
if ($valid.Count -eq 0) { throw "Only malformed candidates found" }
"all candidates (port|guid):"
$valid
$pairs = @($valid | Sort-Object -Property @{ Expression = { [int]$_.Split('|')[0] } },
                                       @{ Expression = { ($_.Split('|')[1]).Length }; Descending = $true })
# Chunk-boundary artifacts produce truncated guids; the full one is always the
# longest digit run for the port, so prefer length within each port.
$best = $pairs[0].Split('|')
@{ port = [int]$best[0]; guid = $best[1]; candidates = $pairs; scannedAt = (Get-Date -Format o) } |
  ConvertTo-Json | Set-Content $OutFile
"cached port=$($best[0]) guid=$($best[1]) to $OutFile"
