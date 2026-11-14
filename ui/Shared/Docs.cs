using Avalonia;
using Avalonia.Controls;

namespace VideoEditor.Shared;

/// <summary>
/// The user guide on the web (GitHub Pages, built from site/ in the repository): its pages, and
/// opening one in the browser.
/// </summary>
public static class Docs
{
    public const string Site = "https://dev-henen.github.io/videditbridge/";
    public const string Issues = "https://github.com/dev-henen/videditbridge/issues";
    /// <summary>The app's source, by its developer, Moses Henen.</summary>
    public const string Repo = "https://github.com/dev-henen/videditbridge";
    public const string License = Repo + "/blob/main/LICENSE";

    public static string Home => Site;
    /// <summary>Getting an API key; `provider` jumps to Anthropic's, OpenAI's or Google's steps.</summary>
    public static string ApiKeys(string? provider = null) => Site + "api-keys.html" + (provider is null ? "" : "#" + provider);
    public static string ClaudeApp => Site + "claude-app.html";
    public static string Asking => Site + "asking.html";
    public static string Tools => Site + "tools.html";
    public static string Troubleshooting => Site + "troubleshooting.html";

    /// <summary>Open a page in the browser.</summary>
    public static async Task Open(Visual from, string url)
    {
        if (TopLevel.GetTopLevel(from)?.Launcher is { } launcher) await launcher.LaunchUriAsync(new Uri(url));
    }
}
