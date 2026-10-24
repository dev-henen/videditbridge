using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace VideoEditor.Controls;

/// <summary>
/// Monochrome timeline. Compact (default): a slim strip of clips with hairline marks for overlays
/// and audio, enough to see structure and scrub. Expanded: ruler plus one lane per track.
/// Click or drag to seek.
/// </summary>
public sealed class TimelineView : FrameworkElement
{
    private enum Kind { Clip, Text, Media, Shape, Audio, Caption }
    private sealed record Block(double Start, double End, string Label, Kind Kind, double TransitionIn = 0);
    private sealed record Lane(string Name, List<Block> Blocks);

    private readonly List<Block> _clips = [];
    private readonly List<Block> _layers = [];
    private readonly List<Block> _audio = [];
    private readonly List<Block> _captions = [];
    private readonly List<Lane> _lanes = [];
    private double _duration;
    private double _playhead;
    private bool _compact = true;

    private const double RulerHeight = 16;
    private const double LaneHeight = 20;

    private static readonly Brush ClipFill = Freeze(new SolidColorBrush(Color.FromRgb(0x4A, 0x4A, 0x4A)));
    private static readonly Brush ClipFillAlt = Freeze(new SolidColorBrush(Color.FromRgb(0x3E, 0x3E, 0x3E)));
    private static readonly Brush TextFill = Freeze(new SolidColorBrush(Color.FromRgb(0xB8, 0xB8, 0xB8)));
    private static readonly Brush MediaFill = Freeze(new SolidColorBrush(Color.FromRgb(0x7A, 0x7A, 0x7A)));
    private static readonly Brush ShapeFill = Freeze(new SolidColorBrush(Color.FromRgb(0x5E, 0x5E, 0x5E)));
    private static readonly Brush AudioFill = Freeze(new SolidColorBrush(Color.FromRgb(0x35, 0x35, 0x35)));
    private static readonly Brush CaptionFill = Freeze(new SolidColorBrush(Color.FromRgb(0x2E, 0x2E, 0x2E)));
    private static readonly Brush LabelText = Freeze(new SolidColorBrush(Color.FromRgb(0xE6, 0xE6, 0xE6)));
    private static readonly Brush DarkText = Freeze(new SolidColorBrush(Color.FromRgb(0x14, 0x14, 0x14)));
    private static readonly Brush Muted = Freeze(new SolidColorBrush(Color.FromRgb(0x6E, 0x6E, 0x6E)));
    private static readonly Brush Hatch = Freeze(new SolidColorBrush(Color.FromArgb(0x40, 0xFF, 0xFF, 0xFF)));
    private static readonly Pen LinePen = Freeze(new Pen(Freeze(new SolidColorBrush(Color.FromRgb(0x24, 0x24, 0x24))), 1));
    private static readonly Pen PlayheadPen = Freeze(new Pen(Brushes.White, 1.5));
    private static readonly Typeface Face = new("Segoe UI");

    public event Action<double>? Seek;

    public bool Compact
    {
        get => _compact;
        set { _compact = value; Rebuild(); }
    }

    public double Playhead
    {
        get => _playhead;
        set { _playhead = value; InvalidateVisual(); }
    }

    private double LabelWidth => _compact ? 0 : 64;

    public void Update(JsonNode? state)
    {
        _clips.Clear();
        _layers.Clear();
        _audio.Clear();
        _captions.Clear();
        _duration = state?["duration"]?.GetValue<double>() ?? 0;
        if (state is not null)
        {
            foreach (var c in state["clips"]?.AsArray() ?? [])
            {
                if (c is null) continue;
                var label = c["label"]?.GetValue<string>() ?? c["assetId"]?.GetValue<string>() ?? "";
                _clips.Add(new Block(c["start"]!.GetValue<double>(), c["end"]!.GetValue<double>(), label, Kind.Clip, c["transition"]?["duration"]?.GetValue<double>() ?? 0));
            }
            foreach (var l in state["layers"]?.AsArray() ?? [])
            {
                if (l is null) continue;
                var kind = l["type"]?.GetValue<string>() switch { "text" => Kind.Text, "media" => Kind.Media, _ => Kind.Shape };
                _layers.Add(new Block(l["start"]!.GetValue<double>(), l["end"]!.GetValue<double>(), l["label"]?.GetValue<string>() ?? "", kind));
            }
            foreach (var a in state["audio"]?.AsArray() ?? [])
                if (a is not null)
                    _audio.Add(new Block(a["start"]!.GetValue<double>(), a["end"]!.GetValue<double>(), $"{a["role"]?.GetValue<string>()} · {a["assetId"]?.GetValue<string>()}", Kind.Audio));
            foreach (var c in state["captions"]?.AsArray() ?? [])
                if (c is not null)
                    _captions.Add(new Block(c["start"]!.GetValue<double>(), c["end"]!.GetValue<double>(), c["text"]?.GetValue<string>() ?? "", Kind.Caption));
        }
        Rebuild();
    }

    private void Rebuild()
    {
        _lanes.Clear();
        _lanes.Add(new Lane("Video", _clips));
        AddPacked("Layers", _layers);
        AddPacked("Audio", _audio);
        if (_captions.Count > 0) _lanes.Add(new Lane("Captions", _captions));
        InvalidateMeasure();
        InvalidateVisual();
    }

    private void AddPacked(string name, IEnumerable<Block> blocks)
    {
        var packed = new List<List<Block>>();
        foreach (var b in blocks.OrderBy(b => b.Start))
        {
            var lane = packed.FirstOrDefault(l => l[^1].End <= b.Start + 0.001);
            if (lane is null) packed.Add(lane = []);
            lane.Add(b);
        }
        for (var i = 0; i < packed.Count; i++) _lanes.Add(new Lane(i == 0 ? name : "", packed[i]));
    }

