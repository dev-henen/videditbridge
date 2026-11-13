using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using VideoEditor.Preview;
using VideoEditor.Session;
using VideoEditor.Shell;

namespace VideoEditor.Chat;

/// <summary>
/// The chat with Claude, on the right of a project: the conversation (its title, the saved
/// conversations, a new one), the messages, the options Claude offers, and the composer.
/// </summary>
public partial class ChatPanel : UserControl
{
    private ProjectViewModel _vm = null!;
    private AudioPlayer? _audition;
    private ChoiceCard? _auditioning;

    public ChatPanel() => InitializeComponent();

    public void Attach(ProjectViewModel vm)
    {
        _vm = vm;
        Composer.Attach(vm);
        _vm.ChatChanged += ScrollToEnd;
        _vm.ChoicesOffered += StopAudition;
        ConversationList.ItemsSource = _vm.Conversations;
    }

    public void Dispose() => _audition?.Dispose();

    private void ScrollToEnd() => Dispatcher.UIThread.Post(() => MessageScroll.ScrollToEnd(), DispatcherPriority.Background);

    // ------------------------------------------------------------- conversations

    private async void OnHistoryOpening(object? sender, EventArgs e)
    {
        await _vm.RefreshConversationsAsync();
        NoConversations.IsVisible = _vm.Conversations.Count == 0;
    }

    private async void OnOpenConversation(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is not ConversationEntry c) return;
        HistoryButton.Flyout?.Hide();
        if (!c.IsCurrent) await _vm.OpenConversationAsync(c.Id);
    }

    private async void OnDeleteConversation(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is not ConversationEntry c) return;
        await _vm.DeleteConversationAsync(c.Id);
        NoConversations.IsVisible = _vm.Conversations.Count == 0;
    }

    private void OnOpenSettings(object? sender, RoutedEventArgs e) => _vm.OpenSettings();

    private async void OnKeyGuide(object? sender, RoutedEventArgs e) => await VideoEditor.Shared.Docs.Open(this, VideoEditor.Shared.Docs.ApiKeys());

    private async void OnNewConversation(object? sender, RoutedEventArgs e)
    {
        await _vm.NewConversationAsync();
        Composer.FocusPrompt();
    }

    private void OnStartRename(object? sender, TappedEventArgs e)
    {
        TitleBox.Text = _vm.ConversationTitle;
        TitleText.IsVisible = false;
        TitleBox.IsVisible = true;
        TitleBox.Focus();
        TitleBox.SelectAll();
    }

    private async void OnRenameKey(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape) EndRename();
        else if (e.Key == Key.Enter)
        {
            e.Handled = true;
            var title = TitleBox.Text ?? "";
            EndRename();
            await _vm.RenameConversationAsync(title);
        }
    }

    private void OnRenameLostFocus(object? sender, RoutedEventArgs e) => EndRename();

    private void EndRename()
    {
        TitleBox.IsVisible = false;
        TitleText.IsVisible = true;
    }

    // ------------------------------------------------------------- options Claude offers

    /// <summary>Play an option's audio; one plays at a time, and pressing again stops it.</summary>
    private void OnPlayChoice(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is not ChoiceCard card || card.Audio is null) return;
        var again = ReferenceEquals(card, _auditioning);
        StopAudition();
        if (again) return;
        if (Vlc.Instance is not { } vlc)
        {
            _vm.ShowError(Vlc.Error ?? "Audio playback is unavailable.");
            return;
        }
        if (_audition is null)
        {
            _audition = new AudioPlayer(vlc);
            _audition.Ended += StopAudition;
        }
        _auditioning = card;
        card.IsPlaying = true;
        _audition.Play(card.Audio);
    }

    private void StopAudition()
    {
        _audition?.Stop();
        if (_auditioning is not null) _auditioning.IsPlaying = false;
        _auditioning = null;
    }

    private async void OnPickChoice(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is not ChoiceCard card) return;
        StopAudition();
        await _vm.PickChoiceAsync(card);
    }

    private async void OnDismissChoices(object? sender, RoutedEventArgs e)
    {
        StopAudition();
        await _vm.DismissChoicesAsync();
    }
}
