using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Interactivity;
using VideoEditor.Shared;

namespace VideoEditor.Timeline;

/// <summary>
/// The timeline under the preview: every lane, or a compact strip of the edit (the button toggles,
/// and the app keeps the choice in its settings).
/// Clicking seeks; picking a clip or layer makes the next request to Claude about it.
/// </summary>
public partial class TimelineStrip : UserControl
{
    public TimelineStrip()
    {
        InitializeComponent();
        View.Seek += t => Seek?.Invoke(t);
        View.SelectionChanged += item => SelectionChanged?.Invoke(item);
        ShowExpanded();
    }

    /// <summary>The user toggled the timeline.</summary>
    public event Action<bool>? ExpandedChanged;

    /// <summary>Every lane (true) or the compact strip.</summary>
    public bool Expanded
    {
        get => !View.Compact;
        set
        {
            if (Expanded == value) return;
            View.Compact = !value;
            ShowExpanded();
        }
    }

    private void ShowExpanded()
    {
        ExpandIcon.Text = View.Compact ? Icons.ChevronUp : Icons.ChevronDown;
        var tip = View.Compact ? "Show all timeline lanes" : "Compact timeline";
        ToolTip.SetTip(ExpandTimeline, tip);
        Avalonia.Automation.AutomationProperties.SetName(ExpandTimeline, tip);
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
        Expanded = !Expanded;
        ExpandedChanged?.Invoke(Expanded);
    }
}
