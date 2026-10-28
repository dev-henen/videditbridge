using VideoEditor.Shared;

namespace VideoEditor.Session;

/// <summary>A problem validation found in the project document.</summary>
public sealed record IssueItem(string Level, string Path, string Message)
{
    public bool IsError => Level == "error";
}

public sealed record HistoryItem(string Time, string Action);

/// <summary>A problem review_edit found, with timeline times.</summary>
public sealed record FindingItem(string Severity, string Check, double Start, double End, string Message)
{
    public bool IsProblem => Severity == "problem";
    public string Glyph => IsProblem ? Icons.Error : Icons.Warning;
    /// <summary>Problems in the project document itself (from validation), rather than in how the video plays.</summary>
    public bool IsProjectCheck => Start < 0;
    public string TimeText => IsProjectCheck ? "Project check" : $"{(int)Start / 60:00}:{Start % 60:00.0} to {(int)End / 60:00}:{End % 60:00.0} | {Check}";
}
