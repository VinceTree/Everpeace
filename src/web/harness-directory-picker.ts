import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export type DirectoryPicker = (title: string, signal: AbortSignal) => Promise<string | null>;

const run = promisify(execFile);
const windowsPicker = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class EverpeaceFolderDialog {
    // IFileDialog methods through GetResult, in COM vtable order.
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface FileDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr types);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(ShellItem folder);
        void SetFolder(ShellItem folder);
        void GetFolder(out ShellItem folder);
        void GetCurrentSelection(out ShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out ShellItem item);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid type, out IntPtr result);
        void GetParent(out ShellItem parent);
        void GetDisplayName(uint format, out IntPtr name);
    }

    public static string Pick(string title, IntPtr owner) {
        const uint pickFolders = 0x20;
        const uint forceFileSystem = 0x40;
        const uint fileSystemPath = 0x80058000;
        const int cancelled = unchecked((int)0x800704c7);
        var clsid = new Guid("dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7");
        var dialog = (FileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(clsid));
        try {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | pickFolders | forceFileSystem);
            dialog.SetTitle(title);
            var result = dialog.Show(owner);
            if (result == cancelled) return null;
            Marshal.ThrowExceptionForHR(result);
            ShellItem item;
            dialog.GetResult(out item);
            try {
                IntPtr path;
                item.GetDisplayName(fileSystemPath, out path);
                try { return Marshal.PtrToStringUni(path); }
                finally { Marshal.FreeCoTaskMem(path); }
            } finally { Marshal.ReleaseComObject(item); }
        } finally { Marshal.ReleaseComObject(dialog); }
    }
}
'@
$owner = [Windows.Forms.Form]::new()
$owner.Text = $env:EVERPEACE_DIRECTORY_TITLE
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
try {
  $owner.Show()
  $owner.Activate()
  $selected = [EverpeaceFolderDialog]::Pick($owner.Text, $owner.Handle)
  if ($null -ne $selected) { [Console]::WriteLine($selected) }
} finally {
  $owner.Dispose()
}`;

export const pickNativeWorkspace: DirectoryPicker = async (title, signal) => {
  const config = { cwd: homedir(), signal, maxBuffer: 16_384, windowsHide: true };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows directory picker is unavailable");
    const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await run(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
      Buffer.from(windowsPicker, "utf16le").toString("base64"),
    ], { ...config, env: { ...process.env, EVERPEACE_DIRECTORY_TITLE: title } });
    return stdout.replace(/[\r\n]+$/u, "") || null;
  }
  if (process.platform === "darwin") {
    const { stdout } = await run("/usr/bin/osascript", [
      "-e", "on run argv",
      "-e", "try",
      "-e", "return POSIX path of (choose folder with prompt (item 1 of argv))",
      "-e", "on error number -128",
      "-e", 'return ""',
      "-e", "end try",
      "-e", "end run", title,
    ], config);
    return stdout.replace(/[\r\n]+$/u, "") || null;
  }
  if (process.platform === "linux") {
    for (const [command, args] of [
      ["/usr/bin/zenity", ["--file-selection", "--directory", "--title", title]],
      ["/usr/bin/kdialog", ["--getexistingdirectory", homedir(), "--title", title]],
    ] as const) {
      try {
        const { stdout } = await run(command, [...args], config);
        return stdout.replace(/[\r\n]+$/u, "") || null;
      } catch (error) {
        const code = (error as { code?: string | number }).code;
        if (code === 1 && !signal.aborted) return null;
        if (code !== "ENOENT") throw error;
      }
    }
  }
  throw new Error("Native directory picker is unavailable");
};
