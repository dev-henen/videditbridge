using VideoEditor.Shared;

namespace VideoEditor.Chat;

/// <summary>One message in the chat: a request (with its attached files) or Claude's reply, which streams in.</summary>
public sealed class ChatMessage(bool isUser, string text, IReadOnlyList<string>? attachments = null, string? about = null) : Observable
{
    private string _text = text;
    private bool _isStreaming;

    public bool IsUser { get; } = isUser;
    public bool IsAssistant => !IsUser;
    public IReadOnlyList<string> Attachments { get; } = attachments ?? [];
    public bool HasAttachments => Attachments.Count > 0;
    /// <summary>What the request was about (a picked clip, a spot in the frame).</summary>
    public string? About { get; } = about;
    public bool HasAbout => About is not null;

    public string Text { get => _text; private set => Set(ref _text, value, nameof(Text), nameof(HasText), nameof(IsThinking)); }
    public bool HasText => Text.Length > 0;

    /// <summary>The reply is still coming.</summary>
    public bool IsStreaming { get => _isStreaming; set => Set(ref _isStreaming, value, nameof(IsStreaming), nameof(IsThinking)); }
    /// <summary>Claude is working but has not written anything yet.</summary>
    public bool IsThinking => IsStreaming && !HasText;

    public void Append(string delta) => Text += delta;
}

/// <summary>A saved conversation in the history list.</summary>
public sealed record ConversationEntry(string Id, string Title, string Updated, bool IsCurrent);

/// <summary>A Claude model the chat can use.</summary>
public sealed record ModelOption(string Id, string Label, string Description)
{
    public override string ToString() => Label;
}

/// <summary>A file waiting to be sent with the next request.</summary>
public sealed record Attachment(string Path)
{
    public string Name => System.IO.Path.GetFileName(Path);
    public string Glyph => System.IO.Path.GetExtension(Path).ToLowerInvariant() switch
    {
        ".png" or ".jpg" or ".jpeg" or ".webp" or ".gif" => Icons.Image,
        ".mp4" or ".mov" or ".mkv" or ".webm" or ".avi" or ".m4v" => Icons.Video,
        ".mp3" or ".wav" or ".m4a" or ".aac" or ".flac" or ".ogg" or ".opus" => Icons.Music,
        _ => Icons.Document,
    };
}
