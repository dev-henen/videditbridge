namespace VideoEditor.ViewModels;

/// <summary>One option Claude offered (offer_choices): something to hear or see, then pick.</summary>
public sealed class ChoiceCard(int index, string label, string? description, string? audio, string? image) : Observable
{
    public int Index { get; } = index;
    public string Label { get; } = label;
    public string? Description { get; } = description;
    public string? Audio { get; } = audio;
    public string? Image { get; } = image;
    public bool HasDescription => !string.IsNullOrEmpty(Description);
    public bool HasAudio => !string.IsNullOrEmpty(Audio);
    public bool HasImage => !string.IsNullOrEmpty(Image);

    private bool _isPlaying;
    public bool IsPlaying { get => _isPlaying; set => Set(ref _isPlaying, value, nameof(IsPlaying), nameof(PlayGlyph), nameof(PlayHint)); }
    // Filled stop square while playing, play triangle otherwise (Segoe Fluent Icons).
    public string PlayGlyph => IsPlaying ? "" : "";
    public string PlayHint => IsPlaying ? "Stop" : "Play";
}
