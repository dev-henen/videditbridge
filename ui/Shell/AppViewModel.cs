using System.Collections.ObjectModel;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using VideoEditor.Chat;
using VideoEditor.Engine;
using VideoEditor.Projects;
using VideoEditor.Shared;

namespace VideoEditor.Shell;

/// <summary>A tab: an open project, or the projects page (a new tab).</summary>
public sealed class AppTab(ProjectViewModel? project) : Observable
{
    public ProjectViewModel? Project { get; } = project;
    public bool IsStart => Project is null;
    public bool IsProject => Project is not null;

    private bool _isSelected;
    public bool IsSelected { get => _isSelected; set => Set(ref _isSelected, value); }
}

/// <summary>
/// The app: the engine host, the tabs (each project runs on its own, side by side), the projects
/// list with covers, and what every tab shares (Claude's availability, the models).
/// </summary>
public sealed class AppViewModel : Observable, IDisposable
{
    private EngineClient? _engine;
    private readonly DispatcherTimer _ticker;

    public ObservableCollection<AppTab> Tabs { get; } = [];
    public ObservableCollection<ProjectEntry> Projects { get; } = [];

    public AppViewModel()
    {
        _ticker = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
        _ticker.Tick += (_, _) =>
        {
            foreach (var t in Tabs) t.Project?.Tick();
        };
        _ticker.Start();
    }

    private AppTab? _selectedTab;
    public AppTab? SelectedTab
    {
        get => _selectedTab;
        set
        {
            var old = _selectedTab;
            if (!Set(ref _selectedTab, value, nameof(SelectedTab), nameof(SelectedProject))) return;
            if (old is not null) old.IsSelected = false;
            if (value is not null) value.IsSelected = true;
            UpdateTitle();
            if (value?.Project is { } p) _ = p.FocusAsync();
            SaveTabs();
        }
    }

    /// <summary>The project of the current tab, or null on the projects page.</summary>
    public ProjectViewModel? SelectedProject => SelectedTab?.Project;

    private string _title = "AI Video Editor";
    public string Title { get => _title; private set => Set(ref _title, value); }

    private void UpdateTitle() => Title = SelectedProject is { } p ? $"{p.ProjectName} | AI Video Editor" : "AI Video Editor";

    public bool ClaudeAvailable { get; private set; }
    public IReadOnlyList<ModelOption> Models { get; private set; } = [new("claude-opus-5-5", "Opus 5.5", "Most capable, for full edits")];
    public ModelOption DefaultModel => Models[0];

    private string? _engineError;
    public string? EngineError { get => _engineError; private set => Set(ref _engineError, value, nameof(EngineError), nameof(HasEngineError)); }
    public bool HasEngineError => EngineError is not null;

    private bool _isStarting = true;
    public bool IsStarting { get => _isStarting; private set => Set(ref _isStarting, value); }

    public string NewProjectName { get; set; } = "My video";
    public string NewProjectAspect { get; set; } = "16:9";
    public IReadOnlyList<string> AspectRatios { get; } = ["16:9", "9:16", "1:1", "4:5", "21:9"];

    /// <summary>Raised when an action fails; the window shows the message.</summary>
    public event Action<string>? ErrorRaised;
    public void ShowError(string message) => ErrorRaised?.Invoke(message);

    /// <summary>Raised when a tab was added, so the window can build its view.</summary>
    public event Action<AppTab>? TabOpened;

    /// <summary>Raised when a tab was closed, so the window can drop its view.</summary>
    public event Action<AppTab>? TabClosed;

    // ---------------------------------------------------------------- engine lifecycle

    public async Task StartAsync(string? openDir = null)
    {
        try
        {
            _engine = await Task.Run(EngineClient.Start);
            _engine.Notification += (method, p) => Dispatcher.UIThread.Post(() => OnNotification(method, p));
            _engine.Exited += () => Dispatcher.UIThread.Post(() => EngineError = "The editing engine stopped. Restart the app.");
            var info = await _engine.CallAsync("host.info");
            ClaudeAvailable = info?["claudeAvailable"]?.GetValue<bool>() ?? false;
            var models = info?["models"]?.AsArray()
                .Select(m => new ModelOption(m!["id"]!.GetValue<string>(), m["label"]!.GetValue<string>(), m["description"]?.GetValue<string>() ?? ""))
                .ToList();
            if (models is { Count: > 0 }) Models = models;
            Raise(nameof(ClaudeAvailable));
            Raise(nameof(Models));
            await RefreshProjectsAsync();
            await RestoreTabsAsync(openDir);
        }
        catch (Exception e)
        {
            EngineError = $"Could not start the editing engine: {e.Message}";
            if (Tabs.Count == 0) NewTab();
        }
        finally
        {
            IsStarting = false;
        }
    }

    private EngineClient Engine => _engine ?? throw new InvalidOperationException("The editing engine is not running");

    public async Task RefreshProjectsAsync()
    {
        if (_engine is null) return;
        var list = await _engine.CallAsync("project.list");
        Projects.Clear();
        foreach (var p in list?.AsArray() ?? [])
        {
            if (p is null) continue;
            var updated = DateTime.TryParse(p["updatedAt"]?.GetValue<string>(), out var d) ? Ui.Ago(d.ToLocalTime()) : "";
            Projects.Add(new ProjectEntry(p["name"]!.GetValue<string>(), p["dir"]!.GetValue<string>(), updated, p["cover"]?.GetValue<string>()));
        }
    }

    // ---------------------------------------------------------------- tabs

