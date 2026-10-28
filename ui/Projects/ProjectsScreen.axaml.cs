using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using VideoEditor.Shell;

namespace VideoEditor.Projects;

/// <summary>The projects screen: create a project, open a recent one, or open any project folder.</summary>
public partial class ProjectsScreen : UserControl
{
    /// <summary>The user chose a project folder to open.</summary>
    public event Action<string>? OpenRequested;

    /// <summary>The user asked for a new project (named and shaped in the view model).</summary>
    public event Action? CreateRequested;

    public ProjectsScreen() => InitializeComponent();

    private MainViewModel Vm => (MainViewModel)DataContext!;

    private void OnHideProjects(object? sender, RoutedEventArgs e) => Vm.HideProjects();
    private void OnCreateProject(object? sender, RoutedEventArgs e) => CreateRequested?.Invoke();

    private void OnOpenProject(object? sender, RoutedEventArgs e)
    {
        if (sender is Control { Tag: string dir }) OpenRequested?.Invoke(dir);
    }

    private void OnProjectDoubleClick(object? sender, TappedEventArgs e)
    {
        if (ProjectList.SelectedItem is ProjectEntry p) OpenRequested?.Invoke(p.Dir);
    }

    private async void OnOpenFolder(object? sender, RoutedEventArgs e)
    {
        var storage = TopLevel.GetTopLevel(this)!.StorageProvider;
        var folders = await storage.OpenFolderPickerAsync(new FolderPickerOpenOptions { Title = "Open a project folder (contains project.json)" });
        if (folders.FirstOrDefault()?.TryGetLocalPath() is { } dir) OpenRequested?.Invoke(dir);
    }
}
