using System.Collections.ObjectModel;
using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;
using VideoEditor.Chat;
using VideoEditor.Engine;
using VideoEditor.Preview;
using VideoEditor.Session;
using VideoEditor.Shared;
using VideoEditor.Timeline;

namespace VideoEditor.Shell;

/// <summary>
/// One open project (one tab): its state from the engine host, live activities, review, and the
/// conversations with Claude. Every engine call names the project, so tabs work side by side.
/// </summary>
public sealed class ProjectViewModel : Observable
{
    private readonly AppViewModel _app;
    private readonly EngineClient _engine;

    public string Dir { get; }

    public ObservableCollection<ActivityItem> Activities { get; } = [];
    public ObservableCollection<IssueItem> Issues { get; } = [];
    public ObservableCollection<HistoryItem> History { get; } = [];
    public ObservableCollection<FindingItem> Findings { get; } = [];
    public ObservableCollection<ChatMessage> Messages { get; } = [];
    public ObservableCollection<ConversationEntry> Conversations { get; } = [];

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

    /// <summary>Never raised: a tab keeps its project. Kept so the preview can listen the same way.</summary>
    public event Action? ProjectChanged;

    /// <summary>Raised when Claude offers new options to pick from.</summary>
    public event Action? ChoicesOffered;

    /// <summary>Raised when a reply streams in or a conversation is opened, so the chat can scroll.</summary>
    public event Action? ChatChanged;

    public ObservableCollection<ChoiceCard> Choices { get; } = [];
    private string _choiceQuestion = "";
    public string ChoiceQuestion { get => _choiceQuestion; private set => Set(ref _choiceQuestion, value); }
    public bool HasChoices => Choices.Count > 0;
    private string? _choiceId;

    public JsonNode? State { get; private set; }

    public ProjectViewModel(AppViewModel app, EngineClient engine, JsonNode state)
    {
        _app = app;
        _engine = engine;
        Dir = state["projectDir"]!.GetValue<string>();
        _model = app.DefaultModel;
        UseAvailableModel();
        ApplyState(state);
        ProjectChanged?.Invoke();
    }

    // ---------------------------------------------------------------- bindable state

    public bool IsProjectOpen => true;

    private string _projectName = "";
    public string ProjectName { get => _projectName; private set => Set(ref _projectName, value); }

    private string _metaText = "";
    public string MetaText { get => _metaText; private set => Set(ref _metaText, value); }

    private double _duration;
    public double Duration { get => _duration; private set => Set(ref _duration, value); }

    private string _statusText = "Ready";
    public string StatusText { get => _statusText; private set => Set(ref _statusText, value); }

    private bool _isBusy;
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

    private bool _agentRunning;
    public bool AgentRunning { get => _agentRunning; private set => Set(ref _agentRunning, value, nameof(AgentRunning), nameof(CanAsk)); }

    private string? _mcpClient;
    /// <summary>
    /// The AI app editing this project over MCP when it cannot show previews itself (Gemini CLI, say):
    /// the page then is its preview window, without the chat. Null otherwise.
    /// </summary>
    public string? McpClient { get => _mcpClient; private set => Set(ref _mcpClient, value, nameof(McpClient), nameof(IsMcpDriven), nameof(McpNote)); }
    public bool IsMcpDriven => McpClient is not null;
    public string McpNote => $"Edited from {McpClient}. Ask there; this window shows the edit.";

    /// <summary>Bring the chat back to a page an MCP app is editing.</summary>
    public Task UseChatHereAsync() => Guard(async () => await Call("mcp.release"));

    /// <summary>Whether the chosen model's provider has a key (Claude needs Anthropic's, ChatGPT OpenAI's, Gemini Google's).</summary>
    public bool ModelAvailable => _app.IsAvailable(Model.Provider);
    public bool CanAsk => ModelAvailable && !AgentRunning;
    /// <summary>Who the chat talks to: "Claude", "ChatGPT" or "Gemini", from the chosen model.</summary>
    public string Assistant => Model.Assistant;
    public string EmptyTitle => $"Edit by asking {Assistant}";
    public string AskHint => ModelAvailable
        ? $"Ask {Assistant} to edit, for example “cut this into a 30 second trailer”"
        : HasAnyKey ? "Pick a model to edit with" : "Add an API key in Settings to start editing";

