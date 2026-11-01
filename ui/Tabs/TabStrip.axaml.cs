using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using VideoEditor.Shell;

namespace VideoEditor.Tabs;

/// <summary>
/// The tab row, like a browser's: one tab per open project (each keeps working in the background)
/// and the projects page in a new tab. Click to switch, middle-click or the cross to close, + for a new tab.
/// </summary>
public partial class TabStrip : UserControl
{
    private AppViewModel _vm = null!;

    public TabStrip() => InitializeComponent();

    public void Attach(AppViewModel vm)
    {
        _vm = vm;
        TabList.ItemsSource = vm.Tabs;
        TabMenu.ItemsSource = vm.Tabs;
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