    // Compact layout: clip strip + overlay marks + audio marks.
    private const double CompactClip = 18, CompactMark = 3, CompactGap = 2;
    private double CompactHeight => CompactClip + CompactGap + CompactMark + CompactGap + CompactMark + 2;

    protected override Size MeasureOverride(Size available)
    {
        var w = double.IsInfinity(available.Width) ? 600 : available.Width;
        return new Size(w, _compact ? CompactHeight : RulerHeight + Math.Max(1, _lanes.Count) * LaneHeight + 2);
    }

    private double TimeToX(double t) => LabelWidth + (_duration <= 0 ? 0 : t / _duration * Math.Max(1, ActualWidth - LabelWidth - 2));

    protected override void OnRender(DrawingContext dc)
    {
        dc.DrawRectangle(Brushes.Transparent, null, new Rect(0, 0, ActualWidth, ActualHeight));
        var dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        if (_duration <= 0)
        {
            dc.DrawText(Text("Timeline", 10, Muted, dpi), new Point(LabelWidth + 4, 3));
            return;
        }
        if (_compact) RenderCompact(dc, dpi);
        else RenderLanes(dc, dpi);

        var px = TimeToX(Math.Clamp(_playhead, 0, _duration));
        dc.DrawLine(PlayheadPen, new Point(px, 0), new Point(px, ActualHeight));
    }

    private void RenderCompact(DrawingContext dc, double dpi)
    {
        for (var i = 0; i < _clips.Count; i++)
            DrawBlock(dc, dpi, _clips[i], 0, CompactClip, i % 2 == 0 ? ClipFill : ClipFillAlt, withLabel: true);
        var y = CompactClip + CompactGap;
        foreach (var b in _layers) DrawBlock(dc, dpi, b, y, CompactMark, FillFor(b.Kind), withLabel: false);
        y += CompactMark + CompactGap;
        foreach (var b in _audio) DrawBlock(dc, dpi, b, y, CompactMark, MediaFill, withLabel: false);
    }

    private void RenderLanes(DrawingContext dc, double dpi)
    {
        var step = _duration > 300 ? 60 : _duration > 120 ? 30 : _duration > 40 ? 10 : _duration > 15 ? 5 : 1;
        for (double t = 0; t <= _duration + 0.001; t += step)
        {
            var ft = Text($"{(int)t / 60:00}:{(int)t % 60:00}", 9, Muted, dpi);
            dc.DrawText(ft, new Point(Math.Min(TimeToX(t) - ft.Width / 2, ActualWidth - ft.Width), 1));
        }
        for (var i = 0; i < _lanes.Count; i++)
        {
            var y = RulerHeight + i * LaneHeight;
            var lane = _lanes[i];
            if (lane.Name.Length > 0)
            {
                var ft = Text(lane.Name, 10, Muted, dpi);
                dc.DrawText(ft, new Point(LabelWidth - ft.Width - 8, y + 4));
            }
            var alt = 0;
            foreach (var b in lane.Blocks)
                DrawBlock(dc, dpi, b, y + 2, LaneHeight - 4, b.Kind == Kind.Clip ? (alt++ % 2 == 0 ? ClipFill : ClipFillAlt) : FillFor(b.Kind), withLabel: true);
            dc.DrawLine(LinePen, new Point(LabelWidth, y + LaneHeight), new Point(ActualWidth, y + LaneHeight));
        }
    }

    private void DrawBlock(DrawingContext dc, double dpi, Block b, double y, double h, Brush fill, bool withLabel)
    {
        var x0 = TimeToX(b.Start);
        var w = Math.Max(1.5, TimeToX(b.End) - x0 - 1);
        var rect = new Rect(x0, y, w, h);
        dc.DrawRoundedRectangle(fill, null, rect, Math.Min(3, h / 2), Math.Min(3, h / 2));
        if (b.TransitionIn > 0)
            dc.DrawRectangle(Hatch, null, new Rect(x0, y, Math.Min(w, TimeToX(b.Start + b.TransitionIn) - x0), h));
        if (!withLabel || w < 28 || h < 12) return;
        var ft = Text(b.Label, 10, b.Kind == Kind.Text ? DarkText : LabelText, dpi);
        ft.MaxTextWidth = Math.Max(1, w - 8);
        ft.MaxLineCount = 1;
        ft.Trimming = TextTrimming.CharacterEllipsis;
        dc.PushClip(new RectangleGeometry(rect));
        dc.DrawText(ft, new Point(x0 + 4, y + (h - ft.Height) / 2));
        dc.Pop();
    }

    private static Brush FillFor(Kind k) => k switch
    {
        Kind.Text => TextFill,
        Kind.Media => MediaFill,
        Kind.Shape => ShapeFill,
        Kind.Audio => AudioFill,
        Kind.Caption => CaptionFill,
        _ => ClipFill,
    };

    private static FormattedText Text(string s, double size, Brush brush, double dpi) =>
        new(s, CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, Face, size, brush, dpi);

    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        CaptureMouse();
        SeekTo(e.GetPosition(this).X);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (IsMouseCaptured) SeekTo(e.GetPosition(this).X);
    }

    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e) => ReleaseMouseCapture();

    private void SeekTo(double x)
    {
        if (_duration <= 0 || x < LabelWidth) return;
        var t = Math.Clamp((x - LabelWidth) / Math.Max(1, ActualWidth - LabelWidth - 2) * _duration, 0, _duration);
        Playhead = t;
        Seek?.Invoke(t);
    }

    private static T Freeze<T>(T f) where T : Freezable { f.Freeze(); return f; }
}
