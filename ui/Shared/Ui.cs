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
}
