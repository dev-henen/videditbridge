using Avalonia.Media.Imaging;

using VideoEditor.Shared;

namespace VideoEditor.Session;

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
    public bool HasImage => ImageBitmap is not null;

    private Bitmap? _bitmap;
    private bool _loaded;

    /// <summary>The option's picture, read into memory once (so the file is not kept open).</summary>
    public Bitmap? ImageBitmap
    {
        get
        {
            if (_loaded || string.IsNullOrEmpty(Image)) return _bitmap;
            _loaded = true;
            try
            {
                using var s = File.OpenRead(Image);
                _bitmap = new Bitmap(s);
            }
            catch (IOException) { }
            catch (ArgumentException) { }
            return _bitmap;
        }
    }

    private bool _isPlaying;
    public bool IsPlaying { get => _isPlaying; set => Set(ref _isPlaying, value, nameof(IsPlaying), nameof(PlayGlyph), nameof(PlayHint)); }
    public string PlayGlyph => IsPlaying ? Icons.Stop : Icons.Play;
    public string PlayHint => IsPlaying ? "Stop" : "Play";
}
