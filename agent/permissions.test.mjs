import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalGate, isDangerousCommand } from "./permissions.mjs";

test("expired approval is removed, reported and cannot be approved later", async () => {
  const events = [];
  const gate = new ApprovalGate((event) => events.push(event), 10);
  await assert.rejects(gate.request("write", { path: "result.txt" }), /确认已超时/);
  assert.equal(gate.pending.size, 0);
  const id = events[0].approvalId;
  assert.deepEqual(events[1], { type: "approval-expired", approvalId: id });
  assert.throws(() => gate.reply(id, true), /已过期/);
});

test("approved and cancelled requests do not emit stale expiry events", async () => {
  const events = [];
  const gate = new ApprovalGate((event) => events.push(event), 10);
  const approved = gate.request("write", {});
  gate.reply(events[0].approvalId, true);
  await approved;
  const cancelled = gate.request("write", {});
  gate.cancel();
  await assert.rejects(cancelled, /操作已取消/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gate.pending.size, 0);
  assert.equal(events.filter((event) => event.type === "approval-expired").length, 0);
});

test("windows cmd destructive commands are flagged", () => {
  for (const command of [
    "del /f /s /q C:\\Windows\\Temp\\*",
    "erase /S /Q build",
    "rd /s /q C:\\Windows\\System32\\drivers",
    "rmdir /S /Q build",
    "format D: /q",
    "diskpart /s script.txt",
    "bcdedit /set {default} safeboot minimal",
    "cipher /w:C:\\",
    "sc delete wuauserv",
    "sc.exe stop WinDefend",
    "net stop wuauserv",
    "net user admin /add",
    "taskkill /f /im explorer.exe",
    "schtasks /delete /tn Piko /f",
    "schtasks /create /tn Piko /tr calc.exe",
    "icacls C:\\Windows /grant Everyone:F",
    "takeown /f C:\\Windows\\System32\\drivers\\etc\\hosts",
    "cacls C:\\Windows /e /g Everyone:f",
  ]) {
    assert.equal(isDangerousCommand(command), true, command);
  }
});

test("windows powershell and registry writes are flagged", () => {
  for (const command of [
    "Remove-Item -Recurse -Force C:\\workspace\\build",
    "remove-item C:\\workspace\\notes.txt",
    "Clear-Content C:\\workspace\\notes.txt",
    "Restart-Computer -Force",
    "Stop-Computer",
    "reg add HKLM\\Software\\Piko /v Auto /t REG_DWORD /d 1 /f",
    "reg.exe delete HKLM\\Software\\Piko /f",
    "reg import settings.reg",
    "regedit /s settings.reg",
    "Set-ItemProperty HKLM:\\Software\\Piko -Name Auto -Value 1",
    "New-ItemProperty HKLM:\\Software\\Piko -Name Auto -Value 1",
    "Remove-ItemProperty HKLM:\\Software\\Piko -Name Auto",
  ]) {
    assert.equal(isDangerousCommand(command), true, command);
  }
});

test("windows system directories are flagged on any drive or slash style", () => {
  for (const command of [
    "copy payload.dll C:\\Windows\\System32\\payload.dll",
    "copy payload.dll c:/windows/system32/payload.dll",
    "type C:\\Windows\\System32\\drivers\\etc\\hosts",
    "echo evil > C:\\Windows\\System32\\drivers\\etc\\hosts",
    "xcopy build \"C:\\Program Files\\Piko\" /e",
    "copy config.ini \"C:\\Program Files (x86)\\Piko\\config.ini\"",
    "copy config.ini C:\\ProgramData\\Piko\\config.ini",
    "echo %SystemRoot%",
    "cd %windir%\\System32",
    "copy tool.exe %ProgramFiles%\\Piko\\tool.exe",
  ]) {
    assert.equal(isDangerousCommand(command), true, command);
  }
});

test("everyday windows commands stay auto-approvable under shell=auto", () => {
  for (const command of [
    "npm test",
    "npm run build",
    "git status",
    "git diff --stat",
    "dir",
    "type package.json",
    "Get-ChildItem -Recurse",
    "Get-Content README.md",
    "reg query HKLM\\Software\\Piko",
    "sc query wuauserv",
    "tasklist /fi \"imagename eq node.exe\"",
    "where node",
    "C:\\Windows-app\\build.bat",
    "node scripts/build.mjs --out C:\\workspace\\dist",
    "echo hello > out.txt",
    "copy package.json C:\\workspace\\backup\\package.json",
  ]) {
    assert.equal(isDangerousCommand(command), false, command);
  }
});

test("blank or non-string commands are treated as dangerous", () => {
  assert.equal(isDangerousCommand(""), true);
  assert.equal(isDangerousCommand("   "), true);
  assert.equal(isDangerousCommand(undefined), true);
  assert.equal(isDangerousCommand({ command: "del /s /q C:\\" }), true);
});
