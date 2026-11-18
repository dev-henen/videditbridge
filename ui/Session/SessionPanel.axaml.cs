using System.Collections.Specialized;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using VideoEditor.Shared;
using VideoEditor.Shell;

namespace VideoEditor.Session;

/// <summary>
/// The left panel of a project: what is happening now, and tabs for the activity feed, the review's
/// findings, the project summary, the media in the project and the project's history. (The chat with
/// Claude is on the right.)
/// </summary>
public partial class SessionPanel : UserControl
{
    private ProjectViewModel _vm = null!;

    /// <summary>A finding was clicked: go to where it happens.</summary>
    public event Action<double>? SeekRequested;

    public SessionPanel() => InitializeComponent();

    public void Attach(ProjectViewModel vm)
    {
        _vm = vm;
        // A new activity goes on top of the list: bring the list back to the top so it shows.
        vm.Activities.CollectionChanged += (_, e) =>
        {
            if (e.Action == NotifyCollectionChangedAction.Add && e.NewStartingIndex == 0)
                Dispatcher.UIThread.Post(() =>
                {
                    if (ActivityList.ItemCount > 0) ActivityList.ScrollIntoView(0);
                }, DispatcherPriority.Background);
        };
    }

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

    private int _scopesToken;

    private void OnFindingSelected(object? sender, SelectionChangedEventArgs e)
    {
        if (e.AddedItems.Count > 0 && e.AddedItems[0] is FindingItem { IsProjectCheck: false } f)
        {
            SeekRequested?.Invoke(f.Start);
            _ = ShowScopes(f);
        }
        else if (e.AddedItems.Count > 0) ScopesPanel.IsVisible = false;
    }

    /// <summary>Scopes of the frame where a finding happens (its middle), next to the list: clipping, skin and color at a glance.</summary>
    private async Task ShowScopes(FindingItem f)
    {
        var token = ++_scopesToken;
        var time = f.End > f.Start ? (f.Start + f.End) / 2 : f.Start;
        ScopesCaption.Text = $"Scopes at {Ui.Time(time)} (loading)";
        ScopesPanel.IsVisible = true;
        var path = await _vm.ScopesAsync(time);
        if (token != _scopesToken) return;
        if (path is null)
        {
            ScopesPanel.IsVisible = false;
            return;
        }
        try
        {
            Bitmap bmp;
            using (var s = File.OpenRead(path)) bmp = new Bitmap(s);
            var old = ScopesImage.Source as IDisposable;
            ScopesImage.Source = bmp;
            old?.Dispose();
            ScopesCaption.Text = $"Scopes at {Ui.Time(time)}: histogram, waveform, parade, vectorscope";
        }
        catch
        {
            ScopesPanel.IsVisible = false;
        }
    }

    /// <summary>A media item was clicked: go to where the edit first uses it.</summary>
    private void OnMediaSelected(object? sender, SelectionChangedEventArgs e)
    {
        if (e.AddedItems.Count > 0 && e.AddedItems[0] is MediaItem { FirstUse: { } at }) SeekRequested?.Invoke(at);
    }

    private async void OnRemoveMedia(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is MediaItem m) await _vm.RemoveMediaAsync(m);
    }

    private async void OnForgetMemory(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is string id) await _vm.ForgetMemoryAsync(id);
    }
}
