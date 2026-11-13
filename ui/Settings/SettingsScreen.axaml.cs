using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using VideoEditor.Chat;
using VideoEditor.Shared;
using VideoEditor.Shell;

namespace VideoEditor.Settings;

/// <summary>
/// The app's settings tab, laid out like a browser's: a search box on top, sections on the left (AI
/// models, Connections, Rendering, Folders, About) and cards of rows on the right, each row a title
/// and a description with its control at the right. Every change goes to the host at once, which
/// applies it and keeps it for next time; the page is then built again from what the host says.
/// </summary>
public partial class SettingsScreen : UserControl
{
    private AppViewModel _vm = null!;
    // Building the controls must not send their values back.
    private bool _loading;
    private JsonNode? _settings;
    private JsonNode? _connect;
    private string _page = "ai";
    /// <summary>The provider whose key is being typed, if any.</summary>
    private string? _editingKey;
    private string? _performanceNote;

    private sealed record Section(string Id, string Title, string Icon);
    private static readonly Section[] Sections =
    [
        new("ai", "AI models", Icons.Sparkle),
        new("connections", "Connections", Icons.PlugConnected),
        new("rendering", "Rendering", Icons.Video),
        new("folders", "Folders", Icons.Folder),
        new("about", "About", Icons.Info),
    ];

    /// <summary>A built page: its panel and its cards (each with the heading above it and its rows), for search.</summary>
    private sealed record PageView(Section Section, StackPanel Panel, List<CardView> Cards);
    private sealed record CardView(Border Card, Control? Heading, List<(Border Row, string Text)> Rows);
    private readonly List<PageView> _views = [];
    private readonly Dictionary<string, Button> _nav = [];

    public SettingsScreen() => InitializeComponent();

    public void Attach(AppViewModel vm)
    {
        _vm = vm;
        BuildNav();
        SearchBox.TextChanged += (_, _) => ApplySearch();
        _ = LoadAsync();
    }

    /// <summary>Read the settings and connections from the host and show them.</summary>
    public async Task LoadAsync()
    {
        try
        {
            _settings = await _vm.GetSettingsAsync();
            _connect = await _vm.CallHostAsync("connect.get").ContinueWith(t => t.IsCompletedSuccessfully ? t.Result : null);
            Build();
        }
        catch (Exception e)
        {
            _vm.ShowError($"Could not read the settings: {e.Message}");
        }
    }

    // ---------------------------------------------------------------- building blocks

