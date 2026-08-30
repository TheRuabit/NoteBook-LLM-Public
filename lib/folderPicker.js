import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$dialog.Description = '选择文献文件夹'",
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))) }',
].join('; ');

export async function pickFolder(runCommand = run) {
  if (process.platform !== 'win32') throw new Error('系统文件夹选择仅支持 Windows');
  const { stdout } = await runCommand('powershell.exe', ['-NoProfile', '-STA', '-Command', SCRIPT], { windowsHide: true });
  return stdout.trim() ? Buffer.from(stdout.trim(), 'base64').toString('utf8') : '';
}
