using VideoEditor.Shared;

namespace VideoEditor.Chat;

/// <summary>One message in the chat: a request (with its attached files) or Claude's reply, which streams in.</summary>
public sealed class ChatMessage(bool isUser, string text, IReadOnlyList<string>? attachments = null, string? about = null) : Observable
{
    private string _text = text;
    private bool _isStreaming;

    public bool IsUser { get; } = isUser;
    public bool IsAssistant => !IsUser && !IsNote;
    /// <summary>A note from the app (the conversation was summarized), shown as a quiet line, not a message.</summary>
    public string? Note { get; init; }
    public bool IsNote => Note is not null;
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

    /// <summary>Streamed text; a bubble does not start with the blank line that separates steps.</summary>
    public void Append(string delta) => Text = Text.Length == 0 ? delta.TrimStart('\n') : Text + delta;

    private string? _error;
    /// <summary>The request failed: what went wrong, in a sentence; the chat shows it in an error box under the reply.</summary>
    public string? Error { get => _error; set => Set(ref _error, value, nameof(Error), nameof(HasError)); }
    public bool HasError => !string.IsNullOrEmpty(Error);
}

/// <summary>An edit plan the AI proposed (propose_plan), to approve or change.</summary>
public sealed record PlanCard(string Id, string Title, IReadOnlyList<PlanStep> Steps, string? Notes)
{
    public bool HasNotes => !string.IsNullOrWhiteSpace(Notes);
}

public sealed record PlanStep(int Number, string Text);

/// <summary>Something the AI remembers (Settings for the user, Summary for a project).</summary>
public sealed record MemoryEntry(string Id, string Text);

/// <summary>A saved conversation in the history list.</summary>
public sealed record ConversationEntry(string Id, string Title, string Updated, bool IsCurrent);

/// <summary>A model the chat can use: Claude's (the default), ChatGPT's or Gemini's.</summary>
public sealed record ModelOption(string Id, string Label, string Description, string Provider = "anthropic", string Assistant = "Claude")
{
    public override string ToString() => Label;
}

/// <summary>An AI provider the app can edit with, and whether it has a key.</summary>
public sealed record ProviderOption(string Id, string Label, string Assistant, string KeyUrl, string KeyHint, bool Available);

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