    private static readonly StringComparison PathCase = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    private static bool SamePath(string a, string b) => string.Equals(Path.GetFullPath(a).TrimEnd('\\', '/'), Path.GetFullPath(b).TrimEnd('\\', '/'), PathCase);

    private AppTab? TabOf(string dir) => Tabs.FirstOrDefault(t => t.Project is { } p && SamePath(p.Dir, dir));

    /// <summary>A new tab on the projects page.</summary>
    public AppTab NewTab()
    {
        var tab = new AppTab(null);
        Tabs.Add(tab);
        TabOpened?.Invoke(tab);
        SelectedTab = tab;
        _ = Guard(RefreshProjectsAsync);
        return tab;
    }

    /// <summary>Open a project in a tab (or go to its tab). From the projects page, it takes that tab's place.</summary>
    public Task OpenProjectAsync(string dir, AppTab? from = null) => Guard(async () =>
    {
        if (TabOf(dir) is { } existing)
        {
            SelectedTab = existing;
            if (from is { IsStart: true } && from != existing) Remove(from);
            return;
        }
        AddProjectTab(await Engine.CallAsync("project.open", new { path = dir }), from);
    });

    public Task CreateProjectAsync(AppTab? from = null) => Guard(async () =>
        AddProjectTab(await Engine.CallAsync("project.create", new { name = NewProjectName, aspectRatio = NewProjectAspect }), from));

    private void AddProjectTab(JsonNode? state, AppTab? from)
    {
        if (state is null) return;
        var project = new ProjectViewModel(this, Engine, state);
        project.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(ProjectViewModel.ProjectName) && SelectedProject == project) UpdateTitle();
        };
        var tab = new AppTab(project);
        var at = from is { IsStart: true } && Tabs.IndexOf(from) is var i and >= 0 ? i : Tabs.Count;
        Tabs.Insert(at, tab);
        TabOpened?.Invoke(tab);
        if (from is { IsStart: true }) Remove(from);
        SelectedTab = tab;
        _ = project.LoadConversationAsync();
    }

    /// <summary>Close a tab; a project is saved and left with a cover. The last tab becomes the projects page.</summary>
    public async Task CloseTabAsync(AppTab tab)
    {
        if (tab.Project is { } p) await p.CloseAsync();
        Remove(tab);
        if (Tabs.Count == 0) NewTab();
        _ = Guard(RefreshProjectsAsync);
    }

    private void Remove(AppTab tab)
    {
        var index = Tabs.IndexOf(tab);
        if (index < 0) return;
        Tabs.RemoveAt(index);
        TabClosed?.Invoke(tab);
        if (SelectedTab == tab) SelectedTab = Tabs.Count == 0 ? null : Tabs[Math.Min(index, Tabs.Count - 1)];
        else SaveTabs();
    }

    // Open tabs come back when the app starts again (kept in the projects folder, next to the projects).
    private string? TabsFile => _engine is null ? null : Path.Combine(_engine.ProjectsDir, ".tabs.json");

    private void SaveTabs()
    {
        if (TabsFile is not { } file || IsStarting) return;
        try
        {
            var open = Tabs.Where(t => t.Project is not null).Select(t => t.Project!.Dir).ToArray();
            File.WriteAllText(file, JsonSerializer.Serialize(new { open, selected = SelectedProject?.Dir }));
        }
        catch { /* only a convenience */ }
    }

    private async Task RestoreTabsAsync(string? openDir)
    {
        var dirs = new List<string>();
        string? selected = null;
        try
        {
            if (TabsFile is { } file && File.Exists(file))
            {
                var saved = JsonNode.Parse(await File.ReadAllTextAsync(file));
                dirs.AddRange(saved?["open"]?.AsArray().Select(d => d!.GetValue<string>()).Where(d => File.Exists(Path.Combine(d, "project.json"))) ?? []);
                selected = saved?["selected"]?.GetValue<string>();
            }
        }
        catch { /* a damaged file just means no tabs to restore */ }
        if (openDir is not null && !dirs.Any(d => SamePath(d, openDir))) dirs.Add(openDir);
        foreach (var dir in dirs)
        {
            try { AddProjectTab(await Engine.CallAsync("project.open", new { path = dir }), null); }
            catch (Exception e) { ShowError($"Could not reopen {Path.GetFileName(dir)}: {e.Message}"); }
        }
        if (Tabs.Count == 0) NewTab();
        var focus = openDir ?? selected;
        if (focus is not null && TabOf(focus) is { } tab) SelectedTab = tab;
    }

    // ---------------------------------------------------------------- notifications

    private void OnNotification(string method, JsonNode? p)
    {
        switch (method)
        {
            case "project.cover":
                _ = Guard(RefreshProjectsAsync);
                return;
            // Remote control (a script, Claude Code) opened or closed a project: show it here too.
            case "project.opened" when (p?["projectDir"]?.GetValue<string>() is { } opened):
                if (TabOf(opened) is { } tab) SelectedTab = tab;
                else AddProjectTab(p, SelectedTab is { IsStart: true } ? SelectedTab : null);
                return;
            case "project.closed" when (p?["project"]?.GetValue<string>() is { } closed && TabOf(closed) is { } gone):
                Remove(gone);
                if (Tabs.Count == 0) NewTab();
                return;
        }
        if (p?["project"]?.GetValue<string>() is { } dir && TabOf(dir)?.Project is { } project) project.OnNotification(method, p);
    }

    private async Task Guard(Func<Task> action)
    {
        try { await action(); }
        catch (Exception e) { ShowError(e.Message); }
    }

    public void Dispose()
    {
        _ticker.Stop();
        _engine?.Dispose();
    }
}
