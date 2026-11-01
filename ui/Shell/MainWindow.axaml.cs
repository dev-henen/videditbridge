using System.ComponentModel;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using VideoEditor.Projects;
using VideoEditor.Shared;

namespace VideoEditor.Shell;

/// <summary>
/// The editor window: tabs in the title bar and one page per tab. A project tab's page holds all of
/// that project (its commands, activity, preview, timeline and chat) and stays alive in the
/// background, so its renders and Claude keep going; a new tab has its own projects page.
/// </summary>
public partial class MainWindow : Window
{
    private readonly AppViewModel _vm = new();
    private readonly Dictionary<AppTab, Control> _pages = [];
    private readonly string[] _args;

    public MainWindow() : this([]) { }

    public MainWindow(string[] args)
    {
        _args = args;
        InitializeComponent();
        DataContext = _vm;
        Tabs.Attach(_vm);
        _vm.ErrorRaised += message => _ = ShowMessage(message);
        _vm.TabOpened += OnTabOpened;
        _vm.TabClosed += OnTabClosed;
        _vm.PropertyChanged += OnViewModelChanged;

        KeyDown += OnKeyDown;
        Opened += async (_, _) =>
        {
            PlaceTabs();
            await _vm.StartAsync(_args.Length > 0 && Directory.Exists(_args[0]) ? _args[0] : null);
        };
        PropertyChanged += (_, e) =>
        {
            if (e.Property == IsExtendedIntoWindowDecorationsProperty || e.Property == WindowStateProperty) PlaceTabs();
        };
        Closing += (_, _) =>
        {
            foreach (var page in _pages.Values) (page as ProjectView)?.Dispose();
            _vm.Dispose();
        };
    }

    /// <summary>
    /// Keep the tabs clear of the window buttons the system draws in the title bar: on the right on
    /// Windows, the traffic lights on the left on macOS. Without an extended title bar (some Linux
    /// desktops), the tab row sits under the system's own title bar and needs no room.
    /// </summary>
    private void PlaceTabs()
    {
        var extended = IsExtendedIntoWindowDecorations;
        var mac = OperatingSystem.IsMacOS();
        Tabs.Margin = new Thickness(extended && mac && WindowState != WindowState.FullScreen ? 74 : 0, 0, extended && !mac ? 140 : 0, 0);
    }

    private void OnTabOpened(AppTab tab)
    {
        Control page;
        if (tab.Project is { } project) page = new ProjectView(project);
        else
        {
            var start = new ProjectsScreen { DataContext = _vm };
            start.OpenRequested += async dir => await _vm.OpenProjectAsync(dir, tab);
            start.CreateRequested += async () => await _vm.CreateProjectAsync(tab);
            page = start;
        }
        page.IsVisible = false;
        _pages[tab] = page;
        Pages.Children.Add(page);
    }

    private void OnTabClosed(AppTab tab)
    {
        if (!_pages.Remove(tab, out var page)) return;
        Pages.Children.Remove(page);
        (page as ProjectView)?.Dispose();
    }

    /// <summary>Show the selected tab's page; the others stay alive behind it.</summary>
    private void OnViewModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(AppViewModel.SelectedTab)) return;
        foreach (var (tab, page) in _pages)
        {
            var shown = tab == _vm.SelectedTab;
            if (page.IsVisible && !shown) (page as ProjectView)?.Deactivate();
            page.IsVisible = shown;
        }
    }

    // Ctrl+T new tab, Ctrl+W close it, Ctrl+Tab and Ctrl+Shift+Tab move between tabs.
    private async void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (!e.KeyModifiers.HasFlag(KeyModifiers.Control)) return;
        switch (e.Key)
        {
            case Key.T:
                _vm.NewTab();
                break;
            case Key.W when _vm.SelectedTab is { } tab:
                await _vm.CloseTabAsync(tab);
                break;
            case Key.Tab when _vm.Tabs.Count > 1 && _vm.SelectedTab is { } tab:
                var step = e.KeyModifiers.HasFlag(KeyModifiers.Shift) ? -1 : 1;
                _vm.SelectedTab = _vm.Tabs[(_vm.Tabs.IndexOf(tab) + step + _vm.Tabs.Count) % _vm.Tabs.Count];
                break;
            default:
                return;
        }
        e.Handled = true;
    }

    /// <summary>A small message window in the app's style (Avalonia has no system message box).</summary>
    private async Task ShowMessage(string message)
    {
        var ok = new Button { Content = "OK", Classes = { "primary" }, HorizontalAlignment = HorizontalAlignment.Right, IsDefault = true };
        var dialog = new Window
        {
            Title = "AI Video Editor",
            Width = 380,
            SizeToContent = SizeToContent.Height,
            CanResize = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Background = this.Brush("Panel"),
            Content = new StackPanel
            {
                Margin = new Thickness(16),
                Spacing = 14,
                Children = { new SelectableTextBlock { Text = message, TextWrapping = TextWrapping.Wrap, Foreground = this.Brush("Text") }, ok },
            },
        };
        ok.Click += (_, _) => dialog.Close();
        await dialog.ShowDialog(this);
    }
}
