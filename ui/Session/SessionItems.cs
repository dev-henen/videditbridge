using System.Globalization;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using VideoEditor.Shared;

namespace VideoEditor.Session;

/// <summary>A problem validation found in the project document.</summary>
public sealed record IssueItem(string Level, string Path, string Message)
{
    public bool IsError => Level == "error";
}

/// <summary>
/// One entry of the project's history (kept in the project folder, engine/host/journal.ts): an edit,
/// render or file step with its result, or an undo or redo.
/// </summary>
public sealed record HistoryItem(DateTime At, string Kind, string Text, string? Detail, bool IsError)
{
    public string Glyph => Kind switch
    {
        "undo" => Icons.Undo,
        "redo" => Icons.Redo,
        _ when IsError => Icons.Error,
        "render" => Icons.Video,
        "file" => Icons.Document,
        "info" => Icons.Info,
        _ => Icons.Check,
    };

    /// <summary>The time today, the day and time before.</summary>
    public string When => At.Date == DateTime.Today
        ? At.ToString("T", CultureInfo.CurrentCulture)
        : At.ToString("MMM d, ", CultureInfo.CurrentCulture) + At.ToString("t", CultureInfo.CurrentCulture);

    public bool HasDetail => !string.IsNullOrEmpty(Detail);
}

/// <summary>A media item in the project (Media tab): a video, picture, sound, color or gradient, and where the edit uses it.</summary>
public sealed class MediaItem(string id, string type, string name, string? path, string info, string usage, double? firstUse, IBrush? swatch) : Observable
{
    public string Id { get; } = id;
    public string Type { get; } = type;
    public string Name { get; } = name;
    /// <summary>The file, for its tooltip (null for colors and gradients).</summary>
    public string? Path { get; } = path;
    public string Tip => Path is null ? $"{Name} ({Id})" : $"{Id}: {Path}";
    /// <summary>Kind, length and size, e.g. "Video, 0:37, 464x832".</summary>
    public string Info { get; } = info;
    /// <summary>Where the edit uses it, e.g. "Used 3 times, first at 00:04.0", or "Not used".</summary>
    public string Usage { get; } = usage;
    public bool IsUnused => FirstUse is null;
    /// <summary>Where the edit first uses it (seconds), to go there when it is clicked.</summary>
    public double? FirstUse { get; } = firstUse;
    public IBrush? Swatch { get; } = swatch;
    public bool HasSwatch => Swatch is not null;

    public string Glyph => Type switch { "video" => Icons.Video, "image" => Icons.Image, "audio" => Icons.Music, _ => Icons.Sparkle };

    private Bitmap? _thumb;
    /// <summary>A frame of the video or the picture, once the engine has made it.</summary>
    public Bitmap? Thumb { get => _thumb; set => Set(ref _thumb, value, nameof(Thumb), nameof(HasThumb), nameof(ShowGlyph)); }
    public bool HasThumb => Thumb is not null;
    public bool ShowGlyph => !HasThumb && !HasSwatch;
}

/// <summary>A problem review_edit found, with timeline times.</summary>
public sealed record FindingItem(string Severity, string Check, double Start, double End, string Message)
{
    public bool IsProblem => Severity == "problem";
    public string Glyph => IsProblem ? Icons.Error : Icons.Warning;
    /// <summary>Problems in the project document itself (from validation), rather than in how the video plays.</summary>
    public bool IsProjectCheck => Start < 0;
    public string TimeText => IsProjectCheck ? "Project check" : $"{(int)Start / 60:00}:{Start % 60:00.0} to {(int)End / 60:00}:{End % 60:00.0} | {Check}";
}
