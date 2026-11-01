using Avalonia.Controls;
using Avalonia.Interactivity;
using VideoEditor.Shell;

namespace VideoEditor.Session;

/// <summary>
/// The left panel of a project: what is happening now, and tabs for the activity feed, the review's
/// findings, the project summary and the edit history. (The chat with Claude is on the right.)
/// </summary>
public partial class SessionPanel : UserControl
{
    private ProjectViewModel _vm = null!;

    /// <summary>A finding was clicked: go to where it happens.</summary>
    public event Action<double>? SeekRequested;

    public SessionPanel() => InitializeComponent();

    public void Attach(ProjectViewModel vm) => _vm = vm;

    // ------------------------------------------------------------- review

    private async void OnReview(object? sender, RoutedEventArgs e)
    {
        Tabs.SelectedItem = ReviewTab;
        await _vm.ReviewAsync();
    }

    private async void OnFix(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is FindingItem f) await _vm.FixAsync(f);
    }

    private void OnFindingSelected(object? sender, SelectionChangedEventArgs e)
    {
        if (e.AddedItems.Count > 0 && e.AddedItems[0] is FindingItem { IsProjectCheck: false } f) SeekRequested?.Invoke(f.Start);
    }
}
