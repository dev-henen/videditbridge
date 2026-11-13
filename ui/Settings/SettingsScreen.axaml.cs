using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using VideoEditor.Chat;
using VideoEditor.Shared;
using VideoEditor.Shell;

namespace VideoEditor.Settings;

/// <summary>A folder the app uses, to see and open.</summary>
public sealed record FolderRow(string Name, string Path);

/// <summary>
/// The app's settings tab: the AI providers' API keys (Claude's, the default, ChatGPT's and Gemini's)
/// and the default model, the renderer and encoding on the
/// graphics card, and the folders the app uses. Every change goes to the host at once, which applies
/// it and keeps it for next time.
/// </summary>
public partial class SettingsScreen : UserControl
{
    private AppViewModel _vm = null!;
    // Filling the controls from the host must not send their changes back.
    private bool _loading;

    public SettingsScreen() => InitializeComponent();

    /// <summary>One provider's key row: what it says about the key, the box to type one, and its remove button.</summary>
    private sealed record KeyRow(ProviderOption Provider, TextBlock Status, TextBox Box, Button Remove);
    private readonly List<KeyRow> _keyRows = [];

    public void Attach(AppViewModel vm)
    {
        _vm = vm;
        ModelBox.ItemsSource = vm.Models;
        BuildKeyRows();
        _ = LoadAsync();
    }

    private IBrush? Brush(string key) => this.TryFindResource(key, out var v) ? v as IBrush : null;

    /// <summary>A key row for each provider the host offers (Anthropic for Claude first, the default).</summary>
    private void BuildKeyRows()
    {
        KeyRows.Children.Clear();
        _keyRows.Clear();
        foreach (var p in _vm.Providers)
        {
            var status = new TextBlock { FontSize = 12, Foreground = Brush("Text"), TextWrapping = Avalonia.Media.TextWrapping.Wrap };
            var box = new TextBox { PasswordChar = '•', Watermark = $"{p.Label} API key ({p.KeyHint})" };
            AutomationProperties.SetName(box, $"{p.Label} API key");
            var remove = new Button { Margin = new Thickness(6, 0, 0, 0), Content = new TextBlock { Text = "Remove", FontSize = 12 } };
            ToolTip.SetTip(remove, $"Remove the stored {p.Label} key");
            AutomationProperties.SetName(remove, $"Remove the stored {p.Label} key");
            var save = new Button
            {
                Margin = new Thickness(6, 0, 0, 0),
                Content = new StackPanel
                {
                    Orientation = Avalonia.Layout.Orientation.Horizontal,
                    Children =
                    {
                        new TextBlock { Classes = { "icon" }, Text = Icons.Key, FontSize = 13, Foreground = Brush("OnAccent"), Margin = new Thickness(0, 0, 6, 0) },
                        new TextBlock { Text = "Save", FontSize = 12, Foreground = Brush("OnAccent"), FontWeight = FontWeight.SemiBold, VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center },
                    },
                },
            };
            save.Classes.Add("primary");
            AutomationProperties.SetName(save, $"Save the {p.Label} API key");
            var row = new KeyRow(p, status, box, remove);
            save.Click += async (_, _) => await SaveKey(row);
            box.KeyDown += async (_, e) =>
            {
                if (e.Key == Avalonia.Input.Key.Enter) await SaveKey(row);
            };
            remove.Click += async (_, _) => await Change(new { provider = p.Id, apiKey = "" });

            var label = new TextBlock { Text = "API key" };
            label.Classes.Add("label");
            var line = new DockPanel();
            DockPanel.SetDock(label, Dock.Left);
            DockPanel.SetDock(remove, Dock.Right);
            DockPanel.SetDock(save, Dock.Right);
            line.Children.Add(label);
            line.Children.Add(remove);
            line.Children.Add(save);
            line.Children.Add(box);

            var title = new TextBlock { Text = $"{p.Assistant}, from {p.Label}{(p.Id == "anthropic" ? " (default)" : "")}", FontSize = 12, FontWeight = FontWeight.SemiBold, Foreground = Brush("Text") };
            KeyRows.Children.Add(new StackPanel { Spacing = 6, Children = { title, status, line } });
            _keyRows.Add(row);
        }
    }

    private async Task SaveKey(KeyRow row)
    {
        var key = row.Box.Text?.Trim();
        if (string.IsNullOrEmpty(key)) return;
        await Change(new { provider = row.Provider.Id, apiKey = key });
        row.Box.Text = "";
    }

