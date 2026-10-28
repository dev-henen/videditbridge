using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Threading;
using VideoEditor.Preview;
using VideoEditor.Shared;
using VideoEditor.Shell;
using VideoEditor.Timeline;

namespace VideoEditor.Ask;

/// <summary>
/// Where people ask Claude for edits. Pills above the text show what the request is about (an item
/// picked on the timeline, a spot clicked in the frame), and the box glows while anything runs.
/// </summary>
public partial class AskBox : UserControl
{
    private readonly DispatcherTimer _glowTimer = new() { Interval = TimeSpan.FromMilliseconds(30) };
    private MainViewModel _vm = null!;

    /// <summary>The user sent a request (Enter or the send button).</summary>
    public event Action<string>? Submitted;

    /// <summary>The user removed the picked item's pill.</summary>
    public event Action? PickCleared;

    /// <summary>The user removed the spot's pill.</summary>
    public event Action? SpotCleared;

    public AskBox()
    {
        InitializeComponent();
        _glowTimer.Tick += (_, _) =>
        {
            if (Glow.BorderBrush is ConicGradientBrush b) b.Angle = (b.Angle + 4.5) % 360;
        };
    }

    public void Attach(MainViewModel vm)
    {
        _vm = vm;
        _vm.PropertyChanged += OnViewModelChanged;
    }

    /// <summary>Show (or hide, for null) the item picked on the timeline.</summary>
    public void ShowPick(TimelineItem? item)
    {
        PickChip.IsVisible = item is not null;
        UpdatePills();
        if (item is null) return;
        PickText.Text = $"{char.ToUpper(item.Kind[0])}{item.Kind[1..]}: {item.Label}";
        ToolTip.SetTip(PickChip, $"Your request will be about this {item.Kind} ({item.Start:0.0}s to {item.End:0.0}s). Escape or the close button clears it.");
    }

    /// <summary>Show (or hide, for null) the spot clicked in the frame.</summary>
    public void ShowSpot(Spot? spot)
    {
        SpotChip.IsVisible = spot is not null;
        UpdatePills();
        if (spot is null) return;
        SpotText.Text = $"Spot at {Ui.Time(spot.Time)}";
        ToolTip.SetTip(SpotChip, $"Your request will be about this spot: x {spot.X:0.00}, y {spot.Y:0.00} of the frame, at {Ui.Time(spot.Time)}. Say \"here\" or \"this\".");
    }

    private void UpdatePills() => Pills.IsVisible = PickChip.IsVisible || SpotChip.IsVisible;

    private void OnViewModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(MainViewModel.IsBusy)) return;
        Glow.Opacity = _vm.IsBusy ? 1 : 0;
        if (_vm.IsBusy) _glowTimer.Start();
        else _glowTimer.Stop();
    }

    private void OnAsk(object? sender, RoutedEventArgs e) => Submit();

    private void OnPromptKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter || e.KeyModifiers != KeyModifiers.None) return;
        e.Handled = true;
        Submit();
    }

    private void Submit()
    {
        var prompt = PromptBox.Text;
        if (string.IsNullOrWhiteSpace(prompt)) return;
        PromptBox.Text = "";
        Submitted?.Invoke(prompt);
    }

    private void OnClearPick(object? sender, RoutedEventArgs e) => PickCleared?.Invoke();
    private void OnClearSpot(object? sender, RoutedEventArgs e) => SpotCleared?.Invoke();
    private async void OnStopClaude(object? sender, RoutedEventArgs e) => await _vm.CancelClaudeAsync();
}
