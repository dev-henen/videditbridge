using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Threading;
using LibVLCSharp.Shared;

namespace VideoEditor.Preview;

/// <summary>
/// LibVLC, started once on first use. Windows and macOS ship VLC's libraries with the app; Linux
/// uses the system's libvlc (the vlc package).
/// </summary>
public static class Vlc
{
    private static LibVLC? _instance;
    private static string? _error;

    /// <summary>The shared LibVLC, or null when it cannot load (see <see cref="Error"/>).</summary>
    public static LibVLC? Instance
    {
        get
        {
            if (_instance is not null || _error is not null) return _instance;
            try
            {
                Core.Initialize();
                _instance = new LibVLC("--no-video-title-show", "--quiet", "--no-osd");
            }
            catch (Exception e)
            {
                _error = OperatingSystem.IsLinux()
                    ? "Video playback needs VLC. Install the vlc package (for example: sudo apt install vlc), then restart."
                    : $"Video playback is unavailable: {e.Message}";
            }
            return _instance;
        }
    }

    public static string? Error => Instance is null ? _error : null;
}

/// <summary>
/// Plays a video into a bitmap the viewer shows like any image. LibVLC decodes into a buffer
/// (RV32) on its own thread; each new frame is copied into <see cref="Frame"/> on the UI thread.
/// Drawing frames ourselves, rather than in a native video window, keeps overlays (the spot marker)
/// on top of the picture on every system.
/// </summary>
public sealed class VideoPlayer : IDisposable
{
    private readonly LibVLC _vlc;
    private readonly MediaPlayer _player;
    private readonly object _lock = new();
    private IntPtr _buffer;
    private byte[] _back = [];
    private int _width, _height;
    private bool _frameQueued;
    private bool _ended;

    /// <summary>The latest frame; replaced when the size changes.</summary>
    public WriteableBitmap? Frame { get; private set; }

    public PixelSize VideoSize => new(_width, _height);
    public bool IsPlaying => _player.IsPlaying;
    public bool IsLoaded { get; private set; }

    /// <summary>Raised on the UI thread after <see cref="Frame"/> has new pixels (the bitmap object may be new).</summary>
    public event Action? FrameReady;
    public event Action? Opened;
    public event Action? Ended;

    public VideoPlayer(LibVLC vlc)
    {
        _vlc = vlc;
        _player = new MediaPlayer(vlc);
        _player.SetVideoFormatCallbacks(OnFormat, OnCleanup);
        _player.SetVideoCallbacks(OnLock, null, OnDisplay);
        // LibVLC events arrive on its threads, and calling the player from them can deadlock.
        _player.EndReached += (_, _) => Dispatcher.UIThread.Post(() =>
        {
            _ended = true;
            Ended?.Invoke();
        });
        _player.Playing += (_, _) => Dispatcher.UIThread.Post(() =>
        {
            if (IsLoaded) return;
            IsLoaded = true;
            Opened?.Invoke();
        });
    }

    public void Open(string path)
    {
        IsLoaded = false;
        _ended = false;
        using var media = new LibVLCSharp.Shared.Media(_vlc, new Uri(path));
        _player.Media = media;
        _player.Play();
    }

    public void Play()
    {
        if (_ended)
        {
            // A finished media restarts from the beginning.
            _ended = false;
            _player.Stop();
        }
        _player.Play();
    }

    public void Pause()
    {
        if (_player.IsPlaying) _player.SetPause(true);
    }

    public void Stop()
    {
        _player.Stop();
        IsLoaded = false;
        _ended = false;
    }

    /// <summary>Position in seconds.</summary>
    public double Position
    {
        get => Math.Max(0, _player.Time / 1000.0);
        set
        {
            if (_ended) { _ended = false; _player.Stop(); _player.Play(); _player.SetPause(true); }
            _player.Time = (long)(value * 1000);
        }
    }

    public double Duration => Math.Max(0, _player.Length / 1000.0);

    private uint OnFormat(ref IntPtr opaque, IntPtr chroma, ref uint width, ref uint height, ref uint pitches, ref uint lines)
    {
        Marshal.Copy("RV32"u8.ToArray(), 0, chroma, 4);
        pitches = width * 4;
        lines = height;
        lock (_lock)
        {
            if (_buffer != IntPtr.Zero) Marshal.FreeHGlobal(_buffer);
            _buffer = Marshal.AllocHGlobal((int)(pitches * lines));
            _back = new byte[pitches * lines];
            _width = (int)width;
            _height = (int)height;
        }
        return 1;
    }

    private void OnCleanup(ref IntPtr opaque)
    {
        lock (_lock)
        {
            if (_buffer != IntPtr.Zero) Marshal.FreeHGlobal(_buffer);
            _buffer = IntPtr.Zero;
        }
    }

    private IntPtr OnLock(IntPtr opaque, IntPtr planes)
    {
        Marshal.WriteIntPtr(planes, _buffer);
        return IntPtr.Zero;
    }

    private void OnDisplay(IntPtr opaque, IntPtr picture)
    {
        lock (_lock)
        {
            if (_buffer == IntPtr.Zero) return;
            Marshal.Copy(_buffer, _back, 0, _back.Length);
            if (_frameQueued) return;
            _frameQueued = true;
        }
        // One pending copy at a time: if the UI is busy, frames in between are skipped.
        Dispatcher.UIThread.Post(CopyFrame, DispatcherPriority.Render);
    }

    private void CopyFrame()
    {
        lock (_lock)
        {
            _frameQueued = false;
            if (_width == 0 || _height == 0 || _back.Length < _width * _height * 4) return;
            if (Frame is null || Frame.PixelSize.Width != _width || Frame.PixelSize.Height != _height)
                Frame = new WriteableBitmap(new PixelSize(_width, _height), new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.Opaque);
            using var fb = Frame.Lock();
            if (fb.RowBytes == _width * 4) Marshal.Copy(_back, 0, fb.Address, _width * _height * 4);
            else
                for (var y = 0; y < _height; y++) Marshal.Copy(_back, y * _width * 4, fb.Address + y * fb.RowBytes, _width * 4);
        }
        FrameReady?.Invoke();
    }

    public void Dispose()
    {
        _player.Stop();
        _player.Dispose();
        var none = IntPtr.Zero;
        OnCleanup(ref none);
    }
}

/// <summary>Plays sound files (voice and music options Claude offers), one at a time.</summary>
public sealed class AudioPlayer : IDisposable
{
    private readonly LibVLC _vlc;
    private readonly MediaPlayer _player;

    /// <summary>Raised on the UI thread when a sound finishes.</summary>
    public event Action? Ended;

    public AudioPlayer(LibVLC vlc)
    {
        _vlc = vlc;
        _player = new MediaPlayer(vlc);
        _player.EndReached += (_, _) => Dispatcher.UIThread.Post(() => Ended?.Invoke());
    }

    public void Play(string path, double start = 0)
    {
        using var media = new LibVLCSharp.Shared.Media(_vlc, new Uri(path));
        if (start > 0) media.AddOption($":start-time={start.ToString(System.Globalization.CultureInfo.InvariantCulture)}");
        _player.Media = media;
        _player.Play();
    }

    public void Stop() => _player.Stop();

    public void Dispose()
    {
        _player.Stop();
        _player.Dispose();
    }
}
