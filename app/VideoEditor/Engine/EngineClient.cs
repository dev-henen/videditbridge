using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json.Nodes;

namespace VideoEditor.Engine;

/// <summary>
/// Starts the Node engine host (src/host/main.ts) and talks JSON-RPC 2.0 to it over stdio,
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

    /// <summary>Find the engine (the repo containing package.json) and start the host process.</summary>
    public static EngineClient Start()
    {
        var root = FindEngineRoot() ?? throw new InvalidOperationException(
            "Could not find the editing engine. Set AVE_ENGINE_DIR to the ai-video-editor folder.");
        var projectsDir = Environment.GetEnvironmentVariable("AVE_PROJECTS_DIR") ?? Path.Combine(root, "projects");

        var built = Path.Combine(root, "dist", "host", "main.js");
        var args = File.Exists(built)
            ? $"\"{built}\""
            : $"\"{Path.Combine(root, "node_modules", "tsx", "dist", "cli.mjs")}\" \"{Path.Combine(root, "src", "host", "main.ts")}\"";

        var psi = new ProcessStartInfo("node", $"{args} --projects-dir \"{projectsDir}\"")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            StandardInputEncoding = new UTF8Encoding(false), // no BOM: the host parses line by line
        };
        var process = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start node. Is Node.js installed?");
        var client = new EngineClient(process, root, projectsDir);
        client.BeginReading();
        return client;
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
