using System.Globalization;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Controls.Documents;
using Avalonia.Media;
using Avalonia.Media.Immutable;

namespace VideoEditor.Timeline;

/// <summary>A clip, layer or sound picked on the timeline, so a request to Claude can be about it.</summary>
public sealed record TimelineItem(string Kind, string Id, string Label, double Start, double End);

/// <summary>
/// The timeline. Compact (default): a slim strip of clips with hairline marks for overlays and
/// audio, enough to see structure and scrub. Expanded: ruler plus one lane per track.
/// The app is AI-first, so the timeline does not edit: click an item to point Claude at it (and
/// seek there), click empty space or drag to seek, Escape to clear the pick.
/// </summary>
public sealed class TimelineView : Control
{
    private enum Kind { Clip, Text, Media, Shape, Audio, Caption }
    private sealed record Block(double Start, double End, string Label, Kind Kind, double TransitionIn = 0, string? Id = null);
    private sealed record Lane(string Name, List<Block> Blocks);

    private readonly List<Block> _clips = [];
    private readonly List<Block> _layers = [];
    private readonly List<Block> _audio = [];
    private readonly List<Block> _captions = [];
    private readonly List<Lane> _lanes = [];
    private readonly List<(Rect Rect, Block Block)> _hits = [];
    private double _duration;
    private double _playhead;
    private bool _compact = true;
    private bool _dragging;
    private string? _selectedId;
    private Block? _hover;

    private const double RulerHeight = 16;
    private const double LaneHeight = 20;

    private static readonly IBrush ClipFill = new SolidColorBrush(Color.FromRgb(0x4A, 0x4A, 0x4A)).ToImmutable();
    private static readonly IBrush ClipFillAlt = new SolidColorBrush(Color.FromRgb(0x3E, 0x3E, 0x3E)).ToImmutable();
    private static readonly IBrush TextFill = new SolidColorBrush(Color.FromRgb(0xB8, 0xB8, 0xB8)).ToImmutable();
    private static readonly IBrush MediaFill = new SolidColorBrush(Color.FromRgb(0x7A, 0x7A, 0x7A)).ToImmutable();
    private static readonly IBrush ShapeFill = new SolidColorBrush(Color.FromRgb(0x5E, 0x5E, 0x5E)).ToImmutable();
    private static readonly IBrush AudioFill = new SolidColorBrush(Color.FromRgb(0x35, 0x35, 0x35)).ToImmutable();
    private static readonly IBrush CaptionFill = new SolidColorBrush(Color.FromRgb(0x2E, 0x2E, 0x2E)).ToImmutable();
    private static readonly IBrush LabelText = new SolidColorBrush(Color.FromRgb(0xE6, 0xE6, 0xE6)).ToImmutable();
    private static readonly IBrush DarkText = new SolidColorBrush(Color.FromRgb(0x14, 0x14, 0x14)).ToImmutable();
    private static readonly IBrush Muted = new SolidColorBrush(Color.FromRgb(0x6E, 0x6E, 0x6E)).ToImmutable();
    private static readonly IBrush Hatch = new SolidColorBrush(Color.FromArgb(0x40, 0xFF, 0xFF, 0xFF)).ToImmutable();
    // Blue is the app's primary color: the playhead and the picked item.
    private static readonly IBrush Blue = new SolidColorBrush(Color.FromRgb(0x3B, 0x82, 0xF6)).ToImmutable();
    private static readonly IBrush BlueSoft = new SolidColorBrush(Color.FromArgb(0x40, 0x3B, 0x82, 0xF6)).ToImmutable();
    private static readonly IPen LinePen = new ImmutablePen(new SolidColorBrush(Color.FromRgb(0x24, 0x24, 0x24)).ToImmutable(), 1);
    private static readonly IPen PlayheadPen = new ImmutablePen((ImmutableSolidColorBrush)Blue, 1.5);
    private static readonly IPen SelectPen = new ImmutablePen((ImmutableSolidColorBrush)Blue, 1.5);

    public event Action<double>? Seek;

    /// <summary>The picked item changed (null when cleared or when it left the edit).</summary>
    public event Action<TimelineItem?>? SelectionChanged;

    public TimelineView()
    {
        Focusable = true;
        ClipToBounds = true;
    }

    private Typeface Face => new(TextElement.GetFontFamily(this));

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

    /// <summary>The picked item, while it still exists in the edit.</summary>
    public TimelineItem? Selected
    {
        get
        {
            var b = _clips.Concat(_layers).Concat(_audio).FirstOrDefault(x => x.Id is not null && x.Id == _selectedId);
            return b is null ? null : new TimelineItem(KindName(b.Kind), b.Id!, b.Label, b.Start, b.End);
        }
    }

