using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using VideoEditor.Engine;
using VideoEditor.Shared;

namespace VideoEditor.Setup;

/// <summary>
/// Shown on the first start, before the main window, like a speed test: the host renders a test
/// video on the processor (FFmpeg) and on the graphics card (the GPU render engine), the gauge shows
/// the render speed live, the pictures are compared, and the faster renderer that works becomes the
/// default. The host keeps the result, so this runs once.
/// </summary>
public partial class PerformanceWindow : Window
{
    private readonly EngineClient? _engine;
    private readonly TaskCompletionSource _finished = new();
    /// <summary>Eases the gauge and the number toward the latest measurement.</summary>
    private readonly DispatcherTimer _animation = new() { Interval = TimeSpan.FromMilliseconds(33) };
    private readonly Stopwatch _stageClock = new();
    private string? _stage;
    private double _target;
    private double _shown;

    /// <summary>Completes when the person continues to the app.</summary>
    public Task Finished => _finished.Task;

    public PerformanceWindow() : this(null) { }

    public PerformanceWindow(EngineClient? engine)
    {
        _engine = engine;
        InitializeComponent();
        _animation.Tick += (_, _) => Animate();
        // No title bar: the window moves from anywhere on it.
        PointerPressed += (_, e) =>
        {
            if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed && e.Source is not Button) BeginMoveDrag(e);
        };
        if (engine is null) return;
        engine.Notification += OnNotification;
        Opened += async (_, _) => await RunAsync();
        Closed += (_, _) =>
        {
            engine.Notification -= OnNotification;
            _animation.Stop();
        };
    }

    private static string Fps(double v) => v.ToString(v < 10 ? "0.0" : "0", CultureInfo.InvariantCulture);

    private void Animate()
    {
        _shown += (_target - _shown) * 0.18;
        if (Math.Abs(_target - _shown) < 0.05) _shown = _target;
        // The scale grows when a renderer goes past it, so the arc never pins at the end.
        while (_shown > Gauge.Maximum * 0.95) Gauge.Maximum += 30;
        Gauge.Value = _shown;
        Speed.Text = Fps(_shown);
    }

    private void OnNotification(string method, JsonNode? p)
    {
        if (method != "performance.progress" || p is null) return;
        var stage = p["stage"]?.GetValue<string>();
        var stageProgress = p["stageProgress"]?.GetValue<double>() ?? 0;
        var frames = p["frames"]?.GetValue<double>() ?? 0;
        var frameRate = p["frameRate"]?.GetValue<double>() ?? 30;
        var adapter = p["adapter"]?["adapter"]?.GetValue<string>();
        Dispatcher.UIThread.Post(() =>
        {
            Gauge.Mark = frameRate;
            if (stage != _stage)
            {
                _stage = stage;
                _stageClock.Restart();
                if (stage is "ffmpeg" or "engine") _target = 0;
            }
            Status.Text = stage switch
            {
                "media" => "Preparing the test video",
                "ffmpeg" => "Rendering on the processor",
                "engine" => adapter is null ? "Rendering on the graphics card" : $"Rendering on the graphics card ({adapter})",
                "compare" => "Comparing the pictures",
                _ => Status.Text,
            };
            // Frames made so far over the time taken: a live speed, settling as the render goes on.
            var seconds = _stageClock.Elapsed.TotalSeconds;
            if (stage is "ffmpeg" or "engine" && stageProgress > 0.05 && seconds > 0.3)
            {
                _target = stageProgress * frames / seconds;
                var value = stage == "ffmpeg" ? CpuValue : GpuValue;
                value.Text = $"{Fps(_target)} fps";
                value.Foreground = this.Brush("Muted");
            }
        });
    }

    private async Task RunAsync()
    {
        _stage = null;
        _target = _shown = 0;
        Speed.Foreground = this.Brush("Muted");
        foreach (var v in new[] { CpuValue, GpuValue, MatchValue })
        {
            v.Text = "--";
            v.Foreground = this.Brush("Faint");
        }
        Status.Text = "Preparing the test video";
        Reason.IsVisible = Machine.IsVisible = false;
        ContinueButton.IsEnabled = false;
        _animation.Start();
        try
        {
            ShowReport(await _engine!.CallAsync("performance.run"));
        }
        catch (Exception e)
        {
            _target = 0;
            Status.Text = "The test could not finish";
            Reason.Text = $"{e.Message} Videos render on the processor; the test runs again at the next start.";
            Reason.IsVisible = true;
        }
        finally
        {
            ContinueButton.IsEnabled = true;
            ContinueButton.Focus();
        }
    }

    private void ShowReport(JsonNode? report)
    {
        var results = (report?["results"]?.AsArray() ?? []).Where(r => r is not null).ToDictionary(r => r!["renderer"]!.GetValue<string>(), r => r!);
        var choice = report?["choice"]?.GetValue<string>() ?? "ffmpeg";
        double? FpsOf(string key) => results.GetValueOrDefault(key)?["fps"]?.GetValue<double>();

        void Show(TextBlock value, string key)
        {
            var fps = FpsOf(key);
            value.Text = fps is { } f ? $"{Fps(f)} fps" : "Not usable";
            value.Foreground = this.Brush(key == choice ? "Accent" : "Text");
        }
        Show(CpuValue, "ffmpeg");
        Show(GpuValue, "engine");

        var gpu = results.GetValueOrDefault("engine");
        if (gpu?["deltaE"]?.GetValue<double>() is { } deltaE)
        {
            var same = gpu["ok"]!.GetValue<bool>();
            MatchValue.Text = same ? "Matches" : "Differs";
            MatchValue.Foreground = this.Brush("Text");
            ToolTip.SetTip(MatchValue, $"Mean color difference ΔE {deltaE.ToString("0.00", CultureInfo.InvariantCulture)} over 5 frames (under 1 is invisible)");
        }
        else
        {
            MatchValue.Text = "Not tested";
            MatchValue.Foreground = this.Brush("Muted");
        }

        // The big number settles on the chosen renderer's speed.
        _target = FpsOf(choice) ?? 0;
        Speed.Foreground = this.Brush("Text");
        Status.Text = choice == "engine" ? "Videos will render on the graphics card" : "Videos will render on the processor";
        Reason.Text = report?["reason"]?.GetValue<string>() ?? "";
        Reason.IsVisible = Reason.Text.Length > 0;

        if (report?["adapter"] is { } adapter)
        {
            var api = adapter["backend"]?.GetValue<string>() switch { "Dx12" => "Direct3D 12", "Gl" => "OpenGL", var b => b ?? "" };
            Machine.Text = $"{adapter["adapter"]?.GetValue<string>()}  |  {api}  |  {Environment.ProcessorCount} CPU threads";
            Machine.IsVisible = true;
        }
    }

    private void OnContinue(object? sender, RoutedEventArgs e) => _finished.TrySetResult();
}
