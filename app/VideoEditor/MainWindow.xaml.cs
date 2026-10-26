using System.ComponentModel;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;
using VideoEditor.ViewModels;

namespace VideoEditor;

/// <summary>
/// The editor window. The viewer "follows live": whenever the engine renders something
/// (a frame, an overview, a preview video) it is shown immediately. Scrubbing pauses follow mode.
/// </summary>
public partial class MainWindow : Window
{
    private readonly MainViewModel _vm = new();
    private readonly DispatcherTimer _scrubDebounce = new() { Interval = TimeSpan.FromMilliseconds(160) };
    private readonly DispatcherTimer _playbackTimer = new() { Interval = TimeSpan.FromMilliseconds(100) };
    private bool _follow = true;
    private bool _settingScrubber;
    private string? _shownRender;
    private string? _shownRevision;
    private bool _videoLoaded;
    private bool _playing;
    // The viewer shows one frame of the edit (a frame or a video, not the overview grid), so a click can point at a spot.
    private bool _pointable;
    private Spot? _spot;

    private const string PlayGlyph = "";
    private const string PauseGlyph = "";

    public MainWindow()
    {
        InitializeComponent();
        DataContext = _vm;
        _vm.ProjectChanged += ResetViewer;
        _vm.StateUpdated += OnState;
        _vm.PropertyChanged += OnViewModelChanged;
        Timeline.Seek += t => SetScrubber(t, fromUser: true);
        Timeline.SelectionChanged += OnPicked;
        _scrubDebounce.Tick += async (_, _) =>
        {
            _scrubDebounce.Stop();
            await ShowFrameAt(Scrubber.Value);
        };
        _playbackTimer.Tick += (_, _) =>
        {
            if (_videoLoaded && _playing) SetScrubber(Player.Position.TotalSeconds, fromUser: false);
        };
        PromptBox.TextChanged += (_, _) => PromptHint.Visibility = PromptBox.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        Loaded += async (_, _) =>
        {
            await _vm.StartAsync();
            // "VideoEditor.exe <project folder>" opens that project directly.
            var args = Environment.GetCommandLineArgs();
            if (args.Length > 1 && Directory.Exists(args[1])) await Open(args[1]);
        };
        Closing += (_, _) => _vm.Dispose();
    }

    // ------------------------------------------------------------- live viewer

    private void OnState(JsonNode state)
    {
        Timeline.Update(state);
        UpdateTimeText();
        var revision = state["revision"]?.ToString();

        var latest = state["renders"]?.AsArray().FirstOrDefault();
        if (_follow)
        {
            if (latest is not null && latest["url"]?.GetValue<string>() is { } path && path != _shownRender)
            {
                ShowRender(latest);
            }
            else if (latest is null && revision != _shownRevision && _vm.Duration > 0)
            {
                // Nothing rendered yet: show a representative frame (videos often open on black).
                if (_shownRevision is null && Scrubber.Value == 0) SetScrubber(Math.Round(_vm.Duration * 0.2, 1), fromUser: false);
                _scrubDebounce.Stop();
                _scrubDebounce.Start();
            }
        }
        else if (revision != _shownRevision && !_videoLoaded)
        {
            _scrubDebounce.Stop();
            _scrubDebounce.Start();
        }
        _shownRevision = revision;
        if (_vm.Duration <= 0 && _shownRender is null) ShowEmpty("Add media and ask Claude to start editing");
    }

    private void ShowRender(JsonNode render)
    {
        var path = render["url"]!.GetValue<string>();
        var kind = render["kind"]?.GetValue<string>();
        _shownRender = path;
        switch (kind)
        {
            case "preview":
            case "video":
                ShowVideo(path, kind == "video" ? "Exported video" : "Preview video");
                break;
            case "contact-sheet":
                ShowImage(path, "Overview of the whole video", pointable: false);
                break;
            default:
                var t = render["time"]?.GetValue<double>();
                ShowImage(path, t is null ? "Frame" : $"Frame at {t:0.0}s");
                if (t is not null) SetScrubber(t.Value, fromUser: false);
                break;
        }
    }

