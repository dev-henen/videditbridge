using Avalonia;

namespace VideoEditor;

internal static class Program
{
    /// <summary>"VideoEditor &lt;project folder&gt;" opens that project directly.</summary>
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