    /// <summary>The models whose provider has a key: the only ones the chat offers.</summary>
    public IReadOnlyList<ModelOption> AvailableModels => Models.Where(m => _app.IsAvailable(m.Provider)).ToList();
    /// <summary>Whether any provider has a key; without one the chat is off and says where to add one.</summary>
    public bool HasAnyKey => Models.Any(m => _app.IsAvailable(m.Provider));
    public bool NoKey => !HasAnyKey;

    /// <summary>Go to Settings (to add an API key).</summary>
    public void OpenSettings() => _app.OpenSettings();

    /// <summary>A model without a key gives way to one with: the default model if it has one, else the first that does.</summary>
    private void UseAvailableModel()
    {
        if (ModelAvailable || !HasAnyKey) return;
        Model = _app.IsAvailable(_app.DefaultModel.Provider) ? _app.DefaultModel : AvailableModels[0];
    }

    // ---------------------------------------------------------------- conversations

    private string _conversationId = "";
    private string _conversationTitle = "New conversation";
    public string ConversationTitle { get => _conversationTitle; private set => Set(ref _conversationTitle, value); }
    public bool HasMessages => Messages.Count > 0;

    public IReadOnlyList<ModelOption> Models => _app.Models;
    private ModelOption _model;
    /// <summary>The model for the next request (kept per conversation by the host).</summary>
    public ModelOption Model
    {
        get => _model;
        set
        {
            // The picker lists only models with a key and sends null for one it does not list: keep the model.
            if (value is null) return;
            Set(ref _model, value, nameof(Model), nameof(ModelAvailable), nameof(CanAsk), nameof(AskHint), nameof(Assistant), nameof(EmptyTitle));
        }
    }

    /// <summary>A model to use: this one if its provider has a key, else the default or the first that has one.</summary>
    private ModelOption Usable(ModelOption m) =>
        _app.IsAvailable(m.Provider) || !HasAnyKey ? m : _app.IsAvailable(_app.DefaultModel.Provider) ? _app.DefaultModel : AvailableModels[0];

    /// <summary>Refresh the list of this project's conversations (newest first).</summary>
    public Task RefreshConversationsAsync() => Guard(async () =>
    {
        var r = await Call("chat.list");
        Conversations.Clear();
        foreach (var c in r?["conversations"]?.AsArray() ?? [])
        {
            if (c is null) continue;
            var updated = DateTime.TryParse(c["updatedAt"]?.GetValue<string>(), out var d) ? Ui.Ago(d.ToLocalTime()) : "";
            var id = c["id"]!.GetValue<string>();
            Conversations.Add(new ConversationEntry(id, c["title"]!.GetValue<string>(), updated, id == _conversationId));
        }
    });

    public Task NewConversationAsync() => Guard(async () => ShowConversation(await Call("chat.new", new { model = Model.Id })));
    public Task OpenConversationAsync(string id) => Guard(async () => ShowConversation(await Call("chat.open", new { id })));

    public Task RenameConversationAsync(string title) => Guard(async () =>
    {
        if (string.IsNullOrWhiteSpace(title)) return;
        await Call("chat.rename", new { id = _conversationId, title });
        ConversationTitle = title.Trim();
    });

    public Task DeleteConversationAsync(string id) => Guard(async () =>
    {
        ShowConversation(await Call("chat.delete", new { id }));
        await RefreshConversationsAsync();
    });

    private void ShowConversation(JsonNode? c)
    {
        if (c is null) return;
        _conversationId = c["id"]!.GetValue<string>();
        ConversationTitle = c["title"]!.GetValue<string>();
        // A conversation kept with a model whose key is gone carries on with one that has a key (set once,
        // so the picker never gets a model it does not list).
        if (Models.FirstOrDefault(m => m.Id == c["model"]?.GetValue<string>()) is { } model) Model = Usable(model);
        else UseAvailableModel();
        Messages.Clear();
        foreach (var line in c["transcript"]?.AsArray() ?? [])
            if (line is not null)
                Messages.Add(new ChatMessage(line["role"]!.GetValue<string>() == "user", line["text"]?.GetValue<string>() ?? "",
                    line["attachments"]?.AsArray().Select(a => Path.GetFileName(a!.GetValue<string>())).ToList() ?? []) { Error = line["error"]?.GetValue<string>() });
        Raise(nameof(HasMessages));
        ChatChanged?.Invoke();
    }

    /// <summary>The conversation the host continues for this project (the latest one when it opened).</summary>
    public Task LoadConversationAsync() => Guard(async () => ShowConversation(await Call("chat.current")));

    // ---------------------------------------------------------------- engine calls