    private void ShowImage(string path, string caption, bool pointable = true)
    {
        StopVideo();
        _pointable = pointable;
        try
        {
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.CacheOption = BitmapCacheOption.OnLoad; // don't lock the file
            bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
            bmp.UriSource = new Uri(path);
            bmp.EndInit();
            bmp.Freeze();
            FrameImage.Source = bmp;
            FrameImage.Visibility = Visibility.Visible;
            ViewerEmpty.Visibility = Visibility.Collapsed;
            ViewerCaption.Text = caption;
            PlaceMarker();
        }
        catch (Exception e)
        {
            ShowEmpty($"Could not load {Path.GetFileName(path)}: {e.Message}");
        }
    }

    private void ShowVideo(string path, string caption)
    {
        FrameImage.Visibility = Visibility.Collapsed;
        ViewerEmpty.Visibility = Visibility.Collapsed;
        Player.Visibility = Visibility.Visible;
        _pointable = true;
        PlaceMarker();
        _videoLoaded = false;
        Player.Source = new Uri(path);
        Player.Play();
        _playing = true;
        PlayIcon.Text = PauseGlyph;
        _playbackTimer.Start();
        ViewerCaption.Text = caption;
    }

    private void StopVideo()
    {
        if (Player.Visibility != Visibility.Visible) return;
        Player.Stop();
        Player.Source = null;
        Player.Visibility = Visibility.Collapsed;
        _videoLoaded = false;
        _playing = false;
        PlayIcon.Text = PlayGlyph;
        _playbackTimer.Stop();
    }

    private void ShowEmpty(string message)
    {
        StopVideo();
        FrameImage.Visibility = Visibility.Collapsed;
        ViewerEmpty.Visibility = Visibility.Visible;
        ViewerEmpty.Text = message;
        _pointable = false;
        PlaceMarker();
    }

    private async Task ShowFrameAt(double time)
    {
        if (!_vm.IsProjectOpen || _vm.Duration <= 0) return;
        var t = Math.Clamp(time, 0, Math.Max(0, _vm.Duration - 0.05));
        var path = await _vm.ScrubAsync(t);
        if (path is null) return;
        // Ignore stale answers if the user kept scrubbing or a new render took over.
        if (Math.Abs(Scrubber.Value - time) > 0.01 && !_follow) return;
        ShowImage(path, $"Frame at {t:0.0}s");
    }

    private void SetFollow(bool follow)
    {
        _follow = follow;
        LiveText.Text = follow ? "LIVE" : "PAUSED";
        LiveText.Foreground = (Brush)FindResource(follow ? "Text" : "Muted");
        LiveDot.Fill = (Brush)FindResource(follow ? "Text" : "Faint");
        LiveBadge.Background = new SolidColorBrush(follow ? Color.FromArgb(0x26, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x12, 0xFF, 0xFF, 0xFF));
        FollowButton.Visibility = follow ? Visibility.Collapsed : Visibility.Visible;
    }

    private void OnFollowLive(object sender, RoutedEventArgs e)
    {
        SetFollow(true);
        _shownRender = null;
        if (_vm.State is { } s) OnState(s);
    }

    // ------------------------------------------------------------- scrubbing & playback

    private void SetScrubber(double t, bool fromUser)
    {
        _settingScrubber = !fromUser;
        Scrubber.Value = t;
        _settingScrubber = false;
        if (fromUser) OnUserScrub(t);
        Timeline.Playhead = t;
        UpdateTimeText();
    }

    private void OnScrub(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        Timeline.Playhead = e.NewValue;
        UpdateTimeText();
        if (!_settingScrubber) OnUserScrub(e.NewValue);
    }

    private void OnUserScrub(double t)
    {
        if (_videoLoaded)
        {
            Player.Position = TimeSpan.FromSeconds(t);
            return;
        }
        SetFollow(false);
        _scrubDebounce.Stop();
        _scrubDebounce.Start();
    }

    private void UpdateTimeText() => TimeText.Text = $"{Fmt(Scrubber.Value)} / {Fmt(_vm.Duration)}";

    private static string Fmt(double s) => $"{(int)s / 60:00}:{s % 60:00.0}";

    private void OnMediaOpened(object sender, RoutedEventArgs e)
    {
        _videoLoaded = true;
        PlaceMarker();
    }

    private void OnMediaEnded(object sender, RoutedEventArgs e)
    {
        Player.Pause();
        _playing = false;
        PlayIcon.Text = PlayGlyph;
    }

