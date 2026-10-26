using System.Collections.ObjectModel;
using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Threading;
using VideoEditor.Engine;

namespace VideoEditor.ViewModels;

/// <summary>App state driven by the engine host: the open project, live activities and Claude.</summary>
public sealed class MainViewModel : Observable, IDisposable
{
    private EngineClient? _engine;
    private readonly Dispatcher _ui = Application.Current.Dispatcher;
    private readonly DispatcherTimer _ticker;

    public ObservableCollection<ActivityItem> Activities { get; } = [];
    public ObservableCollection<IssueItem> Issues { get; } = [];
    public ObservableCollection<HistoryItem> History { get; } = [];
    public ObservableCollection<ProjectEntry> Projects { get; } = [];
    public ObservableCollection<FindingItem> Findings { get; } = [];

    private string _reviewSummary = "Check the edit for what a viewer would notice";
    public string ReviewSummary { get => _reviewSummary; private set => Set(ref _reviewSummary, value); }
    private string? _reviewedRevision;
    private readonly List<FindingItem> _reviewFindings = [];

    /// <summary>The Review list: problems in the project document (always current), then what the last review found.</summary>
    private void RebuildFindings()
    {
        Findings.Clear();
        foreach (var i in Issues)
            Findings.Add(new FindingItem(i.Level == "error" ? "problem" : "warning", "project", -1, -1, $"{i.Path}: {i.Message}"));
        foreach (var f in _reviewFindings) Findings.Add(f);
    }

    /// <summary>Raised on the UI thread whenever a new state snapshot arrives.</summary>
    public event Action<JsonNode>? StateUpdated;

    /// <summary>Raised when a different project becomes active (also when switched remotely).</summary>
    public event Action? ProjectChanged;

    public JsonNode? State { get; private set; }

    public MainViewModel()
    {
        _ticker = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
        _ticker.Tick += (_, _) =>
        {
            foreach (var a in Activities) if (a.IsRunning) a.Tick();
        };
        _ticker.Start();
    }

    // ---------------------------------------------------------------- bindable state

    private bool _isProjectOpen;
    public bool IsProjectOpen { get => _isProjectOpen; private set => Set(ref _isProjectOpen, value, nameof(IsProjectOpen), nameof(ShowStartScreen)); }
    private bool _showProjects;
    public bool ShowStartScreen => !IsProjectOpen || _showProjects;

    public async Task ShowProjectsAsync()
    {
        await Guard(RefreshProjectsAsync);
        _showProjects = true;
        Raise(nameof(ShowStartScreen));
    }

    public void HideProjects()
    {
        _showProjects = false;
        Raise(nameof(ShowStartScreen));
    }

    private string _title = "AI Video Editor";
    public string Title { get => _title; private set => Set(ref _title, value); }

    private string _projectName = "";
    public string ProjectName { get => _projectName; private set => Set(ref _projectName, value); }

    private string _metaText = "";
    public string MetaText { get => _metaText; private set => Set(ref _metaText, value); }

    private double _duration;
    public double Duration { get => _duration; private set => Set(ref _duration, value); }

    private string _statusText = "Starting the editing engine…";
    public string StatusText { get => _statusText; private set => Set(ref _statusText, value); }

    private bool _isBusy = true;
    public bool IsBusy { get => _isBusy; private set => Set(ref _isBusy, value); }

    private double? _statusProgress;
    public double? StatusProgress
    {
        get => _statusProgress;
        private set => Set(ref _statusProgress, value, nameof(StatusProgress), nameof(StatusPercent), nameof(StatusIndeterminate));
    }
    public double StatusPercent => (StatusProgress ?? 0) * 100;
    public bool StatusIndeterminate => IsBusy && StatusProgress is null;

    private bool _canUndo, _canRedo;
    public bool CanUndo { get => _canUndo; private set => Set(ref _canUndo, value); }
    public bool CanRedo { get => _canRedo; private set => Set(ref _canRedo, value); }

    private string _summary = "";
    public string Summary { get => _summary; private set => Set(ref _summary, value); }

    private string _agentText = "";
    public string AgentText { get => _agentText; private set => Set(ref _agentText, value); }

    private bool _agentRunning;
    public bool AgentRunning { get => _agentRunning; private set => Set(ref _agentRunning, value, nameof(AgentRunning), nameof(CanAsk)); }