    /// <summary>Call the host about this project. Once the project is closing, calls stop quietly (it is gone from the host).</summary>
    private Task<JsonNode?> Call(string method, object? parameters = null)
    {
        if (_closed && method is not ("project.close" or "agent.cancel")) return Task.FromException<JsonNode?>(new ProjectClosedException());
        var p = parameters is null ? new JsonObject() : (JsonSerializerHelper.ToNode(parameters) as JsonObject ?? new JsonObject());
        p["project"] = Dir;
        return _engine.CallAsync(method, p);
    }

    public Task ImportMediaAsync(IEnumerable<string> paths) => Guard(() => Call("project.importMedia", new { paths = paths.ToArray() }));
    public Task UndoAsync() => Guard(() => Call("session.undo"));
    public Task RedoAsync() => Guard(() => Call("session.redo"));
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
        var result = await Call("tools.execute", new { name, input });
        if (result?["isError"]?.GetValue<bool>() == true) throw new EngineException(result["text"]?.GetValue<string>() ?? "Failed");
        return result;
    }

    /// <summary>Quietly render the frame at a time (for the scrubber). Returns the image path, or null if superseded.</summary>
    /// <summary>A frame of live playback is in the shared frame file (with its timeline time).</summary>
    public event Action<ScrubFrame, double>? LiveFrame;

    /// <summary>Live playback reached the end or was stopped.</summary>
    public event Action? LiveEnded;

    /// <summary>
    /// Play the edit live on the render engine from a time. Returns whether it plays live (frames come
    /// through <see cref="LiveFrame"/>) and the sound to play from that time; not live when previews do
    /// not go to the engine, and a rendered preview video plays instead.
    /// </summary>
    public async Task<(bool Live, string? Audio)> PlayLiveAsync(double time)
    {
        try
        {
            var r = await Call("render.play", new { time });
            return (r?["live"]?.GetValue<bool>() == true, r?["audio"]?.GetValue<string>());
        }
        catch
        {
            return (false, null);
        }
    }

    public async Task StopLiveAsync()
    {
        try { await Call("render.stop", new { }); }
        catch { /* the host may be restarting */ }
    }

    /// <summary>
    /// The frame at a time: a picture file, or pixels in the project's shared frame file where the
    /// render engine draws previews. Null when the frame could not be made or a newer scrub took over.
    /// </summary>
    public async Task<ScrubFrame?> ScrubAsync(double time, bool before = false)
    {
        try
        {
            // before: the edit as it was when the latest request to Claude started (A/B).
            var r = await Call("render.scrub", new { time, before });
            if (r?["shared"]?.GetValue<string>() is { } shared)
                return new ScrubFrame(null, shared, r["width"]!.GetValue<int>(), r["height"]!.GetValue<int>());
            return r?["path"]?.GetValue<string>() is { } path ? new ScrubFrame(path, null, 0, 0) : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// The matte at a time for the viewer (a picture file, white on black): the first masked effect on
    /// the clip `target` (or the clip at that time), or with `objectOnly` the object last selected in
    /// that clip's video. Null with a reason when there is none, or when it could not be made.
    /// </summary>
    public async Task<MatteFrame?> MatteAsync(double time, string? target, bool objectOnly)
    {
        try
        {
            var r = await Call("render.matte", new { time, target, @object = objectOnly });
            return new MatteFrame(r?["path"]?.GetValue<string>(), r?["label"]?.GetValue<string>(), r?["reason"]?.GetValue<string>());
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Scopes (histogram, waveform, parade, vectorscope) of the frame at a time, a picture file; null when they could not be made.</summary>
    public async Task<string?> ScopesAsync(double time)
    {
        try { return (await Call("render.scopes", new { time }))?["path"]?.GetValue<string>(); }
        catch { return null; }
    }

    private bool _hasObjects;
    /// <summary>Claude selected objects (select_object): the viewer can outline the last one.</summary>
    public bool HasObjects { get => _hasObjects; private set => Set(ref _hasObjects, value); }

    /// <summary>
    /// Ask Claude to edit. With an item picked on the timeline, or a spot clicked in the frame, the
    /// request is about it: a note with its id, times or position leads the message, so "slow this
    /// down" and "put the title here" know what "this" and "here" are. Attached files are brought
    /// into the project first, and pictures among them are shown to Claude.
    /// </summary>
    public async Task AskClaudeAsync(string prompt, TimelineItem? about = null, Spot? spot = null, string? note = null, IReadOnlyList<string>? attachments = null)
    {
        if (string.IsNullOrWhiteSpace(prompt) || !CanAsk) return;
        AgentRunning = true;
        var files = attachments ?? [];
        Messages.Add(new ChatMessage(true, prompt.Trim(), files.Select(Path.GetFileName).OfType<string>().ToList(), AboutText(about, spot)));
        var reply = new ChatMessage(false, "") { IsStreaming = true };
        Messages.Add(reply);
        Raise(nameof(HasMessages));
        ChatChanged?.Invoke();
        var notes = new List<string>();
        if (note is not null) notes.Add(note);
        if (about is not null)
            notes.Add(string.Create(CultureInfo.InvariantCulture, $"[About the {about.Kind} {about.Id} picked in the timeline, {about.Start:0.0#}s to {about.End:0.0#}s: \"{about.Label}\"]"));
        if (spot is not null)
            notes.Add(string.Create(CultureInfo.InvariantCulture, $"[Spot picked in the frame: x {spot.X:0.###}, y {spot.Y:0.###} (frame fractions, 0,0 is the top left) at {spot.Time:0.0#}s on the timeline]"));
        var message = notes.Count == 0 ? prompt : $"{string.Join(" ", notes)} {prompt}";
        try
        {
            await Call("agent.run", new { prompt = message, display = prompt.Trim(), model = Model.Id, attachments = files.ToArray() });
        }
        catch (Exception e)
        {
            // The host words it already (engine/host/errors.ts): one sentence, shown in its own box.
            reply.Error = e.Message;
        }
        finally
        {
            reply.IsStreaming = false;
            AgentRunning = false;
            ChatChanged?.Invoke();
            await RefreshConversationsAsync();
        }
    }

    private static string? AboutText(TimelineItem? about, Spot? spot)
    {
        var parts = new List<string>();
        if (about is not null) parts.Add($"{about.Kind} \"{about.Label}\"");
        if (spot is not null) parts.Add($"spot at {Ui.Time(spot.Time)}");
        return parts.Count == 0 ? null : $"About {string.Join(" and ", parts)}";
    }

    public Task CancelClaudeAsync() => Guard(() => Call("agent.cancel"));

    /// <summary>Answer Claude's options: the pick goes back as the next message.</summary>
    public Task PickChoiceAsync(ChoiceCard card) =>
        AskClaudeAsync($"I pick \"{card.Label}\".", note: $"[Choice: {ChoiceQuestion}]");

    /// <summary>Close the options without picking.</summary>
    public Task DismissChoicesAsync() => Guard(() => Call("choices.dismiss"));

    private void ApplyChoices(JsonNode? c)
    {
        var id = c?["id"]?.GetValue<string>();
        if (id == _choiceId) return;
        _choiceId = id;
        Choices.Clear();
        ChoiceQuestion = c?["question"]?.GetValue<string>() ?? "";
        var i = 0;
        foreach (var o in c?["options"]?.AsArray() ?? [])
            if (o is not null)
                Choices.Add(new ChoiceCard(i++, o["label"]!.GetValue<string>(), o["description"]?.GetValue<string>(), o["audio"]?.GetValue<string>(), o["image"]?.GetValue<string>()));
        Raise(nameof(HasChoices));
        if (Choices.Count > 0) ChoicesOffered?.Invoke();
    }

    private async Task Guard(Func<Task> action)
    {
        try { await action(); }
        catch (Exception e) { ShowError(e.Message); }
    }

    /// <summary>Show an error, unless the project is closing: work it had under way may still end with one, and nobody is looking.</summary>
    public void ShowError(string message)
    {
        if (!_closed) _app.ShowError(message);
    }

    private bool _closed;

    /// <summary>What closing the project now would interrupt (the assistant answering, or running activities), or null when nothing would.</summary>
    public string? BusyReason => AgentRunning ? $"{Assistant} is still working on a request" : IsBusy ? StatusText.TrimEnd('.', '…', ' ') : null;

    /// <summary>Which providers have a key changed (a key was saved or removed in Settings).</summary>
    public void RefreshAvailability()
    {
        Raise(nameof(AvailableModels));
        Raise(nameof(HasAnyKey));
        Raise(nameof(NoKey));
        UseAvailableModel();
        Raise(nameof(ModelAvailable));
        Raise(nameof(CanAsk));
        Raise(nameof(AskHint));
    }

    // ---------------------------------------------------------------- notifications

    /// <summary>A notification about this project (the app routes them by project).</summary>
    public void OnNotification(string method, JsonNode? p)
    {
        switch (method)
        {
            case "state" when p is not null:
                ApplyState(p);
                break;
            case "activity" when p is not null:
                UpsertActivity(p);
                break;
            case "preview.frame" when (p?["shared"]?.GetValue<string>() is { } shared):
            {
                var frame = new ScrubFrame(null, shared, p["width"]!.GetValue<int>(), p["height"]!.GetValue<int>());
                double time = p["time"] is { } t ? t.GetValue<double>() : 0;
                LiveFrame?.Invoke(frame, time);
                break;
            }
            case "preview.ended":
                LiveEnded?.Invoke();
                break;
            case "agent.text":
                if (Messages.LastOrDefault() is { IsUser: false } last) last.Append(p?["delta"]?.GetValue<string>() ?? "");
                ChatChanged?.Invoke();
                break;
            case "agent.end":
                var reason = p?["stopReason"]?.GetValue<string>();
                if (Messages.LastOrDefault() is { IsUser: false } end)
                {
                    if (reason is "cancelled") end.Append("\n(stopped)");
                    else if (reason is "refusal") end.Append("\n(Claude declined this request)");
                }
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

    /// <summary>Running activities tick so their elapsed time moves (the app calls this on a timer).</summary>
    public void Tick()
    {
        foreach (var a in Activities) if (a.IsRunning) a.Tick();
    }

    /// <summary>The status line shows the newest running activity, or idle.</summary>
    private void UpdateStatus()
    {
        var running = Activities.Where(a => a.IsRunning).ToList();
        // Prefer a concrete step over the umbrella "Claude is thinking".
        var current = running.FirstOrDefault(a => a.Kind != "info") ?? running.FirstOrDefault();
        if (current is null)
        {
            var last = Activities.FirstOrDefault();
            IsBusy = false;
            StatusProgress = null;
            StatusText = last is null ? "Ready" : last.IsError ? $"Last step failed: {last.Detail ?? last.Label}" : $"Ready · last: {last.Label}";
            Raise(nameof(StatusIndeterminate));
            return;
        }
        IsBusy = true;
        StatusText = running.Count > 1 && current.Kind != "info" ? $"{current.Label}…  (+{running.Count - 1} more)" : $"{current.Label}…";
        StatusProgress = current.Progress;
        Raise(nameof(StatusIndeterminate));
    }

    private void ApplyState(JsonNode? s)
    {
        if (s is null) return;
        State = s;
        ProjectName = s["name"]?.GetValue<string>() ?? Path.GetFileName(Dir) ?? "";
        Duration = s["duration"]?.GetValue<double>() ?? 0;
        var st = s["settings"];
        MetaText = $"{st?["width"]}×{st?["height"]} · {st?["fps"]} fps · {Duration:0.0}s";
        CanUndo = s["canUndo"]?.GetValue<bool>() ?? false;
        CanRedo = s["canRedo"]?.GetValue<bool>() ?? false;
        Summary = s["summary"]?.GetValue<string>() ?? "";
        HasObjects = (s["objects"]?.AsArray().Count ?? 0) > 0;
        McpClient = s["mcpClient"]?.GetValue<string>();
        if (s["conversation"]?["title"]?.GetValue<string>() is { } title && s["conversation"]?["id"]?.GetValue<string>() == _conversationId) ConversationTitle = title;
        ApplyChoices(s["choices"]);
        if (_reviewedRevision is not null && s["revision"]?.ToString() != _reviewedRevision && !ReviewSummary.EndsWith("check again"))
            ReviewSummary += " | edited since, check again";

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

    /// <summary>
    /// Close the project in the host (it saves and leaves a cover). Claude's request, if one runs, is
    /// cancelled first. From here on the project is quiet: late answers and errors are dropped.
    /// </summary>
    public async Task CloseAsync()
    {
        var stopClaude = AgentRunning;
        _closed = true;
        try
        {
            if (stopClaude) await Call("agent.cancel");
            await Call("project.close");
        }
        catch
        {
            // Already gone from the host (closed elsewhere, or the host restarted): nothing to report.
        }
    }

    /// <summary>This tab came to the front: requests without a project (scripts, remote control) go here.</summary>
    public async Task FocusAsync()
    {
        try { await Call("project.focus"); }
        catch { /* the host may be restarting */ }
    }
}

/// <summary>A call for a project that is closing: dropped without a message.</summary>
public sealed class ProjectClosedException() : Exception("The project is closed");
