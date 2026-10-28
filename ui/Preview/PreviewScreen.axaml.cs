using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using VideoEditor.Shared;
using VideoEditor.Shell;

namespace VideoEditor.Preview;

/// <summary>
/// The preview screen. It "follows live": whenever the engine renders something (a frame, an
/// overview, a preview video) it is shown immediately. Scrubbing pauses follow mode. Clicking the
/// picture points Claude at a spot in the frame.
/// </summary>
public partial class PreviewScreen : UserControl
{
    private readonly DispatcherTimer _scrubDebounce = new() { Interval = TimeSpan.FromMilliseconds(160) };
    private readonly DispatcherTimer _playbackTimer = new() { Interval = TimeSpan.FromMilliseconds(100) };
    private MainViewModel _vm = null!;
    private bool _follow = true;
    private bool _settingScrubber;
    private string? _shownRender;
    private string? _shownRevision;
    private VideoPlayer? _player;
    private bool _videoShown;
    private bool _playing;
    private Bitmap? _image;
    // The screen shows one frame of the edit (a frame or a video, not the overview grid), so a click can point at a spot.
    private bool _pointable;

    /// <summary>The playhead moved (playback, scrubbing or a render at a time).</summary>
    public event Action<double>? PlayheadMoved;

    /// <summary>A spot was clicked in the frame, or cleared (null).</summary>
    public event Action<Spot?>? SpotChanged;

    /// <summary>The spot the next request is about, if one was clicked.</summary>
    public Spot? Spot { get; private set; }

    public PreviewScreen()
    {
        InitializeComponent();
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
    }

    public void Attach(MainViewModel vm)
    {
        _vm = vm;
        _vm.ProjectChanged += Reset;
        _vm.StateUpdated += OnState;
    }

    /// <summary>Show each new render as it comes (after a command or a request to Claude).</summary>
    public void Follow() => SetFollow(true);

    /// <summary>Go to a timeline time, as if the user scrubbed there.</summary>
    public void Seek(double t) => SetScrubber(t, fromUser: true);

    /// <summary>Start over for another project.</summary>
    public void Reset()
    {
        _shownRender = null;
        _shownRevision = null;
        SetFollow(true);
        SetScrubber(0, fromUser: false);
        ShowEmpty("Loading...");
    }

    public void ClearSpot()
    {
        Spot = null;
        PlaceMarker();
        SpotChanged?.Invoke(null);
    }

    public void Dispose() => _player?.Dispose();

    // ------------------------------------------------------------- live output

    private void OnState(JsonNode state)
    {
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
        LiveText.Foreground = this.Brush(follow ? "Text" : "Muted");
        LiveDot.Fill = this.Brush(follow ? "Text" : "Faint");
        LiveBadge.Background = new SolidColorBrush(follow ? Color.FromArgb(0x26, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x12, 0xFF, 0xFF, 0xFF));
        FollowButton.IsVisible = !follow;
    }

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
        PlayheadMoved?.Invoke(t);
        UpdateTimeText();
    }

    private void OnScrub(object? sender, RangeBaseValueChangedEventArgs e)
    {
        PlayheadMoved?.Invoke(e.NewValue);
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

    private void UpdateTimeText() => TimeText.Text = $"{Ui.Time(Scrubber.Value)} / {Ui.Time(_vm.Duration)}";

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

    // ------------------------------------------------------------- pointing at a spot in the frame

    /// <summary>Where the picture sits inside the screen (it is letterboxed to keep its shape), or null when none is shown.</summary>
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
        Spot = new Spot(Math.Round((p.X - r.Left) / r.Width, 3), Math.Round((p.Y - r.Top) / r.Height, 3), Math.Round(Scrubber.Value, 2));
        PlaceMarker();
        SpotChanged?.Invoke(Spot);
    }

    private void OnViewerResized(object? sender, SizeChangedEventArgs e) => PlaceMarker();

    /// <summary>Keep the marker on its spot in the picture (it moves with resizing and hides on the overview).</summary>
    private void PlaceMarker()
    {
        if (Spot is null || !_pointable || PictureRect() is not { } r)
        {
            SpotMarker.IsVisible = false;
            return;
        }
        Canvas.SetLeft(SpotMarker, r.Left + Spot.X * r.Width - SpotMarker.Width / 2);
        Canvas.SetTop(SpotMarker, r.Top + Spot.Y * r.Height - SpotMarker.Height / 2);
        SpotMarker.IsVisible = true;
    }
}
