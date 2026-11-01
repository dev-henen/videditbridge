using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;

namespace VideoEditor.Shell;

/// <summary>A project's commands that are not requests to Claude, in the bar under its tab.</summary>
public partial class TopBar : UserControl
{
    /// <summary>A command is about to render something, so the preview should show it as it comes.</summary>
    public event Action? FollowRequested;

    public TopBar() => InitializeComponent();

    private ProjectViewModel Vm => (ProjectViewModel)DataContext!;
    private IStorageProvider Storage => TopLevel.GetTopLevel(this)!.StorageProvider;

    private async void OnUndo(object? sender, RoutedEventArgs e) => await Vm.UndoAsync();
    private async void OnRedo(object? sender, RoutedEventArgs e) => await Vm.RedoAsync();

    private static readonly FilePickerFileType MediaFiles = new("Media")
    {
        Patterns = ["*.mp4", "*.mov", "*.mkv", "*.webm", "*.ogv", "*.avi", "*.m4v", "*.mp3", "*.wav", "*.m4a", "*.aac", "*.flac", "*.ogg", "*.opus", "*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif"],
        MimeTypes = ["video/*", "audio/*", "image/*"],
        AppleUniformTypeIdentifiers = ["public.movie", "public.audio", "public.image"],
    };

    private async void OnImport(object? sender, RoutedEventArgs e)
    {
        var files = await Storage.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Import media",
            AllowMultiple = true,
            FileTypeFilter = [MediaFiles, FilePickerFileTypes.All],
        });
        var paths = files.Select(f => f.TryGetLocalPath()).OfType<string>().ToArray();
        if (paths.Length > 0) await Vm.ImportMediaAsync(paths);
    }

    private async void OnOverview(object? sender, RoutedEventArgs e)
    {
        FollowRequested?.Invoke();
        await Vm.RenderOverviewAsync();
    }

    private async void OnPreview(object? sender, RoutedEventArgs e)
    {
        FollowRequested?.Invoke();
        await Vm.RenderPreviewAsync();
    }

    private async void OnExport(object? sender, RoutedEventArgs e)
    {
        var outDir = Path.Combine(Vm.Dir, "out");
        Directory.CreateDirectory(outDir);
        var file = await Storage.SaveFilePickerAsync(new FilePickerSaveOptions
        {
            Title = "Export video",
            SuggestedFileName = $"{string.Join("_", Vm.ProjectName.Split(Path.GetInvalidFileNameChars()))}.mp4",
            DefaultExtension = "mp4",
            FileTypeChoices = [new FilePickerFileType("MP4 video") { Patterns = ["*.mp4"], MimeTypes = ["video/mp4"], AppleUniformTypeIdentifiers = ["public.mpeg-4"] }],
            SuggestedStartLocation = await Storage.TryGetFolderFromPathAsync(outDir),
        });
        if (file?.TryGetLocalPath() is not { } output) return;
        FollowRequested?.Invoke();
        await Vm.ExportAsync(output);
    }
}
