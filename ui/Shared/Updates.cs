using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;

namespace VideoEditor.Shared;

/// <summary>A newer published release: its version (0.1.3) and its page on GitHub.</summary>
public sealed record UpdateInfo(string Version, string Url);

/// <summary>
/// Looks for a newer version of the app: one request to GitHub's public API for the latest published
/// release (drafts and pre-releases are not counted). Nothing about the user goes with it. Any failure
/// (offline, GitHub down, a rate limit) means no notice, never an error.
/// </summary>
public static class Updates
{
    private const string LatestRelease = "https://api.github.com/repos/dev-henen/videditbridge/releases/latest";

    /// <summary>The app's own version (Version in VideditBridge.csproj), as 0.1.2.</summary>
    public static string Current => typeof(Updates).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0.0.0";

    public static async Task<UpdateInfo?> CheckAsync(CancellationToken cancel = default)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("VideditBridge", Current));
            http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
            var json = JsonNode.Parse(await http.GetStringAsync(LatestRelease, cancel));
            var tag = json?["tag_name"]?.GetValue<string>();
            var url = json?["html_url"]?.GetValue<string>() ?? Docs.Releases;
            return tag is not null && IsNewer(tag, Current) ? new UpdateInfo(tag.TrimStart('v', 'V'), url) : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Whether a release tag (v0.1.3) is a newer version than the app's (0.1.2).</summary>
    public static bool IsNewer(string tag, string current) =>
        Version.TryParse(tag.TrimStart('v', 'V').Split('-')[0], out var latest) && Version.TryParse(current, out var mine) && latest > mine;
}
