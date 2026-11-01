using Avalonia.Controls;
using Avalonia.Media;

namespace VideoEditor.Shared;

/// <summary>Small helpers the components share.</summary>
public static class Ui
{
    /// <summary>A brush from the app's palette (App.axaml), white if it is missing.</summary>
    public static IBrush Brush(this Control control, string key) => control.TryFindResource(key, out var r) && r is IBrush b ? b : Brushes.White;

    /// <summary>Timeline time as mm:ss.s.</summary>
    public static string Time(double s) => $"{(int)s / 60:00}:{s % 60:00.0}";

    /// <summary>How long ago, briefly: "just now", "5 min ago", "yesterday", or the date.</summary>
    public static string Ago(DateTime local)
    {
        var span = DateTime.Now - local;
        if (span.TotalMinutes < 1) return "just now";
        if (span.TotalHours < 1) return $"{(int)span.TotalMinutes} min ago";
        if (local.Date == DateTime.Today) return local.ToString("t", System.Globalization.CultureInfo.CurrentCulture);
        if (local.Date == DateTime.Today.AddDays(-1)) return "yesterday";
        return local.ToString("d", System.Globalization.CultureInfo.CurrentCulture);
    }
}
