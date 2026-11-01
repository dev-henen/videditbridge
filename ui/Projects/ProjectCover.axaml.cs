using Avalonia;
using Avalonia.Controls;
using Avalonia.Media.Imaging;

namespace VideoEditor.Projects;

/// <summary>A project's cover picture, or the default cover when there is none (yet).</summary>
public partial class ProjectCover : UserControl
{
    public static readonly StyledProperty<string?> SourceProperty = AvaloniaProperty.Register<ProjectCover, string?>(nameof(Source));

    /// <summary>The cover file (the project's cover.png), or null for the default cover.</summary>
    public string? Source
    {
        get => GetValue(SourceProperty);
        set => SetValue(SourceProperty, value);
    }

    public ProjectCover() => InitializeComponent();

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == SourceProperty) Load(Source);
    }

    private void Load(string? file)
    {
        var old = Picture.Source as Bitmap;
        Bitmap? bitmap = null;
        try
        {
            // Read whole, so the engine can write a new cover while it is shown.
            if (file is not null && File.Exists(file))
                using (var stream = new MemoryStream(File.ReadAllBytes(file)))
                    bitmap = Bitmap.DecodeToWidth(stream, 480);
        }
        catch
        {
            bitmap = null; // a cover being written: the default shows until the next refresh
        }
        Picture.Source = bitmap;
        Picture.IsVisible = bitmap is not null;
        DefaultCover.IsVisible = bitmap is null;
        old?.Dispose();
    }
}
