# Capture the primary screen to a PNG, for manual UI verification.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/capture-window.ps1 D:\path\out.png
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI,
# so non-ASCII comments get mangled and can break parsing.
param([string]$Out = "shot.png")

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()

Write-Output "saved $Out ($($bounds.Width)x$($bounds.Height))"