    /// <summary>Read the settings from the host and show them.</summary>
    public async Task LoadAsync()
    {
        try
        {
            var s = await _vm.GetSettingsAsync();
            if (s is null) return;
            _loading = true;
            // The provider list comes with host.info, which may arrive after the tab was made.
            if (!_keyRows.Select(r => r.Provider.Id).SequenceEqual(_vm.Providers.Select(p => p.Id))) BuildKeyRows();
            ShowKey(s);
            ModelBox.SelectedItem = _vm.DefaultModel;
            var renderer = s["renderer"]?.GetValue<string>() ?? "auto";
            RendererBox.SelectedItem = RendererBox.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string?)i.Tag == renderer);
            HardwareBox.IsChecked = s["hardwareEncoding"]?.GetValue<bool>() ?? true;
            ShowPerformance(s["performance"]);
            FolderList.ItemsSource = new List<FolderRow>
            {
                new("Projects", s["projectsDir"]?.GetValue<string>() ?? ""),
                new("Models", s["modelsDir"]?.GetValue<string>() ?? ""),
                new("Fonts", s["fontsDir"]?.GetValue<string>() ?? ""),
                new("Cache", s["cacheDir"]?.GetValue<string>() ?? ""),
                new("App data", s["dataDir"]?.GetValue<string>() ?? ""),
            }.Where(f => f.Path.Length > 0).ToList();
            AboutText.Text = $"AI Video Editor. Settings are kept in {s["file"]?.GetValue<string>()}.";
        }
        catch (Exception e)
        {
            _vm.ShowError($"Could not read the settings: {e.Message}");
        }
        finally
        {
            _loading = false;
        }
    }

    /// <summary>Show what each provider's key is (set or not, and where from).</summary>
    private void ShowKey(JsonNode s)
    {
        var fromEnvironment = false;
        foreach (var row in _keyRows)
        {
            var p = row.Provider;
            // An older host only reports Anthropic's key, as apiKey.
            var key = s["apiKeys"]?[p.Id] ?? (p.Id == "anthropic" ? s["apiKey"] : null);
            var set = key?["set"]?.GetValue<bool>() == true;
            var source = key?["source"]?.GetValue<string>();
            fromEnvironment |= set && source == "environment";
            row.Status.Text = set
                ? $"{p.Assistant} can edit: a key ending in {key!["hint"]?.GetValue<string>()?.TrimStart('…')} is set{(source == "environment" ? " by an environment variable" : "")}."
                : $"{p.Assistant} cannot edit yet: add a {p.Label} API key ({p.KeyUrl}).";
            row.Remove.IsVisible = set && source != "environment";
        }
        var keychain = s["keychain"]?.GetValue<bool>() == true;
        var store = OperatingSystem.IsWindows() ? "Windows Credential Manager" : OperatingSystem.IsMacOS() ? "the macOS Keychain" : "the system keyring";
        KeyNote.Text = (keychain
                ? $"Keys are kept in {store}, on this computer only, and each is sent only to its own provider. They take effect right away."
                : "No system keychain was found, so keys are kept in the settings file on this computer. They take effect right away.")
            + (fromEnvironment ? " A key set by an environment variable wins over one saved here." : "");
    }

    private void ShowPerformance(JsonNode? report)
    {
        if (report is null)
        {
            PerformanceText.Text = "No performance test has run on this computer yet.";
            return;
        }
        var when = DateTime.TryParse(report["measuredAt"]?.GetValue<string>(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var d) ? d.ToLocalTime().ToString("d", CultureInfo.CurrentCulture) : "";
        PerformanceText.Text = $"Last test ({when}): {report["reason"]?.GetValue<string>()}";
    }

    private async Task Change(object changes)
    {
        if (_loading) return;
        try
        {
            var r = await _vm.SetSettingsAsync(changes);
            if (r is not null) ShowKey(r);
        }
        catch (Exception e)
        {
            _vm.ShowError($"Could not change the setting: {e.Message}");
        }
    }

    private async void OnModelChanged(object? sender, SelectionChangedEventArgs e)
    {
        if (ModelBox.SelectedItem is ModelOption m) await Change(new { defaultModel = m.Id });
    }

    private async void OnRendererChanged(object? sender, SelectionChangedEventArgs e)
    {
        if (RendererBox.SelectedItem is ComboBoxItem { Tag: string renderer }) await Change(new { renderer });
    }

    private async void OnHardwareChanged(object? sender, RoutedEventArgs e) => await Change(new { hardwareEncoding = HardwareBox.IsChecked == true });

    private async void OnRunTest(object? sender, RoutedEventArgs e)
    {
        TestButton.IsEnabled = false;
        PerformanceText.Text = "Testing the renderers on this computer (about a minute)...";
        try
        {
            ShowPerformance(await _vm.RunPerformanceTestAsync());
        }
        catch (Exception ex)
        {
            PerformanceText.Text = $"The test failed: {ex.Message}";
        }
        finally
        {
            TestButton.IsEnabled = true;
        }
    }

    private async void OnOpenFolder(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.Tag is not string path) return;
        try
        {
            Directory.CreateDirectory(path);
            if (TopLevel.GetTopLevel(this)?.Launcher is { } launcher) await launcher.LaunchDirectoryInfoAsync(new DirectoryInfo(path));
        }
        catch (Exception ex)
        {
            _vm.ShowError($"Could not open {path}: {ex.Message}");
        }
    }
}
