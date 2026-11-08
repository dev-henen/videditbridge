using System.Collections.Specialized;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using VideoEditor.Shell;

namespace VideoEditor.Tabs;

/// <summary>
/// The tab row, like a browser's: one tab per open project (each keeps working in the background)
/// and the projects page in a new tab. Click to switch, middle-click or the cross to close, + for a new tab.
/// Tabs share the row: each is as wide as fits, from <see cref="MaxTab"/> down to <see cref="MinTab"/>, and
/// past that the row scrolls.
/// </summary>
public partial class TabStrip : UserControl
{
    private const double MaxTab = 232, MinTab = 96;
    /// <summary>The + button and the gaps between tabs.</summary>
    private const double NewTabRoom = 36, Gap = 2;

    public static readonly StyledProperty<double> TabWidthProperty = AvaloniaProperty.Register<TabStrip, double>(nameof(TabWidth), MaxTab);
    /// <summary>The width every tab has now.</summary>
    public double TabWidth { get => GetValue(TabWidthProperty); set => SetValue(TabWidthProperty, value); }

    private AppViewModel _vm = null!;

    public TabStrip() => InitializeComponent();

    public void Attach(AppViewModel vm)
    {
        _vm = vm;
        TabList.ItemsSource = vm.Tabs;
        TabMenu.ItemsSource = vm.Tabs;
        vm.Tabs.CollectionChanged += (_, _) => FitTabs();
        FitTabs();
    }

    private void OnRowResized(object? sender, SizeChangedEventArgs e) => FitTabs();

    /// <summary>Share the row's width between the tabs.</summary>
    private void FitTabs()
    {
        var count = _vm?.Tabs.Count ?? 0;
        var room = TabScroller.Bounds.Width - NewTabRoom;
        if (count == 0 || room <= 0) return;
        TabWidth = Math.Round(Math.Clamp(room / count - Gap, MinTab, MaxTab));
    }

    private void OnMenuTab(object? sender, RoutedEventArgs e)
    {
        if (sender is not Control { Tag: AppTab tab }) return;
        _vm.SelectedTab = tab;
        TabMenuButton.Flyout?.Hide();
    }

    private void OnTabPressed(object? sender, PointerPressedEventArgs e)
    {
        if (sender is Control { Tag: AppTab tab } && e.GetCurrentPoint(this).Properties.IsLeftButtonPressed) _vm.SelectedTab = tab;
    }

    private async void OnTabReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (sender is Control { Tag: AppTab tab } && e.InitialPressMouseButton == MouseButton.Middle) await _vm.CloseTabAsync(tab);
    }

    private async void OnCloseTab(object? sender, RoutedEventArgs e)
    {
        if (sender is Control { Tag: AppTab tab }) await _vm.CloseTabAsync(tab);
    }

    private void OnNewTab(object? sender, RoutedEventArgs e) => _vm.NewTab();
}