    private bool _claudeAvailable;
    public bool ClaudeAvailable { get => _claudeAvailable; private set => Set(ref _claudeAvailable, value, nameof(ClaudeAvailable), nameof(CanAsk), nameof(AskHint)); }
    public bool CanAsk => ClaudeAvailable && IsProjectOpen && !AgentRunning;
    public string AskHint => ClaudeAvailable
        ? "Ask Claude to edit, for example “make a 30 second cinematic trailer from my clips”"
        : "Set ANTHROPIC_API_KEY and restart to let Claude edit";

    private string? _engineError;
    public string? EngineError { get => _engineError; private set => Set(ref _engineError, value, nameof(EngineError), nameof(HasEngineError)); }
    public bool HasEngineError => EngineError is not null;

    public string NewProjectName { get; set; } = "My video";
    public string NewProjectAspect { get; set; } = "16:9";
    public IReadOnlyList<string> AspectRatios { get; } = ["16:9", "9:16", "1:1", "4:5", "21:9"];

    public string? ProjectDir { get; private set; }

    // ---------------------------------------------------------------- engine lifecycle

    public async Task StartAsync()
    {
        try
        {
            _engine = await Task.Run(EngineClient.Start);
            _engine.Notification += (method, p) => _ui.InvokeAsync(() => OnNotification(method, p));
            _engine.Exited += () => _ui.InvokeAsync(() =>
            {
                EngineError = "The editing engine stopped. Restart the app.";
                SetIdle("Engine stopped");
            });
            var info = await _engine.CallAsync("host.info");
            ClaudeAvailable = info?["claudeAvailable"]?.GetValue<bool>() ?? false;
            await RefreshProjectsAsync();
            SetIdle(Projects.Count > 0 ? "Open a project or create a new one" : "Create your first project");
        }
        catch (Exception e)
        {
            EngineError = $"Could not start the editing engine: {e.Message}";
            SetIdle("Engine unavailable");
        }
    }

    private EngineClient Engine => _engine ?? throw new InvalidOperationException("Engine not started");

