using Avalonia.Controls;

namespace VideoEditor.Shell;

/// <summary>
/// The workspace of one project tab: lays out its parts and connects them. The preview, the timeline
/// and the chat share the playhead, the picked item and the spot; everything else goes through the
/// project's view model.
/// </summary>
public partial class ProjectView : UserControl
{
    public ProjectViewModel Project { get; }

    public ProjectView() : this(null!) { }

    public ProjectView(ProjectViewModel project)
    {
        Project = project;
        InitializeComponent();
        if (project is null) return; // the designer
        DataContext = project;
        Screen.Attach(project);
        // The matte shows the mask of the clip picked on the timeline.
        Screen.MatteTarget = () => Strip.Selected is { Kind: "clip" } item ? item.Id : null;
        Side.Attach(project);
        Chat.Attach(project);
        project.StateUpdated += Strip.Update;
        // Commands that render something bring the preview back to live.
        Bar.FollowRequested += Screen.Follow;
        if (project.State is { } state) Strip.Update(state);

        // One playhead: the preview's scrubber and the timeline move together.
        Screen.PlayheadMoved += t => Strip.Playhead = t;
        Strip.Seek += Screen.Seek;
        Side.SeekRequested += Screen.Seek;
        // What the next request is about.
        Strip.SelectionChanged += Chat.Composer.ShowPick;
        Screen.SpotChanged += Chat.Composer.ShowSpot;
        Chat.Composer.PickCleared += Strip.ClearSelection;
        Chat.Composer.SpotCleared += Screen.ClearSpot;
        Chat.Composer.Submitted += async (prompt, files) =>
        {
            Screen.Follow();
            await project.AskClaudeAsync(prompt, Strip.Selected, Screen.Spot, attachments: files);
        };

        // Edited from another AI app: no chat here, and the preview takes its room.
        ShowChat(!project.IsMcpDriven);
        project.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(ProjectViewModel.IsMcpDriven)) ShowChat(!project.IsMcpDriven);
        };
    }

    private GridLength _chatWidth = new(272);

    private void ShowChat(bool show)
    {
        var column = Layout.ColumnDefinitions[4];
        if (!show && column.Width.Value > 0) _chatWidth = column.Width;
        column.Width = show ? _chatWidth : new GridLength(0);
        Layout.ColumnDefinitions[3].Width = new GridLength(show ? 6 : 0);
        Chat.IsVisible = show;
        ChatSplitter.IsVisible = show;
        // New edits come from the other app: follow them.
        if (!show) Screen.Follow();
    }

    private async void OnUseChatHere(object? sender, Avalonia.Interactivity.RoutedEventArgs e) => await Project.UseChatHereAsync();

    /// <summary>Show each new render as it comes (a command is about to render something).</summary>
    public void Follow() => Screen.Follow();

    /// <summary>The tab went to the background: stop playback. Its work goes on.</summary>
    public void Deactivate() => Screen.Pause();

    public void Dispose()
    {
        Chat.Dispose();
        Screen.Dispose();
    }
}
