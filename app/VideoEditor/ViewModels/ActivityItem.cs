using System.Text.Json.Nodes;

namespace VideoEditor.ViewModels;

/// <summary>One line in the activity feed ("Adding text…", "Rendering preview video… 45%").</summary>
public sealed class ActivityItem : Observable
{
    private string _label = "";
    private string _status = "running";
    private double? _progress;
    private string? _detail;
    private DateTime _startedAt;
    private DateTime? _endedAt;

    public string Id { get; }
    public string Kind { get; private set; } = "tool";

    public ActivityItem(string id) => Id = id;

    public string Label { get => _label; private set => Set(ref _label, value); }
    public string Status
    {
        get => _status;
        private set => Set(ref _status, value, nameof(Status), nameof(IsRunning), nameof(IsDone), nameof(IsError), nameof(ShowProgress), nameof(Indeterminate));
    }
    public double? Progress
    {
        get => _progress;
        private set => Set(ref _progress, value, nameof(Progress), nameof(ProgressPercent), nameof(ShowProgress), nameof(Indeterminate), nameof(TimeText));
    }
    public string? Detail { get => _detail; private set => Set(ref _detail, value, nameof(Detail), nameof(HasDetail)); }

    public bool IsRunning => Status == "running";
    public bool IsDone => Status == "done";
    public bool IsError => Status == "error";
    public bool HasDetail => !string.IsNullOrWhiteSpace(Detail) && Detail != Label;
    public bool ShowProgress => IsRunning;
    public bool Indeterminate => IsRunning && Progress is null;
    public double ProgressPercent => (Progress ?? 0) * 100;

    public string TimeText
    {
        get
        {
            var end = _endedAt ?? DateTime.Now;
            var secs = (end - _startedAt).TotalSeconds;
            var duration = secs < 1 ? $"{secs * 1000:0}ms" : secs < 60 ? $"{secs:0.0}s" : $"{(int)secs / 60}m {(int)secs % 60}s";
            if (IsRunning && Progress is { } p) return $"{p * 100:0}%";
            return IsRunning ? $"{duration}…" : duration;
        }
    }

    /// <summary>Running activities call this on a timer so their elapsed time ticks.</summary>
    public void Tick() => Raise(nameof(TimeText));

    public void Update(JsonNode a)
    {
        Kind = a["kind"]?.GetValue<string>() ?? Kind;
        Label = a["label"]?.GetValue<string>() ?? Label;
        Detail = a["detail"]?.GetValue<string>();
        _startedAt = DateTime.TryParse(a["startedAt"]?.GetValue<string>(), out var s) ? s.ToLocalTime() : DateTime.Now;
        _endedAt = DateTime.TryParse(a["endedAt"]?.GetValue<string>(), out var e) ? e.ToLocalTime() : null;
        Progress = a["progress"] is { } p ? p.GetValue<double>() : null;
        Status = a["status"]?.GetValue<string>() ?? Status;
        Raise(nameof(TimeText));
    }
}

public sealed record IssueItem(string Level, string Path, string Message)
{
    public bool IsError => Level == "error";
}

public sealed record HistoryItem(string Time, string Action);

public sealed record ProjectEntry(string Name, string Dir, string Updated);
