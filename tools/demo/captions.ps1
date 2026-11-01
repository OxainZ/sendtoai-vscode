# Renders caption pills to PNG (with alpha) for build-gif.cjs to composite.
# Usage: powershell -File captions.ps1 <captionsJson> <outDir>
param([string]$CaptionsJson, [string]$OutDir)
Add-Type -AssemblyName System.Drawing
$items = Get-Content $CaptionsJson -Raw -Encoding UTF8 | ConvertFrom-Json
$orange = [System.Drawing.Color]::FromArgb(255, 224, 123, 57)
$pill   = [System.Drawing.Color]::FromArgb(232, 22, 22, 26)
$subCol = [System.Drawing.Color]::FromArgb(255, 205, 205, 210)
$titleFont = [System.Drawing.Font]::new("Segoe UI Semibold", 23, [System.Drawing.FontStyle]::Bold)
$subFont   = [System.Drawing.Font]::new("Segoe UI", 15)
$badgeFont = [System.Drawing.Font]::new("Segoe UI", 18, [System.Drawing.FontStyle]::Bold)
$i = 0
foreach ($c in $items) {
  $probe = [System.Drawing.Bitmap]::new(10, 10)
  $pg = [System.Drawing.Graphics]::FromImage($probe)
  $pg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $titleSize = $pg.MeasureString([string]$c.title, $titleFont)
  $hasSub = -not [string]::IsNullOrEmpty($c.sub)
  $subW = 0; $subH = 0
  if ($hasSub) { $s = $pg.MeasureString([string]$c.sub, $subFont); $subW = $s.Width; $subH = $s.Height }
  $pg.Dispose(); $probe.Dispose()

  $w = [int]([Math]::Max($titleSize.Width, $subW) + 96)
  $h = [int]($titleSize.Height + $(if ($hasSub) { $subH + 2 } else { 0 }) + 30)
  $bmp = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $r = 20
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc(1, 1, $r, $r, 180, 90)
  $path.AddArc($w - $r - 2, 1, $r, $r, 270, 90)
  $path.AddArc($w - $r - 2, $h - $r - 2, $r, $r, 0, 90)
  $path.AddArc(1, $h - $r - 2, $r, $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath([System.Drawing.SolidBrush]::new($pill), $path)
  $g.DrawPath([System.Drawing.Pen]::new($orange, 2), $path)

  $by = [int](($h - 42) / 2)
  $g.FillEllipse([System.Drawing.SolidBrush]::new($orange), 16, $by, 42, 42)
  $sf = [System.Drawing.StringFormat]::new()
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $badgeRect = [System.Drawing.RectangleF]::new(16, $by, 42, 42)
  $g.DrawString([string]$c.step, $badgeFont, [System.Drawing.Brushes]::White, $badgeRect, $sf)
  $g.DrawString([string]$c.title, $titleFont, [System.Drawing.Brushes]::White, 72, 12)
  if ($hasSub) { $g.DrawString([string]$c.sub, $subFont, [System.Drawing.SolidBrush]::new($subCol), 74, 12 + $titleSize.Height) }
  $g.Dispose()
  $bmp.Save((Join-Path $OutDir ("caption_{0}.png" -f $i)), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $i++
}
Write-Output "rendered $i captions"
