using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;

namespace VideoEditor.Projects;

/// <summary>The projects page, shown in a new tab: create a project, open one by its cover, or open any project folder.</summary>
public partial class ProjectsScreen : UserControl
{
    /// <summary>The user chose a project folder to open.</summary>
    public event Action<string>? OpenRequested;

    /// <summary>The user asked for a new project (named and shaped in the view model).</summary>
    public event Action? CreateRequested;

    public ProjectsScreen() => InitializeComponent();

    private void OnCreateProject(object? sender, RoutedEventArgs e) => CreateRequested?.Invoke();

    private void OnOpenProject(object? sender, RoutedEventArgs e)
    {
        if (sender is Control { Tag: string dir }) OpenRequested?.Invoke(dir);
    }

    private async void OnOpenFolder(object? sender, RoutedEventArgs e)
    {
        var storage = TopLevel.GetTopLevel(this)!.StorageProvider;
        var folders = await storage.OpenFolderPickerAsync(new FolderPickerOpenOptions { Title = "Open a project folder (contains project.json)" });
        if (folders.FirstOrDefault()?.TryGetLocalPath() is { } dir) OpenRequested?.Invoke(dir);
    }
}
