using System.Globalization;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace VideoEditor.Setup;

/// <summary>
/// A speedometer arc: a flat gray track, the value in blue over it, and a tick where rendering
/// keeps up with playback (real time). Drawn, so it looks the same on every system.
/// </summary>
public sealed class SpeedGauge : Control
{
    public static readonly StyledProperty<double> ValueProperty = AvaloniaProperty.Register<SpeedGauge, double>(nameof(Value));
    public static readonly StyledProperty<double> MaximumProperty = AvaloniaProperty.Register<SpeedGauge, double>(nameof(Maximum), 60);
    public static readonly StyledProperty<double> MarkProperty = AvaloniaProperty.Register<SpeedGauge, double>(nameof(Mark), 30);
    public static readonly StyledProperty<IBrush?> TrackProperty = AvaloniaProperty.Register<SpeedGauge, IBrush?>(nameof(Track));
    public static readonly StyledProperty<IBrush?> FillProperty = AvaloniaProperty.Register<SpeedGauge, IBrush?>(nameof(Fill));
    public static readonly StyledProperty<IBrush?> MarkBrushProperty = AvaloniaProperty.Register<SpeedGauge, IBrush?>(nameof(MarkBrush));

    static SpeedGauge() => AffectsRender<SpeedGauge>(ValueProperty, MaximumProperty, MarkProperty, TrackProperty, FillProperty, MarkBrushProperty);

    public double Value { get => GetValue(ValueProperty); set => SetValue(ValueProperty, value); }
    public double Maximum { get => GetValue(MaximumProperty); set => SetValue(MaximumProperty, value); }
    /// <summary>Where the tick goes: the project's frame rate, rendering as fast as playback.</summary>
    public double Mark { get => GetValue(MarkProperty); set => SetValue(MarkProperty, value); }
    public IBrush? Track { get => GetValue(TrackProperty); set => SetValue(TrackProperty, value); }
    public IBrush? Fill { get => GetValue(FillProperty); set => SetValue(FillProperty, value); }
    public IBrush? MarkBrush { get => GetValue(MarkBrushProperty); set => SetValue(MarkBrushProperty, value); }

    /// <summary>The arc runs clockwise from lower left to lower right, 240 degrees.</summary>
    private const double Start = 150, Sweep = 240, Thickness = 10;

    private (Point center, double radius) Geometry()
    {
        // The arc's lowest points are half a radius below its center; the label above it needs 24 px.
        var r = Math.Min(Bounds.Width / 2 - Thickness, (Bounds.Height - 24 - 2 * Thickness) / 1.5);
        return (new Point(Bounds.Width / 2, r + Thickness + 24), r);
    }

    private static Point At(Point c, double r, double degrees)
    {
        var a = degrees * Math.PI / 180;
        return new Point(c.X + r * Math.Cos(a), c.Y + r * Math.Sin(a));
    }

    private static StreamGeometry Arc(Point c, double r, double from, double sweep)
    {
        var g = new StreamGeometry();
        using var ctx = g.Open();
        ctx.BeginFigure(At(c, r, from), false);
        ctx.ArcTo(At(c, r, from + sweep), new Size(r, r), 0, sweep > 180, SweepDirection.Clockwise);
        ctx.EndFigure(false);
        return g;
    }

    public override void Render(DrawingContext context)
    {
        var (c, r) = Geometry();
        if (r <= 0) return;
        var cap = PenLineCap.Round;
        context.DrawGeometry(null, new Pen(Track ?? Brushes.Gray, Thickness, lineCap: cap), Arc(c, r, Start, Sweep));
        var t = Maximum > 0 ? Math.Clamp(Value / Maximum, 0, 1) : 0;
        if (t > 0.002) context.DrawGeometry(null, new Pen(Fill ?? Brushes.DodgerBlue, Thickness, lineCap: cap), Arc(c, r, Start, Sweep * t));
        if (Mark > 0 && Mark < Maximum)
        {
            var a = Start + Sweep * Mark / Maximum;
            var brush = MarkBrush ?? Brushes.Gray;
            context.DrawLine(new Pen(brush, 1.5), At(c, r + Thickness / 2 + 3, a), At(c, r + Thickness / 2 + 8, a));
            var label = new FormattedText("real time", CultureInfo.CurrentCulture, FlowDirection.LeftToRight, Typeface.Default, 10, brush);
            var p = At(c, r + Thickness / 2 + 16, a);
            context.DrawText(label, new Point(p.X - label.Width / 2, p.Y - label.Height / 2));
        }
    }
}
