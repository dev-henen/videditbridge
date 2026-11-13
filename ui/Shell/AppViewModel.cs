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

/// <summary>A tab: an open project, the projects page (a new tab), or the app's settings.</summary>
public sealed class AppTab : Observable
{
    public AppTab(ProjectViewModel? project, bool settings = false)
    {
        Project = project;
        IsSettings = settings;
        if (project is not null)
            project.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(ProjectViewModel.ProjectName)) Raise(nameof(Label));
            };
    }

    public ProjectViewModel? Project { get; }
    public bool IsSettings { get; }
    public bool IsStart => Project is null && !IsSettings;
    public bool IsProject => Project is not null;
    /// <summary>What the tab says: the project's name, "Settings" or "New tab".</summary>
    public string Label => Project?.ProjectName ?? (IsSettings ? "Settings" : "New tab");

    private bool _isSelected;
    public bool IsSelected { get => _isSelected; set => Set(ref _isSelected, value); }
}

/// <summary>A project closed in this or an earlier session, to reopen from the side panel.</summary>
public sealed record ClosedProject(string Dir, string Name);

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

    private string _title = "VideditBridge";
    public string Title { get => _title; private set => Set(ref _title, value); }

    private void UpdateTitle() => Title = SelectedProject is { } p ? $"{p.ProjectName} | VideditBridge" : "VideditBridge";

    /// <summary>The AI providers (Anthropic for Claude first, the default; OpenAI; Google) and whether each has a key.</summary>
    public IReadOnlyList<ProviderOption> Providers { get; private set; } = [new("anthropic", "Anthropic", "Claude", "console.anthropic.com", "sk-ant-...", false)];
    /// <summary>Whether a provider has a key, so its models can edit.</summary>
    public bool IsAvailable(string provider) => Providers.Any(p => p.Id == provider && p.Available);
    public IReadOnlyList<ModelOption> Models { get; private set; } = [new("claude-opus-5-5", "Claude Opus 5.5", "Most capable, for full edits")];

    /// <summary>Read the providers' availability from host.info or settings.set; true when it changed.</summary>
    private bool ReadProviders(JsonNode? r)
    {
        var list = r?["providers"]?.AsArray()
            .Select(p => new ProviderOption(p!["id"]!.GetValue<string>(), p["label"]!.GetValue<string>(), p["assistant"]!.GetValue<string>(),
                p["keyUrl"]?.GetValue<string>() ?? "", p["keyHint"]?.GetValue<string>() ?? "", p["available"]?.GetValue<bool>() == true))
            .ToList();
        // An older host only says whether Claude can edit.
        if (list is not { Count: > 0 } && r?["claudeAvailable"]?.GetValue<bool>() is { } claude)
            list = [Providers[0] with { Available = claude }];
        if (list is not { Count: > 0 } || list.SequenceEqual(Providers)) return false;
        Providers = list;
        Raise(nameof(Providers));
        return true;
    }
    private string? _defaultModelId;
    /// <summary>The model new conversations start with (the settings' choice, else the first).</summary>
    public ModelOption DefaultModel => Models.FirstOrDefault(m => m.Id == _defaultModelId) ?? Models[0];

    /// <summary>Projects closed lately, newest first, to reopen from the side panel (kept with the open tabs).</summary>
    public ObservableCollection<ClosedProject> RecentlyClosed { get; } = [];
    private const int RecentlyClosedKept = 10;

    private void Remember(ProjectViewModel p)
    {
        foreach (var same in RecentlyClosed.Where(c => SamePath(c.Dir, p.Dir)).ToList()) RecentlyClosed.Remove(same);
        RecentlyClosed.Insert(0, new ClosedProject(p.Dir, p.ProjectName));
        while (RecentlyClosed.Count > RecentlyClosedKept) RecentlyClosed.RemoveAt(RecentlyClosed.Count - 1);
    }

    /// <summary>Reopen a closed project (in place of the projects page when that is the open tab).</summary>
    public async Task ReopenAsync(ClosedProject c)
    {
        await OpenProjectAsync(c.Dir, SelectedTab is { IsStart: true } ? SelectedTab : null);
        if (TabOf(c.Dir) is not null) RecentlyClosed.Remove(c);
        SaveTabs();
    }

    /// <summary>Go to the settings tab, opening it if needed.</summary>
    public void OpenSettings()
    {
        var tab = Tabs.FirstOrDefault(t => t.IsSettings);
        if (tab is null)
        {
            tab = new AppTab(null, settings: true);
            Tabs.Add(tab);
            TabOpened?.Invoke(tab);
        }
        SelectedTab = tab;
    }

    /// <summary>The app's settings from the host (the API key hidden), with its folders.</summary>
    public Task<JsonNode?> GetSettingsAsync() => Engine.CallAsync("settings.get");

    /// <summary>Call a host method the app view model has no wrapper for (Settings, Connections: connect.*).</summary>
    public Task<JsonNode?> CallHostAsync(string method, object? parameters = null) => Engine.CallAsync(method, parameters);

    /// <summary>Change settings; they apply at once (which providers can edit, and the default model, follow).</summary>
    public async Task<JsonNode?> SetSettingsAsync(object changes)
    {
        var r = await Engine.CallAsync("settings.set", changes);
        if (ReadProviders(r))
            foreach (var t in Tabs) t.Project?.RefreshAvailability();
        if (r?["defaultModel"]?.GetValue<string>() is { } model)
        {
            _defaultModelId = model;
            Raise(nameof(DefaultModel));
        }
        return r;
    }

    /// <summary>Run the performance test again (the renderer on "Automatic" follows it).</summary>
    public Task<JsonNode?> RunPerformanceTestAsync() => Engine.CallAsync("performance.run");

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

    /// <summary>Start (or take over an already started) engine host, then restore the tabs.</summary>
    public async Task StartAsync(string? openDir = null, EngineClient? engine = null)
    {
        try
        {
            _engine = engine ?? await Task.Run(EngineClient.Start);
            _engine.Notification += (method, p) => Dispatcher.UIThread.Post(() => OnNotification(method, p));
            _engine.Exited += () => Dispatcher.UIThread.Post(() => EngineError = "The editing engine stopped. Restart the app.");
            var info = await _engine.CallAsync("host.info");
            ReadProviders(info);
            var models = info?["models"]?.AsArray()
                .Select(m => new ModelOption(m!["id"]!.GetValue<string>(), m["label"]!.GetValue<string>(), m["description"]?.GetValue<string>() ?? "",
                    m["provider"]?.GetValue<string>() ?? "anthropic", m["assistant"]?.GetValue<string>() ?? "Claude"))
                .ToList();
            if (models is { Count: > 0 }) Models = models;
            _defaultModelId = info?["defaultModel"]?.GetValue<string>();
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

    /// <summary>Ask whether to close a project anyway (the message says what would stop); the window shows the question.</summary>
    public Func<string, Task<bool>>? ConfirmClose { get; set; }

    /// <summary>Close a tab; a project is saved, left with a cover and remembered under recently closed. The last tab becomes the projects page.</summary>
    public async Task CloseTabAsync(AppTab tab)
    {
        // Edits are saved as they happen; what closing would stop is work under way, so ask first.
        if (tab.Project is { BusyReason: { } busy } busyProject && ConfirmClose is { } confirm
            && !await confirm($"{busy} in \"{busyProject.ProjectName}\". Close it anyway? Edits so far are saved; the work under way stops."))
            return;
        if (!Tabs.Contains(tab)) return; // closed meanwhile
        if (tab.Project is { } p)
        {
            await p.CloseAsync();
            Remember(p);
        }
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
            var closed = RecentlyClosed.Select(c => new { dir = c.Dir, name = c.Name }).ToArray();
            File.WriteAllText(file, JsonSerializer.Serialize(new { open, selected = SelectedProject?.Dir, closed }));
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
                RecentlyClosed.Clear();
                foreach (var c in saved?["closed"]?.AsArray() ?? [])
                    if (c?["dir"]?.GetValue<string>() is { } d && File.Exists(Path.Combine(d, "project.json")))
                        RecentlyClosed.Add(new ClosedProject(d, c["name"]?.GetValue<string>() ?? Path.GetFileName(d)));
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