    /// <summary>Clear the picked item.</summary>
    public void ClearSelection() => Select(null);

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
                _clips.Add(new Block(c["start"]!.GetValue<double>(), c["end"]!.GetValue<double>(), label, Kind.Clip, c["transition"]?["duration"]?.GetValue<double>() ?? 0, c["id"]?.GetValue<string>()));
            }
            foreach (var l in state["layers"]?.AsArray() ?? [])
            {
                if (l is null) continue;
                var kind = l["type"]?.GetValue<string>() switch { "text" => Kind.Text, "media" => Kind.Media, _ => Kind.Shape };
                _layers.Add(new Block(l["start"]!.GetValue<double>(), l["end"]!.GetValue<double>(), l["label"]?.GetValue<string>() ?? "", kind, 0, l["id"]?.GetValue<string>()));
            }
            foreach (var a in state["audio"]?.AsArray() ?? [])
                if (a is not null)
                    _audio.Add(new Block(a["start"]!.GetValue<double>(), a["end"]!.GetValue<double>(), $"{a["role"]?.GetValue<string>()}: {a["assetId"]?.GetValue<string>()}", Kind.Audio, 0, a["id"]?.GetValue<string>()));
            foreach (var c in state["captions"]?.AsArray() ?? [])
                if (c is not null)
                    _captions.Add(new Block(c["start"]!.GetValue<double>(), c["end"]!.GetValue<double>(), c["text"]?.GetValue<string>() ?? "", Kind.Caption));
        }
        // Keep the pick while the item exists; tell listeners when it is gone or has moved.
        if (_selectedId is not null)
        {
            if (Selected is null) _selectedId = null;
            SelectionChanged?.Invoke(Selected);
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
    private static double CompactHeight => CompactClip + CompactGap + CompactMark + CompactGap + CompactMark + 2;

    protected override Size MeasureOverride(Size available)
    {
        var w = double.IsInfinity(available.Width) ? 600 : available.Width;
        return new Size(w, _compact ? CompactHeight : RulerHeight + Math.Max(1, _lanes.Count) * LaneHeight + 2);
    }

    private double Width0 => Bounds.Width;
    private double TimeToX(double t) => LabelWidth + (_duration <= 0 ? 0 : t / _duration * Math.Max(1, Width0 - LabelWidth - 2));

    public override void Render(DrawingContext dc)
    {
        // Transparent fill so the whole area takes clicks.
        dc.FillRectangle(Brushes.Transparent, new Rect(Bounds.Size));
        _hits.Clear();
        if (_duration <= 0)
        {
            dc.DrawText(Text("Timeline", 10, Muted), new Point(LabelWidth + 4, 3));
            return;
        }
        if (_compact) RenderCompact(dc);
        else RenderLanes(dc);

        var px = TimeToX(Math.Clamp(_playhead, 0, _duration));
        dc.DrawLine(PlayheadPen, new Point(px, 0), new Point(px, Bounds.Height));
    }

    private void RenderCompact(DrawingContext dc)
    {
        for (var i = 0; i < _clips.Count; i++)
            Hit(dc, DrawBlock(dc, _clips[i], 0, CompactClip, i % 2 == 0 ? ClipFill : ClipFillAlt, withLabel: true), _clips[i]);
        // The hairline marks get a taller click area than they are drawn.
        var y = CompactClip + CompactGap;
        foreach (var b in _layers) Hit(dc, DrawBlock(dc, b, y, CompactMark, FillFor(b.Kind), withLabel: false), b, grow: 2);
        y += CompactMark + CompactGap;
        foreach (var b in _audio) Hit(dc, DrawBlock(dc, b, y, CompactMark, MediaFill, withLabel: false), b, grow: 2);
    }

    private void RenderLanes(DrawingContext dc)
    {
        var step = _duration > 300 ? 60 : _duration > 120 ? 30 : _duration > 40 ? 10 : _duration > 15 ? 5 : 1;
        for (double t = 0; t <= _duration + 0.001; t += step)
        {
            var ft = Text($"{(int)t / 60:00}:{(int)t % 60:00}", 9, Muted);
            dc.DrawText(ft, new Point(Math.Min(TimeToX(t) - ft.Width / 2, Width0 - ft.Width), 1));
        }
        for (var i = 0; i < _lanes.Count; i++)
        {
            var y = RulerHeight + i * LaneHeight;
            var lane = _lanes[i];
            if (lane.Name.Length > 0)
            {
                var ft = Text(lane.Name, 10, Muted);
                dc.DrawText(ft, new Point(LabelWidth - ft.Width - 8, y + 4));
            }
            var alt = 0;
            foreach (var b in lane.Blocks)
                Hit(dc, DrawBlock(dc, b, y + 2, LaneHeight - 4, b.Kind == Kind.Clip ? (alt++ % 2 == 0 ? ClipFill : ClipFillAlt) : FillFor(b.Kind), withLabel: true), b);
            dc.DrawLine(LinePen, new Point(LabelWidth, y + LaneHeight), new Point(Width0, y + LaneHeight));
        }
    }

    /// <summary>Remember where an item is drawn for clicks, and mark it when it is the picked one.</summary>
    private void Hit(DrawingContext dc, Rect rect, Block b, double grow = 0)
    {
        if (b.Id is null) return;
        _hits.Add((grow > 0 ? new Rect(rect.Left, rect.Top - grow, rect.Width, rect.Height + 2 * grow) : rect, b));
        if (b.Id != _selectedId) return;
        var r = Math.Min(3, rect.Height / 2);
        dc.DrawRectangle(BlueSoft, SelectPen, rect, r, r);
    }

    private Rect DrawBlock(DrawingContext dc, Block b, double y, double h, IBrush fill, bool withLabel)
    {
        var x0 = TimeToX(b.Start);
        var w = Math.Max(1.5, TimeToX(b.End) - x0 - 1);
        var rect = new Rect(x0, y, w, h);
        dc.DrawRectangle(fill, null, rect, Math.Min(3, h / 2), Math.Min(3, h / 2));
        if (b.TransitionIn > 0)
            dc.FillRectangle(Hatch, new Rect(x0, y, Math.Min(w, TimeToX(b.Start + b.TransitionIn) - x0), h));
        if (!withLabel || w < 28 || h < 12) return rect;
        var ft = Text(b.Label, 10, b.Kind == Kind.Text ? DarkText : LabelText);
        ft.MaxTextWidth = Math.Max(1, w - 8);
        ft.MaxLineCount = 1;
        ft.Trimming = TextTrimming.CharacterEllipsis;
        using (dc.PushClip(rect)) dc.DrawText(ft, new Point(x0 + 4, y + (h - ft.Height) / 2));
        return rect;
    }

    private static IBrush FillFor(Kind k) => k switch
    {
        Kind.Text => TextFill,
        Kind.Media => MediaFill,
        Kind.Shape => ShapeFill,
        Kind.Audio => AudioFill,
        Kind.Caption => CaptionFill,
        _ => ClipFill,
    };

    private FormattedText Text(string s, double size, IBrush brush) =>
        new(s, CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, Face, size, brush);

    private static string KindName(Kind k) => k switch
    {
        Kind.Clip => "clip",
        Kind.Text => "text layer",
        Kind.Media => "media layer",
        Kind.Shape => "shape layer",
        Kind.Audio => "audio clip",
        _ => "caption",
    };

    private static string Clock(double t) => $"{(int)t / 60:00}:{t % 60:00.0}";

    private Block? HitTest(Point p) => _hits.LastOrDefault(h => h.Rect.Contains(p)).Block;

    private void Select(string? id)
    {
        if (id == _selectedId) return;
        _selectedId = id;
        InvalidateVisual();
        SelectionChanged?.Invoke(Selected);
    }

    protected override void OnPointerPressed(PointerPressedEventArgs e)
    {
        if (!e.GetCurrentPoint(this).Properties.IsLeftButtonPressed) return;
        Focus();
        var p = e.GetPosition(this);
        Select(HitTest(p)?.Id);
        e.Pointer.Capture(this);
        _dragging = true;
        SeekTo(p.X);
        e.Handled = true;
    }

    protected override void OnPointerMoved(PointerEventArgs e)
    {
        var p = e.GetPosition(this);
        if (_dragging)
        {
            SeekTo(p.X);
            return;
        }
        var b = HitTest(p);
        if (ReferenceEquals(b, _hover)) return;
        _hover = b;
        var name = b is null ? "" : KindName(b.Kind);
        ToolTip.SetTip(this, b is null ? null : $"{char.ToUpper(name[0])}{name[1..]}: {b.Label}\n{Clock(b.Start)} to {Clock(b.End)}\nClick to ask Claude about it");
    }

    protected override void OnPointerReleased(PointerReleasedEventArgs e)
    {
        _dragging = false;
        e.Pointer.Capture(null);
    }

    protected override void OnPointerCaptureLost(PointerCaptureLostEventArgs e) => _dragging = false;

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.Key != Key.Escape || _selectedId is null) return;
        Select(null);
        e.Handled = true;
    }

    private void SeekTo(double x)
    {
        if (_duration <= 0 || x < LabelWidth) return;
        var t = Math.Clamp((x - LabelWidth) / Math.Max(1, Width0 - LabelWidth - 2) * _duration, 0, _duration);
        Playhead = t;
        Seek?.Invoke(t);
    }
}
