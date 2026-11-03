using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Media;

using VideoEditor.Engine;
using VideoEditor.Setup;
using VideoEditor.Shell;

namespace VideoEditor;

public partial class App : Application
{
    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
        // Segoe UI is Windows' own UI font and may not be shipped elsewhere; other systems get the bundled Inter (OFL).
        Resources["UiFont"] = OperatingSystem.IsWindows()
            ? new FontFamily("Segoe UI Variable Text, Segoe UI")
            : new FontFamily("fonts:Inter#Inter");
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            // The app ends with its main window: the performance test's window first, then the editor's.
            desktop.ShutdownMode = ShutdownMode.OnMainWindowClose;
            _ = StartAsync(desktop);
        }
        base.OnFrameworkInitializationCompleted();
    }

    /// <summary>
    /// Start the engine host; on the first start (no performance test result yet) run the test in
    /// its own window before the editor opens. If the host does not start, the editor opens anyway
    /// and shows why.
    /// </summary>
    private static async Task StartAsync(IClassicDesktopStyleApplicationLifetime desktop)
    {
        EngineClient? engine = null;
        PerformanceWindow? test = null;
        try
        {
            engine = await Task.Run(EngineClient.Start);
            if (await engine.CallAsync("performance.get") is null)
            {
                test = new PerformanceWindow(engine);
                desktop.MainWindow = test;
                test.Show();
                await test.Finished;
            }
        }
        catch (Exception e)
        {
            // The editor reports a host that cannot start; anything else goes to the log.
            Console.Error.WriteLine($"Startup: {e}");
        }
        var main = new MainWindow(desktop.Args ?? [], engine);
        desktop.MainWindow = main;
        main.Show();
        test?.Close();
    }
}
