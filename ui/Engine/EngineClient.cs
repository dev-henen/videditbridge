using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json.Nodes;

namespace VideoEditor.Engine;

/// <summary>
/// Starts the Node engine host (engine/host/main.ts) and talks JSON-RPC 2.0 to it over stdio,
/// one JSON message per line. Notifications (state, activity, agent.text…) are raised as events
/// on a background thread; marshal to the UI thread before touching controls.
/// </summary>
public sealed class EngineClient : IDisposable
{
    private readonly Process _process;
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonNode?>> _pending = new();
    private readonly object _writeLock = new();
    private long _nextId;

    public event Action<string, JsonNode?>? Notification;
    public event Action<string>? Diagnostic;
    public event Action? Exited;

    public string EngineRoot { get; }
    public string ProjectsDir { get; }

    private EngineClient(Process process, string engineRoot, string projectsDir)
    {
        _process = process;
        EngineRoot = engineRoot;
        ProjectsDir = projectsDir;
    }

    /// <summary>How to start the host: the program, its arguments before --projects-dir, and its folder.</summary>
    private sealed record HostCommand(string FileName, List<string> Args, string WorkingDirectory, string DefaultProjectsDir);

    /// <summary>Find the engine and start the host process.</summary>
    public static EngineClient Start()
    {
        var host = BundledHost() ?? DevelopmentHost() ?? throw new InvalidOperationException(
            "Could not find the editing engine. Set AVE_ENGINE_DIR to the ai-video-editor folder.");
        var projectsDir = Environment.GetEnvironmentVariable("AVE_PROJECTS_DIR") ?? host.DefaultProjectsDir;

        var psi = new ProcessStartInfo(host.FileName)
        {
            WorkingDirectory = host.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            StandardInputEncoding = new UTF8Encoding(false), // no BOM: the host parses line by line
        };
        // ArgumentList quotes each argument correctly on every system.
        foreach (var a in host.Args) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add("--projects-dir");
        psi.ArgumentList.Add(projectsDir);
        var process = Process.Start(psi) ?? throw new InvalidOperationException($"Failed to start the editing engine ({host.FileName}).");
        var client = new EngineClient(process, host.WorkingDirectory, projectsDir);
        client.BeginReading();
        return client;
    }

    private static readonly string Exe = OperatingSystem.IsWindows() ? ".exe" : "";

