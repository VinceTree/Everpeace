param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot,
  [ValidateSet('inspect','capture','text','keys','resize','wheel','zoom')][string]$Action = 'capture',
  [string]$Value = '',
  [string]$Name = 'capture',
  [ValidateSet('Everpeace offline acceptance','Everpeace offline acceptance team')][string]$WindowTitle = 'Everpeace offline acceptance',
  [int]$Width = 1100,
  [int]$Height = 760,
  [ValidateRange(0,60)][int]$WaitForFocusSeconds = 0,
  [switch]$KeepForeground,
  [switch]$ControlSession
)
$ErrorActionPreference = 'Stop'
# Only the explicitly launched offline acceptance window may receive input.
$ownedMarker = Get-Content -LiteralPath (Join-Path $EvidenceRoot 'ownership.json') -Raw | ConvertFrom-Json
if ($ownedMarker.kind -ne 'everpeace-readiness') { throw 'Missing owned readiness root' }
$targetProcess = Get-Process -Id $TargetPid
if ($targetProcess.ProcessName -ne 'WindowsTerminal') { throw 'Refusing to control an unrelated process' }
if ($ControlSession) {
  # One explicitly authorized control session avoids a new approval window per key.
  # Accept only the same bounded actions; each child rechecks ownership and focus.
  Write-Output 'CONTROL READY: JSON action/value/name/width/height lines; quit ends control only.'
  while ($null -ne ($line = [Console]::ReadLine())) {
    if ($line -eq 'quit') { break }
    try {
      $request = $line | ConvertFrom-Json
      $arguments = @('-NoProfile', '-File', $PSCommandPath, '-TargetPid', $TargetPid,
        '-EvidenceRoot', $EvidenceRoot, '-KeepForeground', '-WaitForFocusSeconds', 45,
        '-WindowTitle', $WindowTitle, '-Action', [string]$request.action, '-Name', [string]$request.name)
      if ($null -ne $request.value) { $arguments += @('-Value', [string]$request.value) }
      if ($null -ne $request.width) { $arguments += @('-Width', [int]$request.width) }
      if ($null -ne $request.height) { $arguments += @('-Height', [int]$request.height) }
      & (Join-Path $PSHOME 'pwsh.exe') @arguments
      Write-Output "CONTROL RESULT: $LASTEXITCODE"
      if ($LASTEXITCODE -ne 0) { break }
    } catch { Write-Output "CONTROL ERROR: $_" }
  }
  return
}
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FixtureWindow {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd,int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first,uint second,bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string className,string title);
  // Preserve a native NULL class name; PowerShell can coerce $null to "".
  public static IntPtr FindAcceptanceWindow(string title) { return FindWindow(null, title); }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd,int x,int y,int width,int height,bool repaint);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr wparam,IntPtr lparam);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
}
'@
[FixtureWindow]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$window = [FixtureWindow]::FindAcceptanceWindow($WindowTitle)
if ($window -eq 0 -and $targetProcess.MainWindowTitle -eq $WindowTitle) { $window = $targetProcess.MainWindowHandle }
if ($window -eq 0) { throw 'Acceptance window has no visible handle' }
$windowOwner = [uint32]0
[FixtureWindow]::GetWindowThreadProcessId($window, [ref]$windowOwner) | Out-Null
if ($windowOwner -ne $TargetPid) { throw 'Refusing to control a window from another process' }
$previousWindow = [FixtureWindow]::GetForegroundWindow()
if ($Action -eq 'inspect') {
  $foregroundOwner = [uint32]0
  [FixtureWindow]::GetWindowThreadProcessId($previousWindow, [ref]$foregroundOwner) | Out-Null
  @{ targetWindow = $window.ToInt64(); targetPid = $TargetPid; visible = [FixtureWindow]::IsWindowVisible($window);
    minimized = [FixtureWindow]::IsIconic($window); foregroundWindow = $previousWindow.ToInt64();
    foregroundPid = $foregroundOwner; foregroundIsTarget = $previousWindow -eq $window;
    foregroundProcess = (Get-Process -Id $foregroundOwner -ErrorAction SilentlyContinue).ProcessName } | ConvertTo-Json
  return
}
try {
  if ([FixtureWindow]::IsIconic($window) -or -not [FixtureWindow]::IsWindowVisible($window)) {
    [FixtureWindow]::ShowWindowAsync($window, 9) | Out-Null
    Start-Sleep -Milliseconds 150
  }
  [FixtureWindow]::SetForegroundWindow($window) | Out-Null
  $sender = New-Object -ComObject WScript.Shell
  if ([FixtureWindow]::GetForegroundWindow() -ne $window) {
    $sender.AppActivate($WindowTitle) | Out-Null
  }
  if ([FixtureWindow]::GetForegroundWindow() -ne $window) {
    $foregroundThread = [FixtureWindow]::GetWindowThreadProcessId([FixtureWindow]::GetForegroundWindow(), [ref]$windowOwner)
    $currentThread = [FixtureWindow]::GetCurrentThreadId()
    $attached = [FixtureWindow]::AttachThreadInput($currentThread, $foregroundThread, $true)
    try {
      [FixtureWindow]::ShowWindow($window, 9) | Out-Null
      [FixtureWindow]::BringWindowToTop($window) | Out-Null
      [FixtureWindow]::SetForegroundWindow($window) | Out-Null
    } finally { if ($attached) { [FixtureWindow]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null } }
  }
  Start-Sleep -Milliseconds 150
  $focusDeadline = [DateTime]::UtcNow.AddSeconds($WaitForFocusSeconds)
  while ([FixtureWindow]::GetForegroundWindow() -ne $window -and [DateTime]::UtcNow -lt $focusDeadline) {
    Start-Sleep -Milliseconds 100
  }
  if ([FixtureWindow]::GetForegroundWindow() -ne $window) { throw 'Acceptance window did not acquire focus' }
  if ($Action -eq 'text') {
    foreach ($character in $Value.ToCharArray()) {
      if ([FixtureWindow]::GetForegroundWindow() -ne $window) { throw 'Acceptance window lost focus during text input' }
      $escaped = [regex]::Replace([string]$character, '[+^%~()\[\]{}]', { param($match) '{' + $match.Value + '}' })
      $sender.SendKeys($escaped)
      Start-Sleep -Milliseconds 30
    }
  } elseif ($Action -eq 'keys') {
    foreach ($keyGroup in $Value.Split("`n")) {
      if ([FixtureWindow]::GetForegroundWindow() -ne $window) { throw 'Acceptance window lost focus during key input' }
      $sender.SendKeys($keyGroup)
      Start-Sleep -Milliseconds 250
    }
  } elseif ($Action -eq 'resize') {
    [FixtureWindow]::MoveWindow($window, 40, 40, $Width, $Height, $true) | Out-Null
  } elseif ($Action -eq 'wheel' -or $Action -eq 'zoom') {
    # WM_MOUSEWHEEL directed only to the owned Terminal window; sign controls direction.
    $delta = [int]$Value
    $wheelRectangle = New-Object FixtureWindow+Rect
    [FixtureWindow]::GetWindowRect($window, [ref]$wheelRectangle) | Out-Null
    $wheelX = [int](($wheelRectangle.Left + $wheelRectangle.Right) / 2)
    $wheelY = [int](($wheelRectangle.Top + $wheelRectangle.Bottom) / 2)
    $position = (([int64]$wheelY -band 65535) -shl 16) -bor ($wheelX -band 65535)
    $modifiers = if ($Action -eq 'zoom') { 8 } else { 0 }
    $pressControl = $Action -eq 'zoom' -and [FixtureWindow]::GetAsyncKeyState(0x11) -ge 0
    try {
      if ($pressControl) { [FixtureWindow]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50 }
      if ([FixtureWindow]::GetForegroundWindow() -ne $window) { throw 'Acceptance window lost focus before wheel input' }
      [FixtureWindow]::SendMessage($window, 0x020A, [IntPtr](([int64]$delta -shl 16) -bor $modifiers), [IntPtr]$position) | Out-Null
    } finally {
      if ($pressControl) { [FixtureWindow]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero) }
    }
  }
  Start-Sleep -Milliseconds 250
  if ([FixtureWindow]::GetForegroundWindow() -ne $window) { throw 'Acceptance window lost focus before capture' }
  $rectangle = New-Object FixtureWindow+Rect
  [FixtureWindow]::GetWindowRect($window, [ref]$rectangle) | Out-Null
  $imageWidth = $rectangle.Right - $rectangle.Left
  $imageHeight = $rectangle.Bottom - $rectangle.Top
  if ($imageWidth -lt 100 -or $imageHeight -lt 100) { throw 'Acceptance window is not visible' }
  $bitmap = New-Object System.Drawing.Bitmap($imageWidth, $imageHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    # Render only the owned HWND; screen coordinates can capture overlapping windows.
    $deviceContext = $graphics.GetHdc()
    try {
      if (-not [FixtureWindow]::PrintWindow($window, $deviceContext, 2)) { throw 'Owned window capture failed' }
    } finally { $graphics.ReleaseHdc($deviceContext) }
    $captureMethod = 'PrintWindow'
    $hasPixels = $false
    for ($sampleX = 20; $sampleX -lt $imageWidth; $sampleX += 80) {
      for ($sampleY = 20; $sampleY -lt $imageHeight; $sampleY += 80) {
        $pixel = $bitmap.GetPixel($sampleX, $sampleY)
        if ($pixel.R -gt 5 -or $pixel.G -gt 5 -or $pixel.B -gt 5) { $hasPixels = $true }
      }
    }
    if (-not $hasPixels) {
      # Some GPU-rendered Terminal windows return only black via PrintWindow.
      # Capture the foreground owned rectangle and reject any focus change.
      if ([FixtureWindow]::GetForegroundWindow() -ne $window) { throw 'Owned window lost focus before screen capture' }
      $graphics.CopyFromScreen($rectangle.Left, $rectangle.Top, 0, 0, $bitmap.Size)
      if ([FixtureWindow]::GetForegroundWindow() -ne $window) { throw 'Owned window lost focus during screen capture' }
      $captureMethod = 'foreground-owned-rectangle'
    }
    if ($Name -notmatch '^[a-z0-9-]+$') { throw 'Invalid evidence filename' }
    $outputDirectory = Join-Path $EvidenceRoot 'terminal-evidence'
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $outputFile = Join-Path $outputDirectory ($Name + '.png')
    $bitmap.Save($outputFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $record = @{ at = [DateTime]::UtcNow.ToString('o'); pid = $TargetPid; action = $Action; value = $Value; screenshot = $outputFile; captureMethod = $captureMethod; width = $imageWidth; height = $imageHeight; terminal = $targetProcess.Path; terminalVersion = $targetProcess.FileVersion }
    Add-Content -LiteralPath (Join-Path $outputDirectory 'actions.jsonl') -Value ($record | ConvertTo-Json -Compress)
    Write-Output $outputFile
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
} finally {
  if (-not $KeepForeground -and $previousWindow -ne [IntPtr]::Zero -and $previousWindow -ne $window) { [FixtureWindow]::SetForegroundWindow($previousWindow) | Out-Null }
}
