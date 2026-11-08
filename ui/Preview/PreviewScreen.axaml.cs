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
    private ProjectViewModel _vm = null!;
    private bool _follow = true;
    private bool _settingScrubber;
    private string? _shownRender;
    private string? _shownRevision;
    private VideoPlayer? _player;
    private bool _videoShown;
    private bool _playing;
    private Bitmap? _image;
    // Frames from the render engine's shared memory, drawn into one bitmap reused while its size holds.
    private readonly SharedFrameReader _sharedReader = new();
    private WriteableBitmap? _live;
    // Live playback on the render engine: frames arrive as notifications, the sound plays alongside.
    private bool _livePlaying;
    private AudioPlayer? _audio;
    // The screen shows one frame of the edit (a frame or a video, not the overview grid), so a click can point at a spot.
    private bool _pointable;
    // The overlay (matte or outline) for the frame shown; a newer request supersedes an older one.
    private int _overlayToken;

    /// <summary>The clip picked on the timeline, whose mask the matte shows (else the clip at the playhead).</summary>
    public Func<string?>? MatteTarget { get; set; }

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

    public void Attach(ProjectViewModel vm)
    {
        _vm = vm;
        _vm.ProjectChanged += Reset;
        _vm.StateUpdated += OnState;
        _vm.LiveFrame += OnLiveFrame;
        _vm.LiveEnded += OnLiveEnded;
        // The project is open before its tab is built: show what it has now.
        Reset();
        if (_vm.State is { } s) OnState(s);
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

    /// <summary>Stop playing (the tab was put in the background); the picture stays.</summary>
    public void Pause()
    {
        if (_livePlaying)
        {
            _ = StopLive();
            return;
        }
        if (!_playing || _player is null) return;
        _player.Pause();
        _playing = false;
        PlayIcon.Text = Icons.Play;
    }

    public void Dispose()
    {
        _player?.Dispose();
        _audio?.Dispose();
        _sharedReader.Dispose();
    }

    // ------------------------------------------------------------- live output

    private void OnState(JsonNode state)
    {
        UpdateTimeText();
        // A/B is offered once Claude changed the edit since the latest request started.
        var canCompare = state["canCompare"]?.GetValue<bool>() == true;
        BeforeButton.IsVisible = canCompare;
        if (!canCompare) BeforeButton.IsChecked = false;
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
                HideOverlay();
                break;
            default:
                var t = render["time"]?.GetValue<double>();
                ShowImage(path, t is null ? "Frame" : $"Frame at {t:0.0}s");
                if (t is not null) SetScrubber(t.Value, fromUser: false);
                if (t is not null) _ = RefreshOverlay(t.Value);
                else HideOverlay();
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
            _live = null;
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
        HideOverlay();
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
        HideOverlay();
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
        var before = BeforeButton.IsChecked == true;
        var frame = await _vm.ScrubAsync(t, before);
        if (frame is null) return;
        // Ignore stale answers if the user kept scrubbing, a new render took over or A/B flipped.
        if (Math.Abs(Scrubber.Value - time) > 0.01 && !_follow) return;
        if (before != (BeforeButton.IsChecked == true)) return;
        var caption = before ? $"Before your last request, at {t:0.0}s" : $"Frame at {t:0.0}s";
        if (frame.Shared is not null) ShowShared(frame, caption);
        else if (frame.Path is not null) ShowImage(frame.Path, caption);
        _ = RefreshOverlay(t);
    }

    /// <summary>A/B: flip the frame at the playhead between the edit now and before the latest request.</summary>
    private async void OnBefore(object? sender, RoutedEventArgs e)
    {
        SetFollow(false);
        _scrubDebounce.Stop();
        await ShowFrameAt(Scrubber.Value);
    }

    /// <summary>
    /// Show a frame the render engine wrote into shared memory: its pixels are copied into the
    /// bitmap already on screen, with no picture file in between.
    /// </summary>
    private void ShowShared(ScrubFrame frame, string caption)
    {
        StopVideo();
        var bmp = _sharedReader.Read(frame.Shared!, frame.Width, frame.Height, _live);
        if (bmp is null) return;
        if (!ReferenceEquals(bmp, _image))
        {
            var old = _image;
            _image = bmp;
            old?.Dispose();
        }
        _live = bmp;
        _pointable = true;
        FrameImage.Source = bmp;
        FrameImage.InvalidateVisual();
        FrameImage.IsVisible = true;
        ViewerEmpty.IsVisible = false;
        ViewerCaption.Text = caption;
        PlaceMarker();
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
        if (_livePlaying) _ = StopLive();
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
        if (_livePlaying)
        {
            await StopLive();
            return;
        }
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
        // No video loaded: play live on the render engine from the playhead, with the edit's sound.
        var from = Scrubber.Value >= _vm.Duration - 0.05 ? 0 : Scrubber.Value;
        _livePlaying = true;
        PlayIcon.Text = Icons.Pause;
        var (live, audio) = await _vm.PlayLiveAsync(from);
        if (live)
        {
            if (!_livePlaying) return; // paused while it started
            SetFollow(false);
            BeforeButton.IsChecked = false;
            if (audio is not null && Vlc.Instance is { } vlc)
            {
                _audio ??= new AudioPlayer(vlc);
                _audio.Play(audio, from);
            }
            return;
        }
        _livePlaying = false;
        PlayIcon.Text = Icons.Play;
        // Otherwise play the latest preview video, or render one.
        var preview = _vm.State?["renders"]?.AsArray().FirstOrDefault(r => r?["kind"]?.GetValue<string>() is "preview" or "video" && r["stale"]?.GetValue<bool>() != true);
        SetFollow(true);
        if (preview is not null) ShowRender(preview);
        else await _vm.RenderPreviewAsync();
    }

    // ------------------------------------------------------------- live playback on the render engine

    private void OnLiveFrame(ScrubFrame frame, double time)
    {
        if (!_livePlaying) return;
        HideOverlay();
        ShowShared(frame, $"Playing at {time:0.0}s");
        SetScrubber(time, fromUser: false);
    }

    private void OnLiveEnded()
    {
        if (!_livePlaying) return;
        _livePlaying = false;
        PlayIcon.Text = Icons.Play;
        _audio?.Stop();
    }

    private async Task StopLive()
    {
        _livePlaying = false;
        PlayIcon.Text = Icons.Play;
        _audio?.Stop();
        await _vm.StopLiveAsync();
    }

    // ------------------------------------------------------------- matte and object outline

    private void OnOverlayToggle(object? sender, RoutedEventArgs e)
    {
        // One overlay at a time: the matte replaces the picture, the outline goes over it.
        if (ReferenceEquals(sender, MatteButton) && MatteButton.IsChecked == true) OutlineButton.IsChecked = false;
        if (ReferenceEquals(sender, OutlineButton) && OutlineButton.IsChecked == true) MatteButton.IsChecked = false;
        _ = RefreshOverlay(Scrubber.Value);
    }

    private void HideOverlay()
    {
        _overlayToken++;
        OverlayImage.IsVisible = false;
    }

    /// <summary>
    /// Lay the matte (white on black, in place of the picture) or the outline of the object Claude
    /// selected (in the accent color, over the picture) on the still frame at `time`.
    /// </summary>
    private async Task RefreshOverlay(double time)
    {
        var token = ++_overlayToken;
        var matte = MatteButton.IsChecked == true;
        var outline = !matte && OutlineButton.IsChecked == true && _vm.HasObjects;
        if (!(matte || outline) || _videoShown || _livePlaying || !_pointable)
        {
            // Turned off: the caption says what the picture is again.
            if (OverlayImage.IsVisible && !_videoShown && !_livePlaying) ViewerCaption.Text = $"Frame at {time:0.0}s";
            OverlayImage.IsVisible = false;
            return;
        }
        var m = await _vm.MatteAsync(time, matte ? MatteTarget?.Invoke() : null, objectOnly: !matte);
        if (token != _overlayToken) return; // superseded by a newer frame or toggle
        if (m?.Path is null)
        {
            OverlayImage.IsVisible = false;
            if (matte) ViewerCaption.Text = m?.Reason ?? "No mask here";
            return;
        }
        try
        {
            Bitmap bmp;
            using (var s = File.OpenRead(m.Path)) bmp = new Bitmap(s);
            IImage shown = bmp;
            if (!matte)
            {
                var accent = (this.Brush("Accent") as ISolidColorBrush)?.Color ?? Color.FromRgb(0x3B, 0x82, 0xF6);
                shown = MatteOutline.From(bmp, accent);
                bmp.Dispose();
            }
            var old = OverlayImage.Source as IDisposable;
            OverlayImage.Source = shown;
            old?.Dispose();
            OverlayImage.IsVisible = true;
            ViewerCaption.Text = matte ? $"Matte of {m.Label} at {time:0.0}s (white is selected)" : $"Object {m.Label} at {time:0.0}s";
        }
        catch
        {
            OverlayImage.IsVisible = false;
        }
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
