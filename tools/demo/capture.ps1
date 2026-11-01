# Captures the VS Code test window to PNG frames until a STOP file appears.
# Usage: powershell -File capture.ps1 <framesDir> <windowTitleFragment>
param([string]$FramesDir, [string]$TitleFragment = "Visual Studio Code")

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int W, int H, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
}
"@

$stop = Join-Path $FramesDir "STOP"
$i = 0
$t0 = [DateTime]::UtcNow
$foregrounded = $false
while (-not (Test-Path $stop)) {
  # ONLY the throwaway VS Code that the harness launched from .vscode-test, opened
  # on the "sample" fixture. Never the user's own editor (which may show private
  # windows, chats and terminals).
  $proc = Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.Path -like "*\.vscode-test\*" -and $_.MainWindowTitle -like "*sample*" -and $_.MainWindowTitle -like "*$TitleFragment*"
  } | Select-Object -First 1
  if ($null -eq $proc -and $i -eq 0) {
    Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { Add-Content (Join-Path $FramesDir "debug.txt") ("[" + [DateTime]::UtcNow.ToString("HH:mm:ss") + "] title=" + $_.MainWindowTitle + " | path=" + $_.Path) }
  }
  if ($null -ne $proc) {
    if (-not $foregrounded) {
      # Normal (not maximised) window at a fixed 1600x1000 so the GIF stays legible,
      # cursor parked inside it so no taskbar thumbnails pop up over the capture.
      [Win32]::ShowWindow($proc.MainWindowHandle, 1) | Out-Null
      [Win32]::MoveWindow($proc.MainWindowHandle, 40, 20, 1600, 1000, $true) | Out-Null
      [Win32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
      [Win32]::SetCursorPos(900, 560) | Out-Null
      $foregrounded = $true; Start-Sleep -Milliseconds 900
    }
    $r = New-Object Win32+RECT
    [Win32]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    if ($w -gt 200 -and $h -gt 200) {
      $bmp = New-Object System.Drawing.Bitmap $w, $h
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      # Render the window's own contents (PW_RENDERFULLCONTENT), never the screen: this
      # captures only the harness window even when another window covers it.
      $hdc = $g.GetHdc()
      [Win32]::PrintWindow($proc.MainWindowHandle, $hdc, 2) | Out-Null
      $g.ReleaseHdc($hdc)
      $g.Dispose()
      $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $bmp.Save((Join-Path $FramesDir ("{0:D5}_{1:D13}.png" -f $i, $ms)), [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      $i++
    }
  }
  Start-Sleep -Milliseconds 180
}
Write-Output "captured $i frames"