    private async void OnPlayPause(object sender, RoutedEventArgs e)
    {
        if (Player.Visibility == Visibility.Visible)
        {
            if (_playing) { Player.Pause(); _playing = false; PlayIcon.Text = PlayGlyph; }
            else
            {
                if (Player.NaturalDuration.HasTimeSpan && Player.Position >= Player.NaturalDuration.TimeSpan - TimeSpan.FromMilliseconds(100))
                    Player.Position = TimeSpan.Zero;
                Player.Play();
                _playing = true;
                PlayIcon.Text = PauseGlyph;
                _playbackTimer.Start();
            }
            return;
        }
        // No video loaded: play the latest preview, or render one.
        var preview = _vm.State?["renders"]?.AsArray().FirstOrDefault(r => r?["kind"]?.GetValue<string>() is "preview" or "video" && r["stale"]?.GetValue<bool>() != true);
        if (preview is not null) { SetFollow(true); ShowRender(preview); }
        else { SetFollow(true); await _vm.RenderPreviewAsync(); }
    }

    // ------------------------------------------------------------- commands

    private void OnViewModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainViewModel.AgentText)) AgentScroll.ScrollToEnd();
    }

    private async void OnShowProjects(object sender, RoutedEventArgs e) => await _vm.ShowProjectsAsync();
    private void OnHideProjects(object sender, RoutedEventArgs e) => _vm.HideProjects();

    private async void OnCreateProject(object sender, RoutedEventArgs e)
    {
        ResetViewer();
        await _vm.CreateProjectAsync();
    }

    private async void OnOpenProject(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: string dir }) await Open(dir);
    }

    private async void OnProjectDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (ProjectList.SelectedItem is ProjectEntry p) await Open(p.Dir);
    }

    private async void OnOpenFolder(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog { Title = "Open a project folder (contains project.json)" };
        if (dialog.ShowDialog(this) == true) await Open(dialog.FolderName);
    }

    private async Task Open(string dir)
    {
        ResetViewer();
        await _vm.OpenProjectAsync(dir);
    }

    private void ResetViewer()
    {
        _shownRender = null;
        _shownRevision = null;
        SetFollow(true);
        SetScrubber(0, fromUser: false);
        ShowEmpty("Loading…");
    }

    private async void OnImport(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog
        {
            Title = "Import media",
            Multiselect = true,
            Filter = "Media|*.mp4;*.mov;*.mkv;*.webm;*.ogv;*.avi;*.m4v;*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.png;*.jpg;*.jpeg;*.webp;*.gif|All files|*.*",
        };
        if (dialog.ShowDialog(this) == true) await _vm.ImportMediaAsync(dialog.FileNames);
    }

    private async void OnUndo(object sender, RoutedEventArgs e) => await _vm.UndoAsync();
    private async void OnRedo(object sender, RoutedEventArgs e) => await _vm.RedoAsync();

    private async void OnOverview(object sender, RoutedEventArgs e)
    {
        SetFollow(true);
        await _vm.RenderOverviewAsync();
    }

    private async void OnPreview(object sender, RoutedEventArgs e)
    {
        SetFollow(true);
        await _vm.RenderPreviewAsync();
    }

    private async void OnExport(object sender, RoutedEventArgs e)
    {
        var outDir = _vm.ProjectDir is null ? null : Path.Combine(_vm.ProjectDir, "out");
        if (outDir is not null) Directory.CreateDirectory(outDir);
        var dialog = new SaveFileDialog
        {
            Title = "Export video",
            Filter = "MP4 video|*.mp4",
            FileName = $"{string.Join("_", _vm.ProjectName.Split(Path.GetInvalidFileNameChars()))}.mp4",
            InitialDirectory = outDir,
        };
        if (dialog.ShowDialog(this) != true) return;
        SetFollow(true);
        await _vm.ExportAsync(dialog.FileName);
    }

    private async void OnAsk(object sender, RoutedEventArgs e) => await Ask();

    private async void OnPromptKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.None)
        {
            e.Handled = true;
            await Ask();
        }
    }

    private async Task Ask()
    {
        var prompt = PromptBox.Text;
        if (string.IsNullOrWhiteSpace(prompt)) return;
        PromptBox.Clear();
        SetFollow(true);
        await _vm.AskClaudeAsync(prompt, Timeline.Selected, _spot);
    }

    /// <summary>Show what the next request is about, when something is picked on the timeline.</summary>
    private void OnPicked(Controls.TimelineItem? item)
    {
        PickChip.Visibility = item is null ? Visibility.Collapsed : Visibility.Visible;
        UpdatePills();
        if (item is null) return;
        PickText.Text = $"{char.ToUpper(item.Kind[0])}{item.Kind[1..]}: {item.Label}";
        PickChip.ToolTip = $"Your request will be about this {item.Kind} ({item.Start:0.0}s to {item.End:0.0}s). Escape or the close button clears it.";
    }

    private void OnClearPick(object sender, RoutedEventArgs e) => Timeline.ClearSelection();

    // ------------------------------------------------------------- review

    private async void OnReview(object sender, RoutedEventArgs e)
    {
        SideTabs.SelectedItem = ReviewTab;
        await _vm.ReviewAsync();
    }

    private async void OnFix(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is FindingItem f) await _vm.FixAsync(f);
    }

    /// <summary>Clicking a finding goes to where it happens.</summary>
    private void OnFindingSelected(object sender, SelectionChangedEventArgs e)
    {
        if (e.AddedItems.Count > 0 && e.AddedItems[0] is FindingItem { IsProjectCheck: false } f) SetScrubber(f.Start, fromUser: true);
    }

    private void UpdatePills() =>
        Pills.Visibility = PickChip.Visibility == Visibility.Visible || SpotChip.Visibility == Visibility.Visible ? Visibility.Visible : Visibility.Collapsed;

    // ------------------------------------------------------------- pointing at a spot in the frame

    /// <summary>Where the picture sits inside the viewer (it is letterboxed to keep its shape), or null when none is shown.</summary>
    private Rect? PictureRect()
    {
        double w, h;
        if (Player.Visibility == Visibility.Visible && Player.NaturalVideoWidth > 0) (w, h) = (Player.NaturalVideoWidth, Player.NaturalVideoHeight);
        else if (FrameImage.Visibility == Visibility.Visible && FrameImage.Source is BitmapSource b) (w, h) = (b.PixelWidth, b.PixelHeight);
        else return null;
        var k = Math.Min(ViewerArea.ActualWidth / w, ViewerArea.ActualHeight / h);
        return new Rect((ViewerArea.ActualWidth - w * k) / 2, (ViewerArea.ActualHeight - h * k) / 2, w * k, h * k);
    }

    private void OnViewerClick(object sender, MouseButtonEventArgs e)
    {
        if (!_pointable || PictureRect() is not { } r) return;
        var p = e.GetPosition(ViewerArea);
        if (!r.Contains(p)) return;
        _spot = new Spot(Math.Round((p.X - r.Left) / r.Width, 3), Math.Round((p.Y - r.Top) / r.Height, 3), Math.Round(Scrubber.Value, 2));
        SpotText.Text = $"Spot at {Fmt(_spot.Time)}";
        SpotChip.ToolTip = $"Your request will be about this spot: x {_spot.X:0.00}, y {_spot.Y:0.00} of the frame, at {Fmt(_spot.Time)}. Say \"here\" or \"this\".";
        SpotChip.Visibility = Visibility.Visible;
        UpdatePills();
        PlaceMarker();
    }

    private void OnClearSpot(object sender, RoutedEventArgs e)
    {
        _spot = null;
        SpotChip.Visibility = Visibility.Collapsed;
        UpdatePills();
        PlaceMarker();
    }

    private void OnViewerResized(object sender, SizeChangedEventArgs e) => PlaceMarker();

    /// <summary>Keep the marker on its spot in the picture (it moves with resizing and hides on the overview).</summary>
    private void PlaceMarker()
    {
        if (_spot is null || !_pointable || PictureRect() is not { } r)
        {
            SpotMarker.Visibility = Visibility.Collapsed;
            return;
        }
        Canvas.SetLeft(SpotMarker, r.Left + _spot.X * r.Width - SpotMarker.Width / 2);
        Canvas.SetTop(SpotMarker, r.Top + _spot.Y * r.Height - SpotMarker.Height / 2);
        SpotMarker.Visibility = Visibility.Visible;
    }

    private void OnToggleTimeline(object sender, RoutedEventArgs e)
    {
        Timeline.Compact = !Timeline.Compact;
        ExpandIcon.Text = Timeline.Compact ? "" : "";
        ExpandTimeline.ToolTip = Timeline.Compact ? "Show all timeline lanes" : "Compact timeline";
    }

    private async void OnStopClaude(object sender, RoutedEventArgs e) => await _vm.CancelClaudeAsync();
}