    private void BuildNav()
    {
        Nav.Children.Clear();
        foreach (var s in Sections)
        {
            var button = new Button
            {
                Content = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Spacing = 12,
                    Children =
                    {
                        new TextBlock { Classes = { "icon" }, Text = s.Icon, FontSize = 15, VerticalAlignment = VerticalAlignment.Center },
                        new TextBlock { Text = s.Title, FontSize = 12.5, VerticalAlignment = VerticalAlignment.Center },
                    },
                },
            };
            button.Classes.Add("nav");
            AutomationProperties.SetName(button, s.Title);
            button.Click += (_, _) =>
            {
                _page = s.Id;
                SearchBox.Text = "";
                ApplySearch();
                Scroll.Offset = default;
                // The new section fades in.
                Pages.Transitions ??= [new Avalonia.Animation.DoubleTransition { Property = OpacityProperty, Duration = TimeSpan.FromMilliseconds(160) }];
                Pages.Opacity = 0;
                Avalonia.Threading.Dispatcher.UIThread.Post(() => Pages.Opacity = 1, Avalonia.Threading.DispatcherPriority.Render);
            };
            _nav[s.Id] = button;
            Nav.Children.Add(button);
        }
    }

    private static TextBlock Text(string text, string cls)
    {
        var t = new TextBlock { Text = text };
        t.Classes.Add(cls);
        return t;
    }

    private static Button Btn(string text, Func<Task> click, bool primary = false, string? icon = null, string? name = null)
    {
        Control content = icon is null
            ? new TextBlock { Text = text, FontSize = 12 }
            : new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 6,
                Children =
                {
                    new TextBlock { Classes = { "icon" }, Text = icon, FontSize = 13, VerticalAlignment = VerticalAlignment.Center },
                    new TextBlock { Text = text, FontSize = 12, VerticalAlignment = VerticalAlignment.Center },
                },
            };
        var b = new Button { Content = content, Margin = new Thickness(6, 0, 0, 0) };
        b.Classes.Add(primary ? "primary" : "outline");
        AutomationProperties.SetName(b, name ?? text);
        b.Click += async (_, _) => await click();
        return b;
    }

    private static StackPanel Controls(params Control[] controls)
    {
        var p = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        foreach (var c in controls) p.Children.Add(c);
        return p;
    }

    private static ToggleSwitch Toggle(bool on, string name, Func<bool, Task> changed)
    {
        var t = new ToggleSwitch { IsChecked = on, OnContent = null, OffContent = null, MinWidth = 0, VerticalAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(t, name);
        t.IsCheckedChanged += async (_, _) => await changed(t.IsChecked == true);
        return t;
    }

    /// <summary>A row: title (with an optional chip) and description on the left, its control on the right.</summary>
    private static Border Row(string title, string? sub = null, Control? control = null, string? chip = null, bool error = false, bool selectable = false)
    {
        var titleLine = new StackPanel { Orientation = Orientation.Horizontal, Children = { Text(title, "rowTitle") } };
        if (chip is not null) titleLine.Children.Add(new Border { Classes = { "chip" }, Child = new TextBlock { Text = chip } });
        var left = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Children = { titleLine } };
        if (!string.IsNullOrEmpty(sub))
        {
            Control subText = selectable ? new SelectableTextBlock { Text = sub } : new TextBlock { Text = sub };
            subText.Classes.Add("rowSub");
            if (error) subText.Classes.Add("error");
            left.Children.Add(subText);
        }
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        grid.Children.Add(left);
        if (control is not null)
        {
            control.Margin = new Thickness(16, 0, 0, 0);
            control.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(control, 1);
            grid.Children.Add(control);
        }
        var row = new Border { Child = grid, Tag = $"{title} {chip} {sub}" };
        row.Classes.Add("row");
        return row;
    }

    /// <summary>Add a card of rows (with an optional heading above it) to a page.</summary>
    private static void Card(PageView page, string? heading, params Border[] rows)
    {
        if (rows.Length == 0) return;
        rows[^1].Classes.Add("last");
        var list = new StackPanel();
        foreach (var r in rows) list.Children.Add(r);
        var card = new Border { Child = list };
        card.Classes.Add("card");
        Control? head = heading is null ? null : Text(heading, "group");
        if (head is not null) page.Panel.Children.Add(head);
        page.Panel.Children.Add(card);
        page.Cards.Add(new CardView(card, head, rows.Select(r => (r, $"{heading} {r.Tag}")).ToList()));
    }

    private PageView NewPage(string id, string? intro = null)
    {
        var s = Sections.First(x => x.Id == id);
        var panel = new StackPanel { Margin = new Thickness(0, 0, 0, 18) };
        panel.Children.Add(Text(s.Title, "pageTitle"));
        if (intro is not null) panel.Children.Add(Text(intro, "intro"));
        var page = new PageView(s, panel, []);
        _views.Add(page);
        Pages.Children.Add(panel);
        return page;
    }

    /// <summary>A copy button: it copies, then says so (a check mark and "Copied") for a moment.</summary>
    private Button CopyBtn(string label, string text, string what, bool primary = false, string? name = null)
    {
        Button? button = null;
        button = Btn(label, () => Copy(text, what, button), primary, Icons.Copy, name);
        return button;
    }

    private async Task Copy(string text, string what, Button? button = null)
    {
        try
        {
            if (TopLevel.GetTopLevel(this)?.Clipboard is not { } clipboard) return;
            await clipboard.SetTextAsync(text);
        }
        catch (Exception e)
        {
            _vm.ShowError($"Could not copy the {what}: {e.Message}");
            return;
        }
        if (button is null) return;
        // The same width while it says "Copied", so nothing beside it moves.
        var before = button.Content;
        button.MinWidth = button.Bounds.Width;
        var copied = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 6,
            Children =
            {
                new TextBlock { Classes = { "icon" }, Text = Icons.Check, FontSize = 13, VerticalAlignment = VerticalAlignment.Center },
                new TextBlock { Text = "Copied", FontSize = 12, VerticalAlignment = VerticalAlignment.Center },
            },
        };
        button.Content = copied;
        AutomationProperties.SetName(button, $"Copied the {what}");
        await Task.Delay(1500);
        if (button.Content == copied) button.Content = before;
    }

    // ---------------------------------------------------------------- pages

    private void Build()
    {
        _loading = true;
        try
        {
            _views.Clear();
            Pages.Children.Clear();
            BuildModels(NewPage("ai", "Claude is the default. Add an OpenAI or Google key to edit with ChatGPT or Gemini too, and pick the model in the chat."));
            BuildConnections(NewPage("connections", "Edit from the Claude app with your own Claude account; it shows the previews in its chat. Gemini CLI and Claude Code open the project here to show it."));
            BuildRendering(NewPage("rendering"));
            BuildFolders(NewPage("folders"));
            BuildAbout(NewPage("about"));
            ApplySearch();
        }
        finally
        {
            _loading = false;
        }
    }

    private void BuildModels(PageView page)
    {
        var model = new ComboBox { ItemsSource = _vm.Models, SelectedItem = _vm.DefaultModel, Width = 220 };
        AutomationProperties.SetName(model, "Default model");
        model.SelectionChanged += async (_, _) =>
        {
            if (!_loading && model.SelectedItem is ModelOption m) await Change(new { defaultModel = m.Id });
        };
        Card(page, null, Row("Default model", "New conversations start with it. Each conversation keeps its own, and you can switch in the chat.", model));

        var keychain = _settings?["keychain"]?.GetValue<bool>() == true;
        var store = OperatingSystem.IsWindows() ? "Windows Credential Manager" : OperatingSystem.IsMacOS() ? "the macOS Keychain" : "the system keyring";
        var rows = new List<Border>();
        foreach (var p in _vm.Providers)
        {
            // An older host only reports Anthropic's key, as apiKey.
            var key = _settings?["apiKeys"]?[p.Id] ?? (p.Id == "anthropic" ? _settings?["apiKey"] : null);
            var set = key?["set"]?.GetValue<bool>() == true;
            var source = key?["source"]?.GetValue<string>();
            var hint = key?["hint"]?.GetValue<string>()?.TrimStart('…');
            var sub = !set
                ? $"No key yet. Get one at {p.KeyUrl}."
                : source == "environment"
                    ? $"Key ending in {hint}, set by an environment variable."
                    : $"Key ending in {hint}, saved in {(source == "keychain" ? store : "the settings file")}.";
            var buttons = new List<Control>();
            // Step by step, with screenshots, on the user guide.
            if (!set) buttons.Add(Btn("How to get one", () => Docs.Open(this, Docs.ApiKeys(p.Id)), icon: Icons.Open, name: $"How to get a {p.Label} API key"));
            if (set && source != "environment") buttons.Add(Btn("Remove", () => Change(new { provider = p.Id, apiKey = "" }), name: $"Remove the {p.Label} key"));
            if (_editingKey != p.Id)
                buttons.Add(Btn(set ? "Change" : "Add key", () => { _editingKey = p.Id; Build(); FocusKeyBox(); return Task.CompletedTask; }, primary: !set && p.Id == "anthropic", name: $"{(set ? "Change" : "Add")} the {p.Label} key"));
            rows.Add(Row($"{p.Assistant} ({p.Label})", sub, Controls([.. buttons]), chip: p.Id == "anthropic" ? "Default" : null));
            if (_editingKey == p.Id) rows.Add(KeyEditor(p));
        }
        rows.Add(Row("Where keys are kept", keychain
            ? $"In {store}, on this computer only. Each key is sent only to its own provider."
            : "No system keychain was found, so keys are kept in the settings file on this computer."));
        Card(page, "API keys", [.. rows]);
    }

    private TextBox? _keyBox;

    private void FocusKeyBox() => Avalonia.Threading.Dispatcher.UIThread.Post(() => _keyBox?.Focus());

    /// <summary>The row to type a provider's key in, under its row.</summary>
    private Border KeyEditor(ProviderOption p)
    {
        var box = new TextBox { PasswordChar = '•', Watermark = $"{p.Label} API key ({p.KeyHint})", Width = 300 };
        AutomationProperties.SetName(box, $"{p.Label} API key");
        _keyBox = box;
        async Task Save()
        {
            var key = box.Text?.Trim();
            if (string.IsNullOrEmpty(key)) return;
            _editingKey = null;
            await Change(new { provider = p.Id, apiKey = key });
        }
        Task Cancel()
        {
            _editingKey = null;
            Build();
            return Task.CompletedTask;
        }
        box.KeyDown += async (_, e) =>
        {
            if (e.Key == Key.Enter) await Save();
            else if (e.Key == Key.Escape) await Cancel();
        };
        var line = Controls(box, Btn("Save", Save, primary: true, icon: Icons.Key, name: $"Save the {p.Label} key"), Btn("Cancel", Cancel));
        line.Margin = new Thickness(0);
        var row = new Border { Child = line, Tag = "" };
        row.Classes.Add("row");
        return row;
    }

    private void BuildConnections(PageView page)
    {
        if (_connect is null)
        {
            Card(page, null, Row("Connections are not available", "The editing engine did not answer. Restart the app.", error: true));
            return;
        }
        var command = _connect["command"]?.GetValue<string>();
        var rows = new List<Border>();
        foreach (var c in _connect["clients"]?.AsArray() ?? [])
        {
            if (c is null) continue;
            var id = c["id"]!.GetValue<string>();
            var name = c["name"]!.GetValue<string>();
            var connected = c["connected"]?.GetValue<bool>() == true;
            var outdated = c["outdated"]?.GetValue<bool>() == true;
            var installed = c["installed"]?.GetValue<bool>() == true;
            var note = c["note"]?.GetValue<string>() ?? "";
            // Gemini CLI is Google's terminal tool; the Gemini app connects to an address instead.
            var what = id == "gemini-cli" ? "Google's terminal tool (not the Gemini app). " : "";
            var sub = what + (connected
                ? outdated ? "Connected to another copy of the editor. Connect again to use this one." : $"Connected. {note}"
                : installed ? "Not connected." : "Not found on this computer. Install it, then connect.");
            var buttons = new List<Control>();
            if (connected) buttons.Add(Btn("Disconnect", () => SetClient(id, false), name: $"Disconnect {name}"));
            if (!connected || outdated) buttons.Add(Btn(outdated ? "Update" : "Connect", () => SetClient(id, true), primary: installed, name: $"Connect {name}"));
            if (id == "claude") buttons.Insert(0, Btn("Guide", () => Docs.Open(this, Docs.ClaudeApp), icon: Icons.Open, name: "How to use VideditBridge from the Claude app"));
            rows.Add(Row(name, sub, Controls([.. buttons]), chip: connected && !outdated ? "Connected" : null));
        }
        if (command is not null)
        {
            var claudeCode = _connect["claudeCode"]?.GetValue<string>() ?? "";
            rows.Add(Row("Claude Code", "Run this command once in a terminal.", CopyBtn("Copy command", claudeCode, "command", name: "Copy the Claude Code command")));
            rows.Add(Row("Other apps", "For apps not listed: the command that starts the editor's MCP server.", CopyBtn("Copy command", command, "command", name: "Copy the MCP command")));
        }
        Card(page, "Apps on this computer", [.. rows]);

        // The Gemini app and ChatGPT reach servers only over the internet: Connect starts the local
        // server and a public https address for it (a tunnel), here and whenever the app starts.
        // Three states: off (a Connect button per app), setting up (one progress row), ready (the
        // address to copy and one step per app). The technical parts stay under Advanced.
        var http = _connect["http"];
        // The Gemini app and ChatGPT need a public address; off for now (the host says so), so no section.
        if (http?["available"]?.GetValue<bool>() != true) return;
        var enabled = http?["enabled"]?.GetValue<bool>() == true;
        var on = _httpStarting || (enabled && http?["public"]?.GetValue<bool>() == true);
        var url = http?["url"]?.GetValue<string>();
        var publicUrl = http?["publicUrl"]?.GetValue<string>();
        var starting = _httpStarting || http?["publicStatus"]?.GetValue<string>() is not null;
        var progress = http?["publicProgress"]?.GetValue<double>();
        var problem = http?["error"]?.GetValue<string>() ?? http?["publicError"]?.GetValue<string>();
        var port = http?["port"]?.GetValue<int>() ?? 3920;
        var ready = on && publicUrl is not null;
        Task Connect() => StartPublic();
        Task Off() => SetHttp(new { enabled = false });
        var web = new List<Border>();
        if (!on)
        {
            web.Add(Row("Gemini app", "Use the editor from Gemini, with your Google account.", Btn("Connect", Connect, primary: true, name: "Connect the Gemini app")));
            web.Add(Row("ChatGPT", "Use the editor from ChatGPT, with your OpenAI account.", Btn("Connect", Connect, primary: true, name: "Connect ChatGPT")));
        }
        else if (ready)
        {
            web.Add(Row("Your connection address", publicUrl, CopyBtn("Copy", publicUrl!, "address", primary: true, name: "Copy the address"), chip: "Ready", selectable: true));
            web.Add(Row("Gemini app", "Open Gemini, then Settings, Connected apps, Custom, and paste the address. (Google is still rolling this out, so it may not show for you yet.)"));
            web.Add(Row("ChatGPT", "Open ChatGPT, turn on developer mode (Settings, Apps and connectors, Advanced), then add a connector with the address."));
            web.Add(Row("Keep it private", "Anyone with it can edit your projects. It changes when this app restarts.", Btn("Disconnect", Off, name: "Disconnect Gemini and ChatGPT")));
        }
        else if (problem is not null && !starting)
            web.Add(Row("Couldn't get an address", problem, Controls(Btn("Try again", Connect, primary: true), Btn("Cancel", Off)), error: true));
        else
        {
            // Setting up: the download (with how far it is), then the connection.
            var bar = new ProgressBar { Width = 160, Height = 4, MinHeight = 4, Minimum = 0, Maximum = 1, IsIndeterminate = progress is null, Value = progress ?? 0 };
            var line = Controls(bar, Btn("Cancel", Off));
            web.Add(Row("Getting your connection address", progress is { } p && p < 1 ? $"Setting up, {p * 100:0}%. This happens once." : "Connecting to Cloudflare", line));
            PollWhileStarting();
        }
        // Advanced: what most people never need.
        web.Add(Row("Advanced", _showAdvanced ? null : "Port and local address", Btn(_showAdvanced ? "Hide" : "Show", () => { _showAdvanced = !_showAdvanced; Build(); return Task.CompletedTask; }, name: "Show or hide advanced connection settings")));
        if (_showAdvanced)
        {
            var box = new TextBox { Text = port.ToString(CultureInfo.InvariantCulture), Width = 76 };
            AutomationProperties.SetName(box, "Port");
            async Task Apply()
            {
                if (int.TryParse(box.Text, out var v) && v > 0 && v < 65536 && v != port) await SetHttp(new { port = v });
            }
            box.KeyDown += async (_, e) =>
            {
                if (e.Key == Key.Enter) await Apply();
            };
            box.LostFocus += async (_, _) => await Apply();
            web.Add(Row("Port", "The port on this computer. Change it if another program uses it.", box));
            if (url is not null)
            {
                web.Add(Row("Address on this computer", url, CopyBtn("Copy", url, "address", name: "Copy the local address"), selectable: true));
                web.Add(Row("New secret address", "The old address stops working.", Btn("Make new", () => SetHttp(new { renew = true }))));
            }
        }
        Card(page, "Gemini and ChatGPT", [.. web]);
    }

    private void BuildRendering(PageView page)
    {
        var renderer = new ComboBox { Width = 250 };
        foreach (var (tag, label) in new[] { ("auto", "Automatic (from the performance test)"), ("engine", "GPU engine (FFmpeg if it fails)"), ("ffmpeg", "FFmpeg only") })
            renderer.Items.Add(new ComboBoxItem { Tag = tag, Content = label });
        var current = _settings?["renderer"]?.GetValue<string>() ?? "auto";
        renderer.SelectedItem = renderer.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string?)i.Tag == current);
        AutomationProperties.SetName(renderer, "Renderer");
        renderer.SelectionChanged += async (_, _) =>
        {
            if (!_loading && renderer.SelectedItem is ComboBoxItem { Tag: string r }) await Change(new { renderer = r });
        };
        var hardware = _settings?["hardwareEncoding"]?.GetValue<bool>() ?? true;
        Card(page, null,
            Row("Renderer", "What draws the picture in previews and exports.", renderer),
            Row("Encode on the graphics card", "Faster exports when the graphics card can encode. 10-bit and ProRes exports always encode in software.",
                Toggle(hardware, "Encode exports on the graphics card", on => Change(new { hardwareEncoding = on }))),
            Row("Performance test", _performanceNote ?? PerformanceText(_settings?["performance"]), Btn("Test again", RunTest, icon: Icons.Sync, name: "Run the performance test")));
    }

    private static string PerformanceText(JsonNode? report)
    {
        if (report is null) return "No performance test has run on this computer yet.";
        var when = DateTime.TryParse(report["measuredAt"]?.GetValue<string>(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var d) ? d.ToLocalTime().ToString("d", CultureInfo.CurrentCulture) : "";
        return $"Last test ({when}): {report["reason"]?.GetValue<string>()}";
    }

    private void BuildFolders(PageView page)
    {
        var folders = new[] { ("Projects", "projectsDir"), ("Models", "modelsDir"), ("Fonts", "fontsDir"), ("Cache", "cacheDir"), ("App data", "dataDir") }
            .Select(f => (f.Item1, Path: _settings?[f.Item2]?.GetValue<string>() ?? ""))
            .Where(f => f.Path.Length > 0)
            .Select(f => Row(f.Item1, f.Path, Btn("Open", () => OpenFolder(f.Path), icon: Icons.FolderOpen, name: $"Open the {f.Item1} folder"), selectable: true))
            .ToArray();
        Card(page, null, folders);
    }

    private void BuildAbout(PageView page)
    {
        Card(page, null,
            Row("VideditBridge", "Edit video by asking Claude, ChatGPT or Gemini here, or from the Claude app."),
            Row("User guide", "Getting started, API keys, the Claude app, what you can ask.", Btn("Open", () => Docs.Open(this, Docs.Home), icon: Icons.Open, name: "Open the user guide")),
            Row("All tools", "Everything the AI can do in the editor, by topic.", Btn("Open", () => Docs.Open(this, Docs.Tools), icon: Icons.Open, name: "Open the tools list")),
            Row("Troubleshooting", "When a key, a connection or a render does not work.", Btn("Open", () => Docs.Open(this, Docs.Troubleshooting), icon: Icons.Open, name: "Open troubleshooting")),
            Row("Report a problem", "On GitHub, with what you did and what happened.", Btn("Open", () => Docs.Open(this, Docs.Issues), icon: Icons.Open, name: "Report a problem on GitHub")),
            Row("Settings file", _settings?["file"]?.GetValue<string>() ?? "", selectable: true));
    }

    // ---------------------------------------------------------------- search and pages

    private void ApplySearch()
    {
        var q = SearchBox.Text?.Trim() ?? "";
        var searching = q.Length > 0;
        var any = false;
        foreach (var page in _views)
        {
            var pageHit = false;
            foreach (var card in page.Cards)
            {
                var cardHit = false;
                foreach (var (row, text) in card.Rows)
                {
                    var hit = !searching || $"{page.Section.Title} {text}".Contains(q, StringComparison.OrdinalIgnoreCase);
                    row.IsVisible = hit;
                    cardHit |= hit;
                }
                card.Card.IsVisible = cardHit;
                if (card.Heading is not null) card.Heading.IsVisible = cardHit;
                pageHit |= cardHit;
            }
            page.Panel.IsVisible = searching ? pageHit : page.Section.Id == _page;
            // A page's intro reads oddly among search results.
            foreach (var intro in page.Panel.Children.OfType<TextBlock>().Where(t => t.Classes.Contains("intro"))) intro.IsVisible = !searching;
            any |= pageHit;
        }
        foreach (var (id, button) in _nav) button.Classes.Set("current", !searching && id == _page);
        NoMatch.IsVisible = searching && !any;
        NoMatch.Text = $"No settings match \"{q}\".";
    }

    // ---------------------------------------------------------------- changes

    private async Task Change(object changes)
    {
        if (_loading) return;
        try
        {
            await _vm.SetSettingsAsync(changes);
            _settings = await _vm.GetSettingsAsync();
        }
        catch (Exception e)
        {
            _vm.ShowError($"Could not change the setting: {e.Message}");
        }
        Build();
    }

    private async Task SetClient(string client, bool connected)
    {
        try
        {
            _connect = await _vm.CallHostAsync("connect.set", new { client, connected });
        }
        catch (Exception e)
        {
            _vm.ShowError(e.Message);
        }
        Build();
    }

    /// <summary>Connect clicked: show it starting, then wait for the host to have the public address.</summary>
    private bool _httpStarting;
    private bool _showAdvanced;

    private async Task StartPublic()
    {
        _httpStarting = true;
        Build();
        try
        {
            _connect = await _vm.CallHostAsync("connect.http", new { enabled = true, @public = true });
        }
        catch (Exception e)
        {
            _vm.ShowError($"Could not make the public address: {e.Message}");
        }
        _httpStarting = false;
        Build();
    }

    private Avalonia.Threading.DispatcherTimer? _poll;

    /// <summary>While the public address starts in the background (after the app started), ask again every two seconds.</summary>
    private void PollWhileStarting()
    {
        if (_poll is not null) return;
        _poll = new Avalonia.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _poll.Tick += async (_, _) =>
        {
            _poll?.Stop();
            _poll = null;
            try
            {
                _connect = await _vm.CallHostAsync("connect.get");
            }
            catch
            {
                return;
            }
            Build();
        };
        _poll.Start();
    }

    private async Task SetHttp(object changes)
    {
        if (_loading) return;
        try
        {
            _connect = await _vm.CallHostAsync("connect.http", changes);
        }
        catch (Exception e)
        {
            _vm.ShowError($"Could not change the connector address: {e.Message}");
        }
        Build();
    }

    private async Task RunTest()
    {
        _performanceNote = "Testing the renderers on this computer (about a minute)...";
        Build();
        try
        {
            _performanceNote = PerformanceText(await _vm.RunPerformanceTestAsync());
        }
        catch (Exception ex)
        {
            _performanceNote = $"The test failed: {ex.Message}";
        }
        Build();
    }

    private async Task OpenFolder(string path)
    {
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
