param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot,
  [ValidateSet('capture','text','keys','resize','wheel')][string]$Action = 'capture',
  [string]$Value = '',
  [string]$Name = 'capture',
  [int]$Width = 1100,
  [int]$Height = 760
)
$ErrorActionPreference = 'Stop'
# Only the explicitly launched offline acceptance window may receive input.
$ownedMarker = Get-Content -LiteralPath (Join-Path $EvidenceRoot 'ownership.json') -Raw | ConvertFrom-Json
if ($ownedMarker.kind -ne 'everpeace-readiness') { throw 'Missing owned readiness root' }
$targetProcess = Get-Process -Id $TargetPid
if ($targetProcess.ProcessName -ne 'WindowsTerminal') { throw 'Refusing to control an unrelated process' }
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FixtureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string className,string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd,int x,int y,int width,int height,bool repaint);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr wparam,IntPtr lparam);
}
'@
$window = [FixtureWindow]::FindWindow($null, 'Everpeace offline acceptance')
if ($window -eq 0 -and $targetProcess.MainWindowTitle -eq 'Everpeace offline acceptance') { $window = $targetProcess.MainWindowHandle }
if ($window -eq 0) { throw 'Acceptance window has no visible handle' }
$windowOwner = [uint32]0
[FixtureWindow]::GetWindowThreadProcessId($window, [ref]$windowOwner) | Out-Null
if ($windowOwner -ne $TargetPid) { throw 'Refusing to control a window from another process' }
$previousWindow = [FixtureWindow]::GetForegroundWindow()
try {
  [FixtureWindow]::SetForegroundWindow($window) | Out-Null
  Start-Sleep -Milliseconds 150
  if ([FixtureWindow]::GetForegroundWindow() -ne $window) { throw 'Acceptance window did not acquire focus' }
  $sender = New-Object -ComObject WScript.Shell
  if ($Action -eq 'text') {
    $escaped = [regex]::Replace($Value, '[+^%~()\[\]{}]', { param($match) '{' + $match.Value + '}' })
    $sender.SendKeys($escaped)
  } elseif ($Action -eq 'keys') {
    $sender.SendKeys($Value)
  } elseif ($Action -eq 'resize') {
    [FixtureWindow]::MoveWindow($window, 40, 40, $Width, $Height, $true) | Out-Null
  } elseif ($Action -eq 'wheel') {
    # WM_MOUSEWHEEL directed only to the owned Terminal window; sign controls direction.
    $delta = [int]$Value
    $position = ([int64]100 -shl 16) -bor 100
    [FixtureWindow]::SendMessage($window, 0x020A, [IntPtr]([int64]$delta -shl 16), [IntPtr]$position) | Out-Null
  }
  Start-Sleep -Milliseconds 250
  $rectangle = New-Object FixtureWindow+Rect
  [FixtureWindow]::GetWindowRect($window, [ref]$rectangle) | Out-Null
  $imageWidth = $rectangle.Right - $rectangle.Left
  $imageHeight = $rectangle.Bottom - $rectangle.Top
  if ($imageWidth -lt 100 -or $imageHeight -lt 100) { throw 'Acceptance window is not visible' }
  $bitmap = New-Object System.Drawing.Bitmap($imageWidth, $imageHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rectangle.Left, $rectangle.Top, 0, 0, $bitmap.Size)
    if ($Name -notmatch '^[a-z0-9-]+$') { throw 'Invalid evidence filename' }
    $outputDirectory = Join-Path $EvidenceRoot 'terminal-evidence'
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $outputFile = Join-Path $outputDirectory ($Name + '.png')
    $bitmap.Save($outputFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $record = @{ at = [DateTime]::UtcNow.ToString('o'); pid = $TargetPid; action = $Action; value = $Value; screenshot = $outputFile; width = $imageWidth; height = $imageHeight; terminal = $targetProcess.Path; terminalVersion = $targetProcess.FileVersion }
    Add-Content -LiteralPath (Join-Path $outputDirectory 'actions.jsonl') -Value ($record | ConvertTo-Json -Compress)
    Write-Output $outputFile
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
} finally {
  if ($previousWindow -ne [IntPtr]::Zero -and $previousWindow -ne $window) { [FixtureWindow]::SetForegroundWindow($previousWindow) | Out-Null }
}
