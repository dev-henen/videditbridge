using System.Collections.ObjectModel;
using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using VideoEditor.Preview;
using VideoEditor.Shared;
using VideoEditor.Shell;
using VideoEditor.Timeline;

namespace VideoEditor.Chat;

/// <summary>
/// Where people write to Claude: the request, files to send with it (the add button, or dropped on
/// the box), the model, and pills for what the request is about (an item picked on the timeline, a
/// spot clicked in the frame). The box glows while anything runs in the project.
/// </summary>
public partial class ChatComposer : UserControl
{
    private readonly DispatcherTimer _glowTimer = new() { Interval = TimeSpan.FromMilliseconds(30) };
    private readonly ObservableCollection<Attachment> _files = [];
    private ProjectViewModel _vm = null!;

    /// <summary>The user sent a request (Enter or the send button), with the files to send.</summary>
    public event Action<string, IReadOnlyList<string>>? Submitted;

    /// <summary>The user removed the picked item's pill.</summary>
    public event Action? PickCleared;

    /// <summary>The user removed the spot's pill.</summary>
    public event Action? SpotCleared;

    public ChatComposer()
    {
        InitializeComponent();
        Files.ItemsSource = _files;
        _files.CollectionChanged += (_, _) => Files.IsVisible = _files.Count > 0;
        _glowTimer.Tick += (_, _) =>
        {
            if (Glow.BorderBrush is ConicGradientBrush b) b.Angle = (b.Angle + 4.5) % 360;
        };
        AddHandler(DragDrop.DragOverEvent, OnDragOver);
        AddHandler(DragDrop.DragLeaveEvent, (_, _) => Box.Classes.Set("dropping", false));
        AddHandler(DragDrop.DropEvent, OnDrop);
    }

    public void Attach(ProjectViewModel vm)
    {
        _vm = vm;
        _vm.PropertyChanged += OnViewModelChanged;
    }

    /// <summary>Put the cursor in the box.</summary>
    public void FocusPrompt() => PromptBox.Focus();

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
        if (e.PropertyName != nameof(ProjectViewModel.IsBusy) && e.PropertyName != nameof(ProjectViewModel.AgentRunning)) return;
        var busy = _vm.IsBusy || _vm.AgentRunning;
        Glow.Opacity = busy ? 1 : 0;
        if (busy) _glowTimer.Start();
        else _glowTimer.Stop();
    }

    private void OnAsk(object? sender, RoutedEventArgs e) => Submit();

    // Enter sends; Shift+Enter starts a new line.
    private void OnPromptKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter || e.KeyModifiers != KeyModifiers.None) return;
        e.Handled = true;
        Submit();
    }

    private void Submit()
    {
        var prompt = PromptBox.Text;
        if (string.IsNullOrWhiteSpace(prompt) || !_vm.CanAsk) return;
        PromptBox.Text = "";
        var files = _files.Select(f => f.Path).ToList();
        _files.Clear();
        Submitted?.Invoke(prompt, files);
    }

    // ------------------------------------------------------------- files

    private void AddFiles(IEnumerable<string> paths)
    {
        foreach (var p in paths)
            if (File.Exists(p) && _files.All(f => f.Path != p)) _files.Add(new Attachment(p));
    }

    private async void OnAttach(object? sender, RoutedEventArgs e)
    {
        var storage = TopLevel.GetTopLevel(this)!.StorageProvider;
        var picked = await storage.OpenFilePickerAsync(new FilePickerOpenOptions { Title = "Add files", AllowMultiple = true });
        AddFiles(picked.Select(f => f.TryGetLocalPath()).OfType<string>());
        PromptBox.Focus();
    }

    private void OnRemoveFile(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is Attachment a) _files.Remove(a);
    }

    private void OnDragOver(object? sender, DragEventArgs e)
    {
        var files = e.DataTransfer.Contains(DataFormat.File) && _vm.CanAsk;
        e.DragEffects = files ? DragDropEffects.Copy : DragDropEffects.None;
        Box.Classes.Set("dropping", files);
    }

    private void OnDrop(object? sender, DragEventArgs e)
    {
        Box.Classes.Set("dropping", false);
        if (!_vm.CanAsk) return;
        AddFiles(e.DataTransfer.TryGetFiles()?.Select(f => f.TryGetLocalPath()).OfType<string>() ?? []);
    }

    private void OnClearPick(object? sender, RoutedEventArgs e) => PickCleared?.Invoke();
    private void OnClearSpot(object? sender, RoutedEventArgs e) => SpotCleared?.Invoke();
    private async void OnStopClaude(object? sender, RoutedEventArgs e) => await _vm.CancelClaudeAsync();
}
