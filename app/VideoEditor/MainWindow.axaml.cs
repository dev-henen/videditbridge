using System.ComponentModel;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using VideoEditor.Playback;
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
    private readonly DispatcherTimer _glowTimer = new() { Interval = TimeSpan.FromMilliseconds(30) };
    private readonly string[] _args;
    private bool _follow = true;
    private bool _settingScrubber;
    private string? _shownRender;
    private string? _shownRevision;
    private VideoPlayer? _player;
    private bool _videoShown;
    private bool _playing;
    private Bitmap? _image;
    // The viewer shows one frame of the edit (a frame or a video, not the overview grid), so a click can point at a spot.
    private bool _pointable;
    private Spot? _spot;

    public MainWindow() : this([]) { }

    public MainWindow(string[] args)
    {
        _args = args;
        InitializeComponent();
        DataContext = _vm;
        _vm.ProjectChanged += ResetViewer;
        _vm.StateUpdated += OnState;
        _vm.PropertyChanged += OnViewModelChanged;
        _vm.ChoicesOffered += OnChoicesOffered;
        _vm.ErrorRaised += message => _ = ShowMessage(message);
        Timeline.Seek += t => SetScrubber(t, fromUser: true);
        Timeline.SelectionChanged += OnPicked;
        Scrubber.ValueChanged += OnScrub;
        _scrubDebounce.Tick += async (_, _) =>
        {
            _scrubDebounce.Stop();
            await ShowFrameAt(Scrubber.Value);
        };
        _playbackTimer.Tick += (_, _) =>
        {
            if (_player is { IsLoaded: true } && _playing) SetScrubber(_player.Position, fromUser: false);
        };
        _glowTimer.Tick += (_, _) =>
        {
            if (Glow.BorderBrush is ConicGradientBrush b) b.Angle = (b.Angle + 4.5) % 360;
        };
        Opened += async (_, _) =>
        {
            await _vm.StartAsync();
            if (_args.Length > 0 && Directory.Exists(_args[0])) await Open(_args[0]);
        };
        Closing += (_, _) =>
        {
            _audition?.Dispose();
            _player?.Dispose();
            _vm.Dispose();
        };
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
        else if (revision != _shownRevision && !_videoShown)
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
            // Read into memory so the file is not kept open (the engine replaces it).
            Bitmap bmp;
            using (var s = File.OpenRead(path)) bmp = new Bitmap(s);
            var old = _image;
            _image = bmp;
            FrameImage.Source = bmp;
            old?.Dispose();
            FrameImage.IsVisible = true;
            ViewerEmpty.IsVisible = false;
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
        if (Vlc.Instance is not { } vlc)
        {
            ShowEmpty(Vlc.Error ?? "Video playback is unavailable.");
            return;
        }
        if (_player is null)
        {
            _player = new VideoPlayer(vlc);
            _player.FrameReady += OnVideoFrame;
            _player.Opened += () => PlaceMarker();
            _player.Ended += () =>
            {
                _playing = false;
                PlayIcon.Text = Icons.Play;
            };
        }
        ViewerEmpty.IsVisible = false;
        FrameImage.IsVisible = true;
        _videoShown = true;
        _pointable = true;
        PlaceMarker();
        _player.Open(path);
        _playing = true;
        PlayIcon.Text = Icons.Pause;
        _playbackTimer.Start();
        ViewerCaption.Text = caption;
    }

    private void OnVideoFrame()
    {
        if (!_videoShown || _player?.Frame is not { } frame) return;
        if (!ReferenceEquals(FrameImage.Source, frame))
        {
            FrameImage.Source = frame;
            PlaceMarker();
        }
        FrameImage.InvalidateVisual();
    }

    private void StopVideo()
    {
        if (!_videoShown) return;
        _player?.Stop();
        _videoShown = false;
        _playing = false;
        PlayIcon.Text = Icons.Play;
        _playbackTimer.Stop();
        FrameImage.Source = _image;
    }

    private void ShowEmpty(string message)
    {
        StopVideo();
        FrameImage.IsVisible = false;
        ViewerEmpty.IsVisible = true;
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
        LiveText.Foreground = Brush(follow ? "Text" : "Muted");
        LiveDot.Fill = Brush(follow ? "Text" : "Faint");
        LiveBadge.Background = new SolidColorBrush(follow ? Color.FromArgb(0x26, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x12, 0xFF, 0xFF, 0xFF));
        FollowButton.IsVisible = !follow;
    }

    private IBrush Brush(string key) => this.TryFindResource(key, out var r) && r is IBrush b ? b : Brushes.White;

    private void OnFollowLive(object? sender, RoutedEventArgs e)
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

    private void OnScrub(object? sender, RangeBaseValueChangedEventArgs e)
    {
        Timeline.Playhead = e.NewValue;
        UpdateTimeText();
        if (!_settingScrubber) OnUserScrub(e.NewValue);
    }

    private void OnUserScrub(double t)
    {
        if (_videoShown && _player is { IsLoaded: true })
        {
            _player.Position = t;
            return;
        }
        SetFollow(false);
        _scrubDebounce.Stop();
        _scrubDebounce.Start();
    }

    private void UpdateTimeText() => TimeText.Text = $"{Fmt(Scrubber.Value)} / {Fmt(_vm.Duration)}";

    private static string Fmt(double s) => $"{(int)s / 60:00}:{s % 60:00.0}";

    private async void OnPlayPause(object? sender, RoutedEventArgs e)
    {
        if (_videoShown && _player is not null)
        {
            if (_playing)
            {
                _player.Pause();
                _playing = false;
                PlayIcon.Text = Icons.Play;
            }
            else
            {
                _player.Play();
                _playing = true;
                PlayIcon.Text = Icons.Pause;
                _playbackTimer.Start();
            }
            return;
        }
        // No video loaded: play the latest preview, or render one.
        var preview = _vm.State?["renders"]?.AsArray().FirstOrDefault(r => r?["kind"]?.GetValue<string>() is "preview" or "video" && r["stale"]?.GetValue<bool>() != true);
        SetFollow(true);
        if (preview is not null) ShowRender(preview);
        else await _vm.RenderPreviewAsync();
    }

    // ------------------------------------------------------------- commands

    private void OnViewModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainViewModel.AgentText)) Dispatcher.UIThread.Post(() => AgentScroll.ScrollToEnd(), DispatcherPriority.Background);
        if (e.PropertyName == nameof(MainViewModel.IsBusy))
        {
            Glow.Opacity = _vm.IsBusy ? 1 : 0;
            if (_vm.IsBusy) _glowTimer.Start();
            else _glowTimer.Stop();
        }
    }

    private async void OnShowProjects(object? sender, RoutedEventArgs e) => await _vm.ShowProjectsAsync();
    private void OnHideProjects(object? sender, RoutedEventArgs e) => _vm.HideProjects();

    private async void OnCreateProject(object? sender, RoutedEventArgs e)
    {
        ResetViewer();
        await _vm.CreateProjectAsync();
    }

    private async void OnOpenProject(object? sender, RoutedEventArgs e)
    {
        if (sender is Control { Tag: string dir }) await Open(dir);
    }

    private async void OnProjectDoubleClick(object? sender, TappedEventArgs e)
    {
        if (ProjectList.SelectedItem is ProjectEntry p) await Open(p.Dir);
    }

    private async void OnOpenFolder(object? sender, RoutedEventArgs e)
    {
        var folders = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions { Title = "Open a project folder (contains project.json)" });
        if (folders.FirstOrDefault()?.TryGetLocalPath() is { } dir) await Open(dir);
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
        ShowEmpty("Loading...");
    }

    private static readonly FilePickerFileType MediaFiles = new("Media")
    {
        Patterns = ["*.mp4", "*.mov", "*.mkv", "*.webm", "*.ogv", "*.avi", "*.m4v", "*.mp3", "*.wav", "*.m4a", "*.aac", "*.flac", "*.ogg", "*.opus", "*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif"],
        MimeTypes = ["video/*", "audio/*", "image/*"],
        AppleUniformTypeIdentifiers = ["public.movie", "public.audio", "public.image"],
    };

    private async void OnImport(object? sender, RoutedEventArgs e)
    {
        var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Import media",
            AllowMultiple = true,
            FileTypeFilter = [MediaFiles, FilePickerFileTypes.All],
        });
        var paths = files.Select(f => f.TryGetLocalPath()).OfType<string>().ToArray();
        if (paths.Length > 0) await _vm.ImportMediaAsync(paths);
    }

    private async void OnUndo(object? sender, RoutedEventArgs e) => await _vm.UndoAsync();
    private async void OnRedo(object? sender, RoutedEventArgs e) => await _vm.RedoAsync();

    private async void OnOverview(object? sender, RoutedEventArgs e)
    {
        SetFollow(true);
        await _vm.RenderOverviewAsync();
    }

    private async void OnPreview(object? sender, RoutedEventArgs e)
    {
        SetFollow(true);
        await _vm.RenderPreviewAsync();
    }

    private async void OnExport(object? sender, RoutedEventArgs e)
    {
        var outDir = _vm.ProjectDir is null ? null : Path.Combine(_vm.ProjectDir, "out");
        if (outDir is not null) Directory.CreateDirectory(outDir);
        var file = await StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
        {
            Title = "Export video",
            SuggestedFileName = $"{string.Join("_", _vm.ProjectName.Split(Path.GetInvalidFileNameChars()))}.mp4",
            DefaultExtension = "mp4",
            FileTypeChoices = [new FilePickerFileType("MP4 video") { Patterns = ["*.mp4"], MimeTypes = ["video/mp4"], AppleUniformTypeIdentifiers = ["public.mpeg-4"] }],
            SuggestedStartLocation = outDir is null ? null : await StorageProvider.TryGetFolderFromPathAsync(outDir),
        });
        if (file?.TryGetLocalPath() is not { } output) return;
        SetFollow(true);
        await _vm.ExportAsync(output);
    }

    private async void OnAsk(object? sender, RoutedEventArgs e) => await Ask();

    private async void OnPromptKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && e.KeyModifiers == KeyModifiers.None)
        {
            e.Handled = true;
            await Ask();
        }
    }

    private async Task Ask()
    {
        var prompt = PromptBox.Text;
        if (string.IsNullOrWhiteSpace(prompt)) return;
        PromptBox.Text = "";
        SetFollow(true);
        await _vm.AskClaudeAsync(prompt, Timeline.Selected, _spot);
    }

    /// <summary>Show what the next request is about, when something is picked on the timeline.</summary>
    private void OnPicked(Controls.TimelineItem? item)
    {
        PickChip.IsVisible = item is not null;
        UpdatePills();
        if (item is null) return;
        PickText.Text = $"{char.ToUpper(item.Kind[0])}{item.Kind[1..]}: {item.Label}";
        ToolTip.SetTip(PickChip, $"Your request will be about this {item.Kind} ({item.Start:0.0}s to {item.End:0.0}s). Escape or the close button clears it.");
    }

    private void OnClearPick(object? sender, RoutedEventArgs e) => Timeline.ClearSelection();

    // ------------------------------------------------------------- options Claude offers

    private AudioPlayer? _audition;
    private ChoiceCard? _auditioning;

    private void OnChoicesOffered()
    {
        StopAudition();
        SideTabs.SelectedItem = ClaudeTab;
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
        SideTabs.SelectedItem = ReviewTab;
        await _vm.ReviewAsync();
    }

    private async void OnFix(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is FindingItem f) await _vm.FixAsync(f);
    }

    /// <summary>Clicking a finding goes to where it happens.</summary>
    private void OnFindingSelected(object? sender, SelectionChangedEventArgs e)
    {
        if (e.AddedItems.Count > 0 && e.AddedItems[0] is FindingItem { IsProjectCheck: false } f) SetScrubber(f.Start, fromUser: true);
    }

    private void UpdatePills() => Pills.IsVisible = PickChip.IsVisible || SpotChip.IsVisible;

    // ------------------------------------------------------------- pointing at a spot in the frame

    /// <summary>Where the picture sits inside the viewer (it is letterboxed to keep its shape), or null when none is shown.</summary>
    private Rect? PictureRect()
    {
        double w, h;
        if (_videoShown && _player is { } p && p.VideoSize.Width > 0) (w, h) = (p.VideoSize.Width, p.VideoSize.Height);
        else if (FrameImage.IsVisible && FrameImage.Source is Bitmap b) (w, h) = (b.PixelSize.Width, b.PixelSize.Height);
        else return null;
        var area = ViewerArea.Bounds.Size;
        var k = Math.Min(area.Width / w, area.Height / h);
        return new Rect((area.Width - w * k) / 2, (area.Height - h * k) / 2, w * k, h * k);
    }

    private void OnViewerClick(object? sender, PointerReleasedEventArgs e)
    {
        if (e.InitialPressMouseButton != MouseButton.Left || !_pointable || PictureRect() is not { } r) return;
        var p = e.GetPosition(ViewerArea);
        if (!r.Contains(p)) return;
        _spot = new Spot(Math.Round((p.X - r.Left) / r.Width, 3), Math.Round((p.Y - r.Top) / r.Height, 3), Math.Round(Scrubber.Value, 2));
        SpotText.Text = $"Spot at {Fmt(_spot.Time)}";
        ToolTip.SetTip(SpotChip, $"Your request will be about this spot: x {_spot.X:0.00}, y {_spot.Y:0.00} of the frame, at {Fmt(_spot.Time)}. Say \"here\" or \"this\".");
        SpotChip.IsVisible = true;
        UpdatePills();
        PlaceMarker();
    }

    private void OnClearSpot(object? sender, RoutedEventArgs e)
    {
        _spot = null;
        SpotChip.IsVisible = false;
        UpdatePills();
        PlaceMarker();
    }

    private void OnViewerResized(object? sender, SizeChangedEventArgs e) => PlaceMarker();

    /// <summary>Keep the marker on its spot in the picture (it moves with resizing and hides on the overview).</summary>
    private void PlaceMarker()
    {
        if (_spot is null || !_pointable || PictureRect() is not { } r)
        {
            SpotMarker.IsVisible = false;
            return;
        }
        Canvas.SetLeft(SpotMarker, r.Left + _spot.X * r.Width - SpotMarker.Width / 2);
        Canvas.SetTop(SpotMarker, r.Top + _spot.Y * r.Height - SpotMarker.Height / 2);
        SpotMarker.IsVisible = true;
    }

    private void OnToggleTimeline(object? sender, RoutedEventArgs e)
    {
        Timeline.Compact = !Timeline.Compact;
        ExpandIcon.Text = Timeline.Compact ? Icons.ChevronUp : Icons.ChevronDown;
        ToolTip.SetTip(ExpandTimeline, Timeline.Compact ? "Show all timeline lanes" : "Compact timeline");
    }

    private async void OnStopClaude(object? sender, RoutedEventArgs e) => await _vm.CancelClaudeAsync();

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
            Background = Brush("Panel"),
            Content = new StackPanel
            {
                Margin = new Thickness(16),
                Spacing = 14,
                Children = { new SelectableTextBlock { Text = message, TextWrapping = TextWrapping.Wrap, Foreground = Brush("Text") }, ok },
            },
        };
        ok.Click += (_, _) => dialog.Close();
        await dialog.ShowDialog(this);
    }
}
