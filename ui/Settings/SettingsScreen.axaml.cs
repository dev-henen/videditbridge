using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using VideoEditor.Chat;
using VideoEditor.Shell;

namespace VideoEditor.Settings;

/// <summary>A folder the app uses, to see and open.</summary>
public sealed record FolderRow(string Name, string Path);

/// <summary>
/// The app's settings tab: Claude's API key and default model, the renderer and encoding on the
/// graphics card, and the folders the app uses. Every change goes to the host at once, which applies
/// it and keeps it for next time.
/// </summary>
public partial class SettingsScreen : UserControl
{
    private AppViewModel _vm = null!;
    // Filling the controls from the host must not send their changes back.
    private bool _loading;

    public SettingsScreen() => InitializeComponent();

    public void Attach(AppViewModel vm)
    {
        _vm = vm;
        ModelBox.ItemsSource = vm.Models;
        _ = LoadAsync();
    }

    /// <summary>Read the settings from the host and show them.</summary>
    public async Task LoadAsync()
    {
        try
        {
            var s = await _vm.GetSettingsAsync();
            if (s is null) return;
            _loading = true;
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

    private void ShowKey(JsonNode s)
    {
        var key = s["apiKey"];
        var set = key?["set"]?.GetValue<bool>() == true;
        var source = key?["source"]?.GetValue<string>();
        KeyStatus.Text = set
            ? $"Claude can edit: a key ending in {key!["hint"]?.GetValue<string>()?.TrimStart('…')} is set{(source == "environment" ? " by the ANTHROPIC_API_KEY environment variable" : "")}."
            : "Claude cannot edit yet: add an Anthropic API key (console.anthropic.com).";
        RemoveKeyButton.IsVisible = set && source == "settings";
        KeyNote.Text = source == "environment"
            ? "The environment variable wins over a key saved here. Unset it to use the saved one."
            : "Kept on this computer only, and sent to nobody but Anthropic. It takes effect right away.";
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

    private async void OnSaveKey(object? sender, RoutedEventArgs e)
    {
        var key = KeyBox.Text?.Trim();
        if (string.IsNullOrEmpty(key)) return;
        await Change(new { apiKey = key });
        KeyBox.Text = "";
    }

    private async void OnRemoveKey(object? sender, RoutedEventArgs e) => await Change(new { apiKey = "" });

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
