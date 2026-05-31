/**
 * OpenCodex Screenshot Capture Utility
 * Captures the main screen using platform-native APIs.
 * macOS: Swift CGDisplay / screencapture utility
 * Windows: PowerShell .NET Screen capture
 */

import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ScreenshotTaker {
  async capture(): Promise<Buffer> {
    if (process.platform === "win32") {
      return this.windowsCapture();
    }
    try {
      return this.swiftCapture();
    } catch (err: any) {
      console.error("[OhMyCodex-Screenshot] Swift CGDisplay capture failed, falling back to screencapture utility:", err.message);
      return this.scCapture();
    }
  }

  // ── macOS: Swift CGDisplay ──
  private swiftCapture(): Buffer {
    const out = join(tmpdir(), `oc-shot-${Date.now()}.png`);
    const f = join(tmpdir(), `oc-shot-${Date.now()}.swift`);
    const swiftCode = `import Cocoa
import Foundation
let img = CGDisplayCreateImage(CGMainDisplayID())!
let rep = NSBitmapImageRep(cgImage: img)
let png = rep.representation(using: .png, properties: [:])!
try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
`;
    try {
      writeFileSync(f, swiftCode, "utf-8");
      const r = spawnSync("/usr/bin/swift", [f, out], { timeout: 10000 });
      if (r.status !== 0) throw new Error(r.stderr?.toString() || "Swift exit with error status");
      return readFileSync(out);
    } finally {
      try { unlinkSync(f); } catch {}
      try { unlinkSync(out); } catch {}
    }
  }

  // ── macOS fallback: screencapture CLI ──
  private scCapture(): Buffer {
    const out = join(tmpdir(), `oc-shot-sc-${Date.now()}.png`);
    try {
      execSync(`/usr/sbin/screencapture -x -t png "${out}"`, { timeout: 10000 });
      return readFileSync(out);
    } finally {
      try { unlinkSync(out); } catch {}
    }
  }

  // ── Windows: PowerShell .NET screenshot ──
  private windowsCapture(): Buffer {
    const out = join(tmpdir(), `oc-shot-win-${Date.now()}.png`).replace(/\\\\/g, "/");
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen
      $bitmap = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
      $bitmap.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose()
      $bitmap.Dispose()
    `.trim();
    try {
      spawnSync("powershell.exe", ["-NoProfile", "-Command", psScript], { timeout: 15000, windowsHide: true });
      return readFileSync(out);
    } finally {
      try { unlinkSync(out); } catch {}
    }
  }
  }
