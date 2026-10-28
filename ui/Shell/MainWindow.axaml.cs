using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using VideoEditor.Shared;

namespace VideoEditor.Shell;

/// <summary>
/// The editor window: lays out the parts and connects them. The preview, the timeline and the ask
/// box share the playhead, the picked item and the spot; everything else goes through the view model.
/// </summary>
public partial class MainWindow : Window
{
    private readonly MainViewModel _vm = new();
    private readonly string[] _args;

    public MainWindow() : this([]) { }

    public MainWindow(string[] args)
    {
        _args = args;
        InitializeComponent();
        DataContext = _vm;
        Screen.Attach(_vm);
        Side.Attach(_vm);
        AskBar.Attach(_vm);
        _vm.StateUpdated += Strip.Update;
        _vm.ErrorRaised += message => _ = ShowMessage(message);

        // Commands and requests that render something bring the preview back to live.
        Bar.FollowRequested += Screen.Follow;
        // One playhead: the preview's scrubber and the timeline move together.
        Screen.PlayheadMoved += t => Strip.Playhead = t;
        Strip.Seek += Screen.Seek;
        Side.SeekRequested += Screen.Seek;
        // What the next request is about.
        Strip.SelectionChanged += AskBar.ShowPick;
        Screen.SpotChanged += AskBar.ShowSpot;
        AskBar.PickCleared += Strip.ClearSelection;
        AskBar.SpotCleared += Screen.ClearSpot;
        AskBar.Submitted += async prompt =>
        {
            Screen.Follow();
            await _vm.AskClaudeAsync(prompt, Strip.Selected, Screen.Spot);
        };
        Picker.OpenRequested += async dir => await Open(dir);
        Picker.CreateRequested += async () =>
        {
            Screen.Reset();
            await _vm.CreateProjectAsync();
        };

        Opened += async (_, _) =>
        {
            await _vm.StartAsync();
            if (_args.Length > 0 && Directory.Exists(_args[0])) await Open(_args[0]);
        };
        Closing += (_, _) =>
        {
            Side.Dispose();
            Screen.Dispose();
            _vm.Dispose();
        };
    }

    private async Task Open(string dir)
    {
        Screen.Reset();
        await _vm.OpenProjectAsync(dir);
    }

    /// <summary>A small message window in the app's style (Avalonia has no system message box).</summary>
    private async Task ShowMessage(string message)
    {
        var ok = new Button { Content = "OK", Classes = { "primary" }, HorizontalAlignment = HorizontalAlignment.Right, IsDefault = true };
        var dialog = new Window
        {
            Title = "AI Video Editor",
            Width = 380,
            SizeToContent = SizeToContent.Height,
            CanResize = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = this.Brush("Panel"),
            Content = new StackPanel
            {
                Margin = new Thickness(16),
                Spacing = 14,
                Children = { new SelectableTextBlock { Text = message, TextWrapping = TextWrapping.Wrap, Foreground = this.Brush("Text") }, ok },
            },
        };
        ok.Click += (_, _) => dialog.Close();
        await dialog.ShowDialog(this);
    }
}
