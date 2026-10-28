using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
using VideoEditor.Preview;
using VideoEditor.Shell;

namespace VideoEditor.Session;

/// <summary>
/// The side panel: what is happening now, and tabs for the activity feed, Claude's replies and the
/// options it offers, the review's findings, the project summary and the edit history.
/// </summary>
public partial class SessionPanel : UserControl
{
    private MainViewModel _vm = null!;
    private AudioPlayer? _audition;
    private ChoiceCard? _auditioning;

    /// <summary>A finding was clicked: go to where it happens.</summary>
    public event Action<double>? SeekRequested;

    public SessionPanel() => InitializeComponent();

    public void Attach(MainViewModel vm)
    {
        _vm = vm;
        _vm.PropertyChanged += OnViewModelChanged;
        _vm.ChoicesOffered += OnChoicesOffered;
    }

    public void Dispose() => _audition?.Dispose();

    private void OnViewModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainViewModel.AgentText)) Dispatcher.UIThread.Post(() => AgentScroll.ScrollToEnd(), DispatcherPriority.Background);
    }

    // ------------------------------------------------------------- options Claude offers

    private void OnChoicesOffered()
    {
        StopAudition();
        Tabs.SelectedItem = ClaudeTab;
    }

    /// <summary>Play an option's audio; one plays at a time, and pressing again stops it.</summary>
    private void OnPlayChoice(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is not ChoiceCard card || card.Audio is null) return;
        var again = ReferenceEquals(card, _auditioning);
        StopAudition();
        if (again) return;
        if (Vlc.Instance is not { } vlc)
        {
            _vm.ShowError(Vlc.Error ?? "Audio playback is unavailable.");
            return;
        }
        if (_audition is null)
        {
            _audition = new AudioPlayer(vlc);
            _audition.Ended += StopAudition;
        }
        _auditioning = card;
        card.IsPlaying = true;
        _audition.Play(card.Audio);
    }

    private void StopAudition()
    {
        _audition?.Stop();
        if (_auditioning is not null) _auditioning.IsPlaying = false;
        _auditioning = null;
    }

    private async void OnPickChoice(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is not ChoiceCard card) return;
        StopAudition();
        await _vm.PickChoiceAsync(card);
    }

    private async void OnDismissChoices(object? sender, RoutedEventArgs e)
    {
        StopAudition();
        await _vm.DismissChoicesAsync();
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

    private void OnFindingSelected(object? sender, SelectionChangedEventArgs e)
    {
        if (e.AddedItems.Count > 0 && e.AddedItems[0] is FindingItem { IsProjectCheck: false } f) SeekRequested?.Invoke(f.Start);
    }
}
