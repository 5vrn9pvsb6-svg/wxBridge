param(
    [ValidatePattern('^[A-Za-z0-9_.-]{1,128}$')][string]$PipeName = 'codex-ipc',
    [ValidateRange(1, 5000)][int]$ConnectTimeoutMs = 5000,
    [ValidateRange(1, 60000)][int]$LifetimeMs = 60000
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# All source is fixed. Chat content is carried as binary frames on stdin.
$source = @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;

public static class CodexBridgeDesktopPipe {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static bool IsSameUser(NamedPipeClientStream pipe) {
        uint pid;
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid))
            throw new InvalidOperationException("owner-query-failed");
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) throw new InvalidOperationException("owner-query-failed");
        IntPtr token = IntPtr.Zero;
        try {
            if (!OpenProcessToken(process, 0x0008, out token)) throw new InvalidOperationException("owner-query-failed");
            using (var server = new WindowsIdentity(token))
            using (var current = WindowsIdentity.GetCurrent()) {
                return server.User != null && server.User.Equals(current.User);
            }
        } finally {
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }

    static void Ready(Stream output, string value) {
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(value + "\n");
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
    }

    static async Task<bool> ReadExact(Stream input, byte[] bytes, int count) {
        int offset = 0;
        while (offset < count) {
            int read = await input.ReadAsync(bytes, offset, count - offset).ConfigureAwait(false);
            if (read == 0) {
                if (offset == 0) return false;
                throw new IOException("truncated-frame");
            }
            offset += read;
        }
        return true;
    }

    static async Task CopyFrames(Stream input, Stream output) {
        byte[] header = new byte[4];
        while (await ReadExact(input, header, 4).ConfigureAwait(false)) {
            uint size = (uint)(header[0] | header[1] << 8 | header[2] << 16 | header[3] << 24);
            if (size == 0 || size > 8 * 1024 * 1024) throw new IOException("invalid-frame");
            byte[] payload = new byte[(int)size];
            if (!await ReadExact(input, payload, payload.Length).ConfigureAwait(false)) throw new IOException("truncated-frame");
            await output.WriteAsync(header, 0, 4).ConfigureAwait(false);
            await output.WriteAsync(payload, 0, payload.Length).ConfigureAwait(false);
            await output.FlushAsync().ConfigureAwait(false);
        }
    }

    public static int Run(string name, int connectTimeoutMs, int lifetimeMs) {
        Stream stdout = Console.OpenStandardOutput();
        bool ready = false;
        using (var watchdog = new Timer(delegate { Environment.Exit(3); }, null, lifetimeMs, Timeout.Infinite))
        using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Identification, HandleInheritability.None)) {
            try {
                pipe.Connect(connectTimeoutMs);
                if (!IsSameUser(pipe)) { Ready(stdout, "{\"ready\":false,\"code\":\"owner-mismatch\"}"); return 2; }
                Ready(stdout, "{\"ready\":true}");
                ready = true;
                Task outbound = CopyFrames(Console.OpenStandardInput(), pipe);
                Task inbound = CopyFrames(pipe, stdout);
                Task first = Task.WhenAny(outbound, inbound).GetAwaiter().GetResult();
                first.GetAwaiter().GetResult();
                return 0;
            } catch (Exception error) {
                if (!ready) {
                    string code = error.Message == "owner-query-failed" ? "owner-query-failed" : "pipe-unavailable";
                    Ready(stdout, "{\"ready\":false,\"code\":\"" + code + "\"}");
                }
                return 2;
            }
        }
    }
}
'@
try {
    Add-Type -TypeDefinition $source -Language CSharp
    exit [CodexBridgeDesktopPipe]::Run($PipeName, $ConnectTimeoutMs, $LifetimeMs)
} catch {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"ready":false,"code":"helper-unavailable"}' + [char]10)
    [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
    exit 2
}