    /// <summary>
    /// An installed app carries its engine: in Contents/Resources/engine inside a macOS app bundle,
    /// in an "engine" folder next to the executable elsewhere. It is either a single executable
    /// (ave-host) or a Node runtime with the built host (node + dist/host/main.js). Projects then go
    /// to the user's documents.
    /// </summary>
    private static HostCommand? BundledHost()
    {
        var baseDir = AppContext.BaseDirectory;
        var projects = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "AI Video Editor");
        foreach (var dir in new[] { Path.GetFullPath(Path.Combine(baseDir, "..", "Resources", "engine")), Path.Combine(baseDir, "engine") })
        {
            var single = Path.Combine(dir, $"ave-host{Exe}");
            if (File.Exists(single)) return new HostCommand(single, [], dir, projects);
            var node = Path.Combine(dir, $"node{Exe}");
            var main = Path.Combine(dir, "dist", "host", "main.js");
            if (File.Exists(node) && File.Exists(main)) return new HostCommand(node, [main], dir, projects);
        }
        return null;
    }

    /// <summary>Development: the repository (AVE_ENGINE_DIR, or a folder above the app), run with the Node on this machine.</summary>
    private static HostCommand? DevelopmentHost()
    {
        var root = FindEngineRoot();
        if (root is null) return null;
        var node = FindNode() ?? throw new InvalidOperationException("Node.js was not found. Install Node 20 or newer, or set AVE_NODE to the node executable.");
        var built = Path.Combine(root, "dist", "host", "main.js");
        List<string> args = File.Exists(built)
            ? [built]
            : [Path.Combine(root, "node_modules", "tsx", "dist", "cli.mjs"), Path.Combine(root, "engine", "host", "main.ts")];
        return new HostCommand(node, args, root, Path.Combine(root, "projects"));
    }

    private static string? FindEngineRoot()
    {
        var env = Environment.GetEnvironmentVariable("AVE_ENGINE_DIR");
        if (!string.IsNullOrEmpty(env) && File.Exists(Path.Combine(env, "package.json"))) return env;
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            var pkg = Path.Combine(dir.FullName, "package.json");
            if (File.Exists(pkg) && File.ReadAllText(pkg).Contains("\"ai-video-editor\"")) return dir.FullName;
        }
        return null;
    }

    /// <summary>
    /// The node executable: AVE_NODE, the PATH, then the usual install places. Apps opened from the
    /// macOS Finder or a Linux menu do not get the shell's PATH, so Homebrew and nvm installs are
    /// looked for directly.
    /// </summary>
    private static string? FindNode()
    {
        var env = Environment.GetEnvironmentVariable("AVE_NODE");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
        var candidates = (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Select(d => Path.Combine(d, $"node{Exe}"))
            .ToList();
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (OperatingSystem.IsWindows())
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
        else
        {
            candidates.AddRange(["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", Path.Combine(home, ".volta", "bin", "node")]);
            var nvm = Path.Combine(home, ".nvm", "versions", "node");
            if (Directory.Exists(nvm))
                candidates.AddRange(Directory.GetDirectories(nvm).OrderByDescending(d => Version.TryParse(Path.GetFileName(d).TrimStart('v'), out var v) ? v : new Version()).Select(d => Path.Combine(d, "bin", "node")));
        }
        return candidates.FirstOrDefault(File.Exists);
    }

    private void BeginReading()
    {
        _process.EnableRaisingEvents = true;
        _process.Exited += (_, _) =>
        {
            foreach (var p in _pending.Values) p.TrySetException(new IOException("The editing engine stopped."));
            Exited?.Invoke();
        };

        Task.Run(async () =>
        {
            var reader = _process.StandardOutput;
            while (await reader.ReadLineAsync() is { } line)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                JsonNode? msg;
                try { msg = JsonNode.Parse(line); }
                catch { Diagnostic?.Invoke(line); continue; }
                if (msg is null) continue;

                var id = msg["id"];
                if (id is not null && msg["method"] is null)
                {
                    if (_pending.TryRemove(id.GetValue<long>(), out var tcs))
                    {
                        if (msg["error"] is { } err) tcs.TrySetException(new EngineException(err["message"]?.GetValue<string>() ?? "Engine error"));
                        else tcs.TrySetResult(msg["result"]);
                    }
                }
                else if (msg["method"]?.GetValue<string>() is { } method)
                {
                    Notification?.Invoke(method, msg["params"]);
                }
            }
        });

        Task.Run(async () =>
        {
            while (await _process.StandardError.ReadLineAsync() is { } line) Diagnostic?.Invoke(line);
        });
    }

    /// <summary>Call a host method and await its result.</summary>
    public Task<JsonNode?> CallAsync(string method, object? parameters = null)
    {
        var id = Interlocked.Increment(ref _nextId);
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;
        var request = new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["method"] = method,
            ["params"] = parameters is null ? new JsonObject() : JsonSerializerHelper.ToNode(parameters),
        };
        lock (_writeLock)
        {
            _process.StandardInput.WriteLine(request.ToJsonString());
            _process.StandardInput.Flush();
        }
        return tcs.Task;
    }

    public void Dispose()
    {
        try
        {
            _process.StandardInput.Close();
            if (!_process.WaitForExit(1500)) _process.Kill(entireProcessTree: true);
        }
        catch { /* already gone */ }
        _process.Dispose();
    }
}

public sealed class EngineException(string message) : Exception(message);

internal static class JsonSerializerHelper
{
    public static JsonNode? ToNode(object value) =>
        value as JsonNode ?? JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(value, new System.Text.Json.JsonSerializerOptions
        {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
        }));
}
