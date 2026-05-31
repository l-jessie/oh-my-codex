/**
 * OpenCodex Operating System Action Performer
 * Performs mouse clicks, smooth drags, scroll events, keyboard typing, key presses,
 * and window management using platform-native APIs.
 * macOS: Swift CGEvent APIs
 * Windows: PowerShell with System.Windows.Forms / user32.dll P/Invoke
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WindowInfo {
  id: number;
  title: string;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ActionPerformer {
  private isWin = process.platform === "win32";

  // ─── Mouse Actions ───

  async click(x: number, y: number, button = "left", clicks = 1) {
    for (let i = 0; i < clicks; i++) {
      if (this.isWin) this.runPs(this.psClick(x, y, button));
      else this.runSwift("click", [String(x), String(y), button === "right" ? "right" : "left"]);
    }
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number) {
    if (this.isWin) this.runPs(this.psDrag(fromX, fromY, toX, toY));
    else this.runSwift("drag", [String(fromX), String(fromY), String(toX), String(toY)]);
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number) {
    if (this.isWin) this.runPs(this.psScroll(deltaX, deltaY));
    else this.runSwift("scroll", [String(x), String(y), String(deltaX), String(deltaY)]);
  }

  // ─── Keyboard Actions ───

  async typeText(text: string) {
    if (this.isWin) this.runPs(this.psType(text));
    else this.runSwift("type", [text]);
  }

  async pressKey(key: string) {
    if (this.isWin) this.runPs(this.psKey(key));
    else this.runSwift("key", [key]);
  }

  async pageScroll(direction: string, pages = 1) {
    const k = direction === "down" ? "page_down" : "page_up";
    for (let i = 0; i < pages; i++) {
      if (this.isWin) this.runPs(this.psKey(k));
      else this.runSwift("key", [k]);
    }
  }

  // ─── Window Management ──

  async getWindows(): Promise<WindowInfo[]> {
    if (this.isWin) {
      const out = this.runPsRaw(this.psWindows());
      return JSON.parse(out || "[]");
    }
    const out = this.runSwift("windows", []);
    return JSON.parse(out);
  }

  async focusWindow(windowId: number) {
    if (this.isWin) this.runPs(this.psFocus(windowId));
    else this.runSwift("focus", [String(windowId)]);
  }

  // ══════════════════════════════════════════════════════════
  //  Windows PowerShell helpers
  // ══════════════════════════════════════════════════════════

  private runPs(script: string) {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      timeout: 15000,
      encoding: "utf-8",
      windowsHide: true,
    });
    if (r.status !== 0) throw new Error(r.stderr?.trim() || "PowerShell error");
  }

  private runPsRaw(script: string): string {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      timeout: 15000,
      encoding: "utf-8",
      windowsHide: true,
    });
    return r.stdout?.trim() || "[]";
  }

  private psClick(x: number, y: number, button: string): string {
    const btn = button === "right" ? 2 : 0;
    return `
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
      $sig = '[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);'
      $m = Add-Type -MemberDefinition $sig -Name "Mouse" -Namespace "Win32" -PassThru
      if (${btn} -eq 2) {
        $m::mouse_event(0x0008, 0, 0, 0, 0)
        $m::mouse_event(0x0010, 0, 0, 0, 0)
      } else {
        $m::mouse_event(0x0002, 0, 0, 0, 0)
        $m::mouse_event(0x0004, 0, 0, 0, 0)
      }
    `.trim();
  }

  private psDrag(fx: number, fy: number, tx: number, ty: number): string {
    return `
      Add-Type -AssemblyName System.Windows.Forms
      $sig = '[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);'
      $m = Add-Type -MemberDefinition $sig -Name "Mouse" -Namespace "Win32" -PassThru
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${fx}, ${fy})
      $m::mouse_event(0x0002, 0, 0, 0, 0)
      $steps = 20
      for ($i = 1; $i -le $steps; $i++) {
        $t = $i / $steps
        $cx = [int](${fx} + (${tx} - ${fx}) * $t)
        $cy = [int](${fy} + (${ty} - ${fy}) * $t)
        [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($cx, $cy)
        Start-Sleep -Milliseconds 10
      }
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${tx}, ${ty})
      $m::mouse_event(0x0004, 0, 0, 0, 0)
    `.trim();
  }

  private psScroll(_dx: number, dy: number): string {
    const amount = dy * 120;
    return `
      Add-Type -AssemblyName System.Windows.Forms
      $sig = '[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);'
      $m = Add-Type -MemberDefinition $sig -Name "Mouse" -Namespace "Win32" -PassThru
      $m::mouse_event(0x0800, 0, 0, ${amount}, 0)
    `.trim();
  }

  private psType(text: string): string {
    const escaped = text.replace(/'/g, "''");
    return `
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${escaped}')
    `.trim();
  }

  private psKey(key: string): string {
    const map: Record<string, string> = {
      return: "{ENTER}", enter: "{ENTER}", tab: "{TAB}", escape: "{ESC}", esc: "{ESC}",
      space: " ", backspace: "{BACKSPACE}", delete: "{DELETE}",
      up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
      home: "{HOME}", end: "{END}", page_up: "{PGUP}", page_down: "{PGDN}",
      "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
      "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
    };
    const parts = key.toLowerCase().split("+");
    const last = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    let sendKey = map[last] || last;

    // Modifier prefix for SendKeys: ^ = Ctrl, % = Alt, + = Shift
    let prefix = "";
    if (mods.includes("ctrl") || mods.includes("control")) prefix += "^";
    if (mods.includes("alt") || mods.includes("option")) prefix += "%";
    if (mods.includes("shift")) prefix += "+";
    // cmd on Windows maps to Win key — SendKeys doesn't support it, skip

    return `
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${prefix}${sendKey.replace(/'/g, "''")}')
    `.trim();
  }

  private psWindows(): string {
    return `
      Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      using System.Text;
      using System.Collections.Generic;
      public class WinAPI {
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
      }
      "@
      $list = New-Object System.Collections.ArrayList
      $cb = [WinAPI+EnumWindowsProc]{
        param($hWnd, $lParam)
        if ([WinAPI]::IsWindowVisible($hWnd)) {
          $sb = New-Object System.Text.StringBuilder 256
          [WinAPI]::GetWindowText($hWnd, $sb, 256) | Out-Null
          $title = $sb.ToString()
          if ($title.Length -gt 0) {
            $pid = 0; [WinAPI]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
            $rect = New-Object WinAPI+RECT
            [WinAPI]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
            $proc = try { (Get-Process -Id $pid).ProcessName } catch { "" }
            $list.Add(@{id=[int]$hWnd; title=$title; app=$proc; x=$rect.Left; y=$rect.Top; width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top}) | Out-Null
          }
        }
        return $true
      }
      [WinAPI]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
      $list | ConvertTo-Json -Compress
    `.trim();
  }

  private psFocus(windowId: number): string {
    return `
      Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class FocusWin {
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
      }
      "@
      $hWnd = [IntPtr]${windowId}
      [FocusWin]::ShowWindow($hWnd, 9) | Out-Null
      [FocusWin]::SetForegroundWindow($hWnd) | Out-Null
    `.trim();
  }

  // ══════════════════════════════════════════════════════════
  //  macOS Swift Script Execution Engine
  // ══════════════════════════════════════════════════════════

  private runSwift(action: string, args: string[]): string {
    const script = this.getSwiftScript(action, args);
    const scriptPath = join(tmpdir(), `oc-act-${Date.now()}.swift`);
    try {
      writeFileSync(scriptPath, script, "utf-8");
      const r = spawnSync("/usr/bin/swift", [scriptPath], { timeout: 15000, encoding: "utf-8" });
      if (r.status !== 0) {
        const errorMsg = (r.stderr || r.stdout || "Unknown execution error").trim().split("\n").slice(0, 3).join(" | ");
        throw new Error(`Swift Execution Failed: ${errorMsg}`);
      }
      return r.stdout?.trim() || "";
    } finally {
      try { unlinkSync(scriptPath); } catch {}
    }
  }

  private getSwiftScript(action: string, a: string[]): string {
    const esc = (s: string) => s.replace(/"/g, '\\"').replace(/\\/g, "\\\\");

    switch (action) {
      case "click": {
        const [x, y, b] = a;
        const isRight = b === "right";
        return [
          "import Cocoa",
          `let p = CGPoint(x: ${x}, y: ${y})`,
          `let btn: CGMouseButton = ${isRight ? ".right" : ".left"}`,
          `CGEvent(mouseEventSource: nil, mouseType: ${isRight ? ".rightMouseDown" : ".leftMouseDown"}, mouseCursorPosition: p, mouseButton: btn)!.post(tap: .cghidEventTap)`,
          `CGEvent(mouseEventSource: nil, mouseType: ${isRight ? ".rightMouseUp" : ".leftMouseUp"}, mouseCursorPosition: p, mouseButton: btn)!.post(tap: .cghidEventTap)`,
        ].join("\n");
      }
      case "drag": {
        const [fx, fy, tx, ty] = a;
        return [
          "import Cocoa",
          `let from = CGPoint(x: ${fx}, y: ${fy})`,
          `let to   = CGPoint(x: ${tx}, y: ${ty})`,
          "CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)!.post(tap: .cghidEventTap)",
          "let steps = 20",
          "for i in 1...steps {",
          "  let t = Double(i) / Double(steps)",
          "  let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)",
          "  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)",
          "  Thread.sleep(forTimeInterval: 0.01)",
          "}",
          "CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)!.post(tap: .cghidEventTap)",
        ].join("\n");
      }
      case "scroll": {
        const [x, y, dx, dy] = a;
        return [
          "import Cocoa",
          `let p = CGPoint(x: ${x}, y: ${y})`,
          `let ev = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(${dy}), wheel2: Int32(${dx}), wheel3: 0)!`,
          "ev.post(tap: .cghidEventTap)",
        ].join("\n");
      }
      case "type": {
        const t = esc(a[0]);
        return [
          "import Cocoa",
          "let src = CGEventSource(stateID: .combinedSessionState)",
          `for ch in "${t}".utf16 {`,
          "  var c = ch",
          "  let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!",
          "  ev.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)",
          "  ev.post(tap: .cghidEventTap)",
          "  CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!.post(tap: .cghidEventTap)",
          "}",
        ].join("\n");
      }
      case "key": {
        const k = a[0];
        const K: Record<string, number> = {
          return: 36, enter: 36, tab: 48, escape: 53, esc: 53, space: 49, backspace: 51, delete: 51,
          up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, page_up: 116, page_down: 121,
          a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38, k: 40, l: 37, m: 46, n: 45,
          o: 31, p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
          "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 22, "6": 23, "7": 24, "8": 25, "9": 26,
        };
        if (k === "page_down" || k === "page_up") {
          const c = k === "page_down" ? 121 : 116;
          return `import Cocoa\nlet src = CGEventSource(stateID: .combinedSessionState)\nCGEvent(keyboardEventSource: src, virtualKey: ${c}, keyDown: true)!.post(tap: .cghidEventTap)\nCGEvent(keyboardEventSource: src, virtualKey: ${c}, keyDown: false)!.post(tap: .cghidEventTap)`;
        }
        const parts = k.toLowerCase().split("+");
        const lk = parts[parts.length - 1];
        const ms = parts.slice(0, -1);
        const kc = K[lk] ?? 0;
        const flags: string[] = [];
        if (ms.includes("cmd") || ms.includes("command")) flags.push(".maskCommand");
        if (ms.includes("ctrl") || ms.includes("control")) flags.push(".maskControl");
        if (ms.includes("alt") || ms.includes("option")) flags.push(".maskAlternate");
        if (ms.includes("shift")) flags.push(".maskShift");
        if (flags.length > 0) {
          return [
            "import Cocoa",
            "let src = CGEventSource(stateID: .combinedSessionState)",
            `let d = CGEvent(keyboardEventSource: src, virtualKey: ${kc}, keyDown: true)!`,
            `d.flags = [${flags.join(", ")}]`,
            "d.post(tap: .cghidEventTap)",
            `CGEvent(keyboardEventSource: src, virtualKey: ${kc}, keyDown: false)!.post(tap: .cghidEventTap)`,
          ].join("\n");
        }
        return [
          "import Cocoa",
          "let src = CGEventSource(stateID: .combinedSessionState)",
          `CGEvent(keyboardEventSource: src, virtualKey: ${kc}, keyDown: true)!.post(tap: .cghidEventTap)`,
          `CGEvent(keyboardEventSource: src, virtualKey: ${kc}, keyDown: false)!.post(tap: .cghidEventTap)`,
        ].join("\n");
      }
      case "windows": {
        return [
          'import Cocoa',
          'let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]',
          'let filtered = list.filter { $0["kCGWindowLayer"] as? Int == 0 && $0["kCGWindowOwnerName"] != nil }',
          'let json = filtered.map { w -> [String: Any] in',
          '  let bounds = w["kCGWindowBounds"] as? [String: Double] ?? [:]',
          '  return [',
          '    "id": w["kCGWindowNumber"] as? Int ?? 0,',
          '    "title": w["kCGWindowName"] as? String ?? "",',
          '    "app": w["kCGWindowOwnerName"] as? String ?? "",',
          '    "x": bounds["X"] ?? 0,',
          '    "y": bounds["Y"] ?? 0,',
          '    "width": bounds["Width"] ?? 0,',
          '    "height": bounds["Height"] ?? 0,',
          '  ]',
          '}',
          'if let d = try? JSONSerialization.data(withJSONObject: json, options: []),',
          '   let s = String(data: d, encoding: .utf8) { print(s) }',
        ].join("\n");
      }
      case "focus": {
        const [wid] = a;
        return [
          "import Cocoa",
          `let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]`,
          `let target = list.first { $0["kCGWindowNumber"] as? Int == ${wid} }`,
          `if let t = target,`,
          `   let pid = t["kCGWindowOwnerPID"] as? Int,`,
          `   let app = NSRunningApplication(processIdentifier: pid_t(pid)) {`,
          `  app.activate(options: .activateIgnoringOtherApps)`,
          `}`,
        ].join("\n");
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
}