    public async Task RefreshProjectsAsync()
    {
        var list = await Engine.CallAsync("project.list");
        Projects.Clear();
        foreach (var p in list?.AsArray() ?? [])
        {
            if (p is null) continue;
            var updated = DateTime.TryParse(p["updatedAt"]?.GetValue<string>(), out var d) ? d.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) : "";
            Projects.Add(new ProjectEntry(p["name"]!.GetValue<string>(), p["dir"]!.GetValue<string>(), updated));
        }
    }

    public async Task OpenProjectAsync(string path) => await Guard(async () =>
    {
        Activities.Clear();
        AgentText = "";
        ApplyState(await Engine.CallAsync("project.open", new { path }));
        HideProjects();
    });

    public async Task CreateProjectAsync() => await Guard(async () =>
    {
        Activities.Clear();
        AgentText = "";
        ApplyState(await Engine.CallAsync("project.create", new { name = NewProjectName, aspectRatio = NewProjectAspect }));
        HideProjects();
    });

    public Task ImportMediaAsync(IEnumerable<string> paths) => Guard(() => Engine.CallAsync("project.importMedia", new { paths = paths.ToArray() }));
    public Task UndoAsync() => Guard(() => Engine.CallAsync("session.undo"));
    public Task RedoAsync() => Guard(() => Engine.CallAsync("session.redo"));
    public Task RenderPreviewAsync() => Guard(() => Execute("render_preview", new { scale = 0.5 }));
    public Task RenderOverviewAsync() => Guard(() => Execute("render_contact_sheet", new { columns = 4, rows = 3 }));
    public Task ExportAsync(string output) => Guard(() => Execute("render_video", new { output }));

    /// <summary>Run the automatic review and list what it found.</summary>
    public Task ReviewAsync() => Guard(async () =>
    {
        ReviewSummary = "Checking the edit…";
        var r = await Execute("review_edit", new { });
        _reviewFindings.Clear();
        foreach (var i in r?["data"]?["issues"]?.AsArray() ?? [])
            if (i is not null)
                _reviewFindings.Add(new FindingItem(i["severity"]!.GetValue<string>(), i["check"]!.GetValue<string>(), i["start"]!.GetValue<double>(), i["end"]!.GetValue<double>(), i["message"]!.GetValue<string>()));
        _reviewedRevision = State?["revision"]?.ToString();
        RebuildFindings();
        var problems = _reviewFindings.Count(f => f.IsProblem);
        var warnings = _reviewFindings.Count - problems;
        var loud = r?["data"]?["loudness"]?["integrated"]?.GetValue<double>();
        ReviewSummary = (_reviewFindings.Count == 0 ? "No problems found" : $"{problems} problem{(problems == 1 ? "" : "s")}, {warnings} warning{(warnings == 1 ? "" : "s")}")
            + (loud is null ? "" : string.Create(CultureInfo.CurrentCulture, $" | loudness {loud:0.0} LUFS"));
    });

    /// <summary>Ask Claude to fix one finding.</summary>
    public Task FixAsync(FindingItem f) => f.IsProjectCheck
        ? AskClaudeAsync($"Fix this problem in the project: {f.Message}")
        : AskClaudeAsync(string.Create(CultureInfo.InvariantCulture, $"Fix this problem the review found ({f.Check}, {f.Start:0.0#}s to {f.End:0.0#}s): {f.Message} Then check that part again."));

    private async Task<JsonNode?> Execute(string name, object input)
    {
        var result = await Engine.CallAsync("tools.execute", new { name, input });
        if (result?["isError"]?.GetValue<bool>() == true) throw new EngineException(result["text"]?.GetValue<string>() ?? "Failed");
        return result;
    }

    /// <summary>Quietly render the frame at a time (for the scrubber). Returns the image path, or null if superseded.</summary>
    public async Task<string?> ScrubAsync(double time)
    {
        if (_engine is null || !IsProjectOpen) return null;
        try
        {
            var r = await _engine.CallAsync("render.scrub", new { time });
            return r?["path"]?.GetValue<string>();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Ask Claude to edit. With an item picked on the timeline, or a spot clicked in the frame, the
    /// request is about it: a note with its id, times or position leads the message, so "slow this
    /// down" and "put the title here" know what "this" and "here" are.
    /// </summary>
    public async Task AskClaudeAsync(string prompt, Controls.TimelineItem? about = null, Spot? spot = null)
    {
        if (string.IsNullOrWhiteSpace(prompt) || !CanAsk) return;
        AgentRunning = true;
        var aboutParts = new List<string>();
        if (about is not null) aboutParts.Add($"{about.Kind} \"{about.Label}\"");
        if (spot is not null) aboutParts.Add("a spot in the frame");
        var aboutText = aboutParts.Count == 0 ? "" : $" (about {string.Join(" and ", aboutParts)})";
        AgentText += (AgentText.Length > 0 ? "\n\n" : "") + $"You{aboutText}: {prompt.Trim()}\n\nClaude: ";
        var notes = new List<string>();
        if (about is not null)
            notes.Add(string.Create(CultureInfo.InvariantCulture, $"[About the {about.Kind} {about.Id} picked in the timeline, {about.Start:0.0#}s to {about.End:0.0#}s: \"{about.Label}\"]"));
        if (spot is not null)
            notes.Add(string.Create(CultureInfo.InvariantCulture, $"[Spot picked in the frame: x {spot.X:0.###}, y {spot.Y:0.###} (frame fractions, 0,0 is the top left) at {spot.Time:0.0#}s on the timeline]"));
        var message = notes.Count == 0 ? prompt : $"{string.Join(" ", notes)} {prompt}";
        try
        {
            await Engine.CallAsync("agent.run", new { prompt = message });
        }
        catch (Exception e)
        {
            AgentText += $"\nError: {e.Message}";
        }
        finally
        {
            AgentRunning = false;
        }
    }

    public Task CancelClaudeAsync() => Guard(() => Engine.CallAsync("agent.cancel"));

    private async Task Guard(Func<Task> action)
    {
        try { await action(); }
        catch (Exception e) { ShowError(e.Message); }
    }

    public void ShowError(string message) => MessageBox.Show(message, "AI Video Editor", MessageBoxButton.OK, MessageBoxImage.Warning);

    // ---------------------------------------------------------------- notifications

    private void OnNotification(string method, JsonNode? p)
    {
        switch (method)
        {
            case "state" when p is not null:
                ApplyState(p);
                break;
            case "activity" when p is not null:
                UpsertActivity(p);
                break;
            case "agent.text":
                AgentText += p?["delta"]?.GetValue<string>() ?? "";
                break;
            case "agent.end":
                var reason = p?["stopReason"]?.GetValue<string>();
                if (reason is "cancelled") AgentText += "\n(stopped)";
                else if (reason is "refusal") AgentText += "\n(Claude declined this request)";
                break;
        }
    }

    private void UpsertActivity(JsonNode a)
    {
        var id = a["id"]!.GetValue<string>();
        var item = Activities.FirstOrDefault(x => x.Id == id);
        if (item is null)
        {
            item = new ActivityItem(id);
            Activities.Insert(0, item);
            while (Activities.Count > 150) Activities.RemoveAt(Activities.Count - 1);
        }
        item.Update(a);
        UpdateStatus();
    }

    /// <summary>The status bar shows the newest running activity, or idle.</summary>
    private void UpdateStatus()
    {
        var running = Activities.Where(a => a.IsRunning).ToList();
        // Prefer a concrete step over the umbrella "Claude is thinking".
        var current = running.FirstOrDefault(a => a.Kind != "info") ?? running.FirstOrDefault();
        if (current is null)
        {
            var last = Activities.FirstOrDefault();
            SetIdle(last is null ? "Ready" : last.IsError ? $"Last step failed: {last.Detail ?? last.Label}" : $"Ready · last: {last.Label}");
            return;
        }
        IsBusy = true;
        StatusText = running.Count > 1 && current.Kind != "info" ? $"{current.Label}…  (+{running.Count - 1} more)" : $"{current.Label}…";
        StatusProgress = current.Progress;
        Raise(nameof(StatusIndeterminate));
        Title = $"{current.Label}… | {ProjectName}";
    }

    private void SetIdle(string text)
    {
        IsBusy = false;
        StatusProgress = null;
        StatusText = text;
        Raise(nameof(StatusIndeterminate));
        Title = IsProjectOpen ? $"{ProjectName} | AI Video Editor" : "AI Video Editor";
    }

    private void ApplyState(JsonNode? s)
    {
        if (s is null) return;
        State = s;
        IsProjectOpen = true;
        var dir = s["projectDir"]?.GetValue<string>();
        if (dir != ProjectDir)
        {
            if (ProjectDir is not null)
            {
                Activities.Clear();
                AgentText = "";
            }
            ProjectDir = dir;
            HideProjects();
            ProjectChanged?.Invoke();
        }
        ProjectName = s["name"]?.GetValue<string>() ?? Path.GetFileName(ProjectDir) ?? "";
        Duration = s["duration"]?.GetValue<double>() ?? 0;
        var st = s["settings"];
        MetaText = $"{st?["width"]}×{st?["height"]} · {st?["fps"]} fps · {Duration:0.0}s";
        CanUndo = s["canUndo"]?.GetValue<bool>() ?? false;
        CanRedo = s["canRedo"]?.GetValue<bool>() ?? false;
        Summary = s["summary"]?.GetValue<string>() ?? "";
        if (_reviewedRevision is not null && s["revision"]?.ToString() != _reviewedRevision && !ReviewSummary.EndsWith("check again"))
            ReviewSummary += " | edited since, check again";
        Raise(nameof(CanAsk));

        Issues.Clear();
        foreach (var i in s["issues"]?.AsArray() ?? [])
            if (i is not null) Issues.Add(new IssueItem(i["level"]!.GetValue<string>(), i["path"]!.GetValue<string>(), i["message"]!.GetValue<string>()));
        RebuildFindings();

        History.Clear();
        foreach (var h in s["history"]?.AsArray() ?? [])
        {
            if (h is null) continue;
            var time = DateTime.TryParse(h["at"]?.GetValue<string>(), out var d) ? d.ToLocalTime().ToString("T", CultureInfo.CurrentCulture) : "";
            History.Add(new HistoryItem(time, h["action"]!.GetValue<string>()));
        }

        // Activities in the snapshot fill gaps (e.g. after opening a project).
        foreach (var a in (s["activities"]?.AsArray() ?? []).Reverse())
            if (a is not null && Activities.All(x => x.Id != a["id"]!.GetValue<string>())) UpsertActivity(a);

        UpdateStatus();
        StateUpdated?.Invoke(s);
    }

    public void Dispose()
    {
        _ticker.Stop();
        _engine?.Dispose();
    }
}
