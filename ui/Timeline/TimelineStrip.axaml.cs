using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Interactivity;
using VideoEditor.Shared;

namespace VideoEditor.Timeline;

/// <summary>
/// The timeline strip under the preview: a compact view of the edit that expands to every lane.
/// Clicking seeks; picking a clip or layer makes the next request to Claude about it.
/// </summary>
public partial class TimelineStrip : UserControl
{
    public TimelineStrip()
    {
        InitializeComponent();
        View.Seek += t => Seek?.Invoke(t);
        View.SelectionChanged += item => SelectionChanged?.Invoke(item);
    }

    /// <summary>The user clicked a time.</summary>
    public event Action<double>? Seek;

    /// <summary>The user picked an item (or cleared the pick).</summary>
    public event Action<TimelineItem?>? SelectionChanged;

    public TimelineItem? Selected => View.Selected;

    public double Playhead
    {
        set => View.Playhead = value;
    }

    public void Update(JsonNode state) => View.Update(state);

    public void ClearSelection() => View.ClearSelection();

    private void OnToggleTimeline(object? sender, RoutedEventArgs e)
    {
        View.Compact = !View.Compact;
        ExpandIcon.Text = View.Compact ? Icons.ChevronUp : Icons.ChevronDown;
        ToolTip.SetTip(ExpandTimeline, View.Compact ? "Show all timeline lanes" : "Compact timeline");
    }
}
